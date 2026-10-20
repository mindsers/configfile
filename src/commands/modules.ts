import { constants as osConstants } from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'

import type { Command } from 'commander'
import { describeWhen, isProfileName, type Machine, SYSTEMS } from '../conditions.ts'
import type { Context } from '../context.ts'
import { type CopiedFile, previewCopy } from '../copy.ts'
import {
  type BackupCheck,
  type DeployContext,
  type DeployDecision,
  type DeployResult,
  deployFile,
  Guard,
  type InspectedFile,
  inspectFile,
  isGlobalCopy,
  type KeptState,
  planDeploy,
  planUndeploy,
  type TargetState,
  type UndeployableFile,
  type UndeployDecision,
  type UndeployResult,
  undeployFile,
} from '../deploy.ts'
import { CliError, isPromptExit } from '../errors.ts'
import { messageOf } from '../fsutil.ts'
import { withCommandLock } from '../lock.ts'
import {
  changesUnder,
  type MirrorChange,
  type MirrorChanges,
  RepositoryView,
  readMirrorChanges,
} from '../mirror.ts'
import { escapeControls, plural } from '../output.ts'
import { configfilePaths } from '../paths.ts'
import { runScript } from '../process.ts'
import { findRemovedFiles, type HeldBack, type RecordedFile } from '../removed.ts'
import {
  HOOKS,
  type Hook,
  knownProfiles,
  loadRepository,
  loadScripts,
  type Module,
  type ModuleFile,
  platformOf,
  type Script,
  scriptEnvironment,
  systemName,
} from '../repository.ts'
import { DeploymentRecord } from '../state.ts'
import { registerAdoptCommand } from './adopt.ts'

type Strategy = ModuleFile['strategy']
type UsableModule = Extract<Module, { error: null }>

/** Command-line options, as commander gives them. */
interface RawOptions {
  local?: boolean
  all?: boolean
  force?: boolean
  dryRun?: boolean
  removed?: boolean
  hooks?: boolean
  keepGoing?: boolean
  os?: string
  profile?: string[]
}

/** Options once normalized at the command boundary. */
interface Options {
  strategy: Strategy
  all: boolean
  force: boolean
  dryRun: boolean
  /** Undeploy: the files the repository no longer deploys. */
  removed: boolean
  /** Run the scripts the modules name (`pre_deploy`, `post_undeploy`…). */
  hooks: boolean
  /** Go on with the modules that come after a script that failed. */
  keepGoing: boolean
  /** The machine to check `"when"` against instead of this one (`--os`, `--profile`). */
  preview: Partial<Machine>
}

function normalize(options: RawOptions): Options {
  if (options.os != null && !(SYSTEMS as readonly string[]).includes(options.os)) {
    throw new CliError(`--os must be ${SYSTEMS.join(' or ')}, not "${options.os}".`)
  }
  const invalid = (options.profile ?? []).filter(name => !isProfileName(name))
  if (invalid.length > 0) {
    throw new CliError(
      `"${invalid[0]}" is not a profile name: use letters, digits, ".", "_" and "-".`,
    )
  }
  return {
    preview: {
      ...(options.os != null && { os: options.os }),
      ...(options.profile != null && { profiles: [...new Set(options.profile)] }),
    },
    strategy: options.local === true ? 'local' : 'global',
    all: options.all === true,
    force: options.force === true,
    dryRun: options.dryRun === true,
    removed: options.removed === true,
    hooks: options.hooks !== false,
    keepGoing: options.keepGoing === true,
  }
}

export function registerModulesCommand(program: Command, ctx: Context): void {
  const modules = program
    .command('modules')
    .alias('m')
    .description('work with the modules of your dotfiles repository')

  modules
    .command('list', { isDefault: true })
    .alias('l')
    .description('list available modules')
    .action(() => list(ctx))

  modules
    .command('status')
    .alias('st')
    .argument('[modules...]', 'modules to check (all when omitted)')
    .description('show whether the files of the modules are deployed')
    .option('-l, --local', 'check the local files of the modules, in the current folder')
    .option('--os <system>', 'check as if this machine ran this system (macos or linux)')
    .option(
      '--profile <name>',
      'check as if this machine had this profile instead of its own (repeatable)',
      collect,
    )
    .action((names: string[], options: RawOptions) => status(names, normalize(options), ctx))

  modules
    .command('deploy')
    .alias('d')
    .argument('[modules...]', 'modules to deploy (use --all, or answer a question, when omitted)')
    .description('deploy the files of one or more modules')
    .option(
      '-l, --local',
      'copy the local files of the modules into the current folder, instead of the global files',
    )
    .option('-a, --all', 'deploy every module without asking')
    .option(
      '-f, --force',
      'replace existing local files, and copies changed on this machine, without asking (they are moved to .old)',
    )
    .option('-n, --dry-run', 'show what would be done, without changing anything')
    .option('--os <system>', 'with --dry-run: as if this machine ran this system (macos or linux)')
    .option(
      '--profile <name>',
      'with --dry-run: as if this machine had this profile instead of its own (repeatable)',
      collect,
    )
    .option('--no-hooks', 'do not run the pre_deploy and post_deploy scripts of the modules')
    .option(
      '--keep-going',
      'deploy the remaining modules when a pre_deploy or post_deploy script fails',
    )
    .action((names: string[], options: RawOptions) => deploy(names, normalize(options), ctx))

  modules
    .command('undeploy')
    .alias('u')
    .argument('[modules...]', 'modules to undeploy (use --all, or answer a question, when omitted)')
    .description('remove the deployed files of one or more modules and restore their backups')
    .option('-l, --local', 'remove the local copies of the modules instead of the global files')
    .option(
      '-a, --all',
      'undeploy every module without asking, and the files the repository no longer deploys',
    )
    .option('--removed', 'only undeploy the files the repository no longer deploys')
    .option('-n, --dry-run', 'show what would be done, without changing anything')
    .option('--no-hooks', 'do not run the pre_undeploy and post_undeploy scripts of the modules')
    .option(
      '--keep-going',
      'undeploy the remaining modules when a pre_undeploy or post_undeploy script fails',
    )
    .action((names: string[], options: RawOptions) => undeploy(names, normalize(options), ctx))

  registerAdoptCommand(modules, ctx)
}

/** Collects a repeatable option. */
function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value]
}

async function loadModules(ctx: Context): Promise<Module[]> {
  return (await loadRepository(ctx)).modules
}

type Repository = Awaited<ReturnType<typeof loadRepository>>

/**
 * Files the repository no longer deploys, for `strategy`: local copies only
 * when made in the current folder, like the other local commands.
 */
function removedFiles(
  record: DeploymentRecord,
  { repository, modules }: Repository,
  strategy: Strategy,
  ctx: Context,
): Promise<{ removed: RecordedFile[]; heldBack: HeldBack[] }> {
  return findRemovedFiles(record, modules, {
    repository,
    home: ctx.home,
    strategy,
    ...(strategy === 'local' && { folder: ctx.cwd }),
  })
}

/** The command that undeploys them, with `--local` when needed. */
function undeployRemovedCommand(strategy: Strategy): string {
  return `configfile modules undeploy --removed${strategy === 'local' ? ' --local' : ''}`
}

async function list(ctx: Context): Promise<void> {
  const modules = await loadModules(ctx)

  if (modules.length === 0) {
    ctx.output.info('No module found.')
    return
  }

  ctx.output.print(`${plural(modules.length, 'module')} found.`)
  for (const module of modules) {
    ctx.output.print(`- ${module.name}${describeListed(module)}`)
  }
  for (const module of modules) reportSettings(module, ctx)
}

/**
 * What `modules list` adds to a module's name: why it is ignored, or the
 * machines it is for and the scripts it names.
 */
function describeListed(module: Module): string {
  if (module.error != null) return ` (ignored: ${module.error})`
  const parts: string[] = []
  if (module.when != null) {
    const away = module.notHere == null ? '' : ', not this machine'
    parts.push(`for ${describeWhen(module.when)}${away}`)
  }
  const hooks = HOOKS.filter(hook => module.hooks[hook] != null)
  if (hooks.length > 0) parts.push(hooks.join(', '))
  return parts.length === 0 ? '' : ` (${parts.join('; ')})`
}

async function status(names: string[], options: Options, given: Context): Promise<void> {
  const ctx = previewing(given, options)
  const { output } = ctx
  const repo = await loadRepository(ctx, options.preview)
  const selected = names.length === 0 ? repo.modules : pickModules(repo.modules, names)
  reportMachine(repo, options, ctx)

  // Read only: status never changes files or the record.
  const record = await DeploymentRecord.load(ctx.home)
  const { removed, heldBack } =
    names.length === 0
      ? await removedFiles(record, repo, options.strategy, ctx)
      : { removed: [], heldBack: [] }

  if (selected.length === 0 && removed.length === 0 && heldBack.length === 0) {
    output.info('No module found.')
    return
  }

  // Scripts named by the modules are checked too: a wrong name would stop a deployment.
  let scripts: Scripts | null = null
  if (
    selected.some(module => module.error == null && HOOKS.some(hook => module.hooks[hook] != null))
  ) {
    try {
      scripts = await loadScripts(ctx)
    } catch (error) {
      // Status still shows the files when the scripts cannot be listed.
      if (!(error instanceof CliError)) throw error
      output.warn(`The scripts the modules name cannot be checked: ${messageOf(error)}`)
    }
  }

  const view = new RepositoryView(repo.repository)
  let unchecked = 0
  const inspectTarget = async (file: InspectedFile) => {
    try {
      return await inspectFile(file, record, view)
    } catch (error) {
      unchecked++
      if (!(error instanceof CliError) && process.env.DEBUG != null) {
        output.stderr.write(`${(error as Error).stack}\n`)
      }
      return `cannot be checked: ${messageOf(error)}`
    }
  }
  const describeTarget = async (file: InspectedFile) => {
    const state = await inspectTarget(file)
    return typeof state === 'string' ? state : describeState(state, file)
  }
  let changedHere = false
  /** The files of a copied folder that differ, under its line. */
  const printCopiedFiles = (state: TargetState | string) => {
    if (typeof state === 'string' || state.kind !== 'copied') return
    if (state.changed.length + state.conflicts.length > 0) changedHere = true
    const inside = [
      ...state.outdated.map(file => [file, 'the repository has a newer version'] as const),
      ...state.deleted.map(file => [file, 'the repository no longer has it'] as const),
      ...state.changed.map(file => [file, 'changed on this machine'] as const),
      ...state.conflicts.map(file => [file, 'changed here and in the repository'] as const),
    ]
      .filter(([file]) => file !== '')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [file, what] of inside) output.print(`    ${file} (${what})`)
  }

  // Tools write into the mirror through global links: read once, when a link is there.
  let mirror: Promise<MirrorChanges> | null = null
  let changedThroughLinks = false
  let linkChecksUnavailable: string | null = null
  const printChangesThroughLink = async (file: ModuleFile, state: TargetState | string) => {
    const linked =
      typeof state !== 'string' &&
      (state.kind === 'deployed' ||
        state.kind === 'linked' ||
        (state.kind === 'source-missing' && state.ours && !isGlobalCopy(file)))
    if (file.strategy !== 'global' || !linked) return

    mirror ??= readMirrorChanges(repo.repository)
    const changes = await mirror
    if (changes.status === 'unavailable') linkChecksUnavailable = changes.reason
    if (changes.status !== 'read') return

    const source = path.relative(repo.repository, file.source)
    for (const change of changesUnder(changes.changes, source)) {
      changedThroughLinks = true
      const relative = path.posix.relative(source.split(path.sep).join('/'), change.path)
      // An untracked folder: shown with its `/`, or as the source itself when it contains it.
      const inside = relative.startsWith('..')
        ? ''
        : `${relative}${change.path.endsWith('/') && relative !== '' ? '/' : ''}`
      const what = describeChange(change)
      output.print(inside === '' ? `    ${what}` : `    ${inside} (${what})`)
    }
  }

  // Modules for other machines: one line for all, unless they are named.
  const away: string[] = []
  for (const module of selected) {
    if (module.error == null && module.notHere != null && names.length === 0) {
      away.push(module.name)
      continue
    }
    output.print(`${module.name}:`)

    if (module.error != null) {
      output.print(`  ignored: ${module.error}`)
      continue
    }
    if (module.notHere != null) {
      output.print(`  not for this machine (${module.notHere})`)
      continue
    }
    reportSettings(module, ctx)

    const files = module.files.filter(file => file.strategy === options.strategy)
    for (const file of files) {
      const state = await inspectTarget(file)
      output.print(
        `  ${file.target} (${typeof state === 'string' ? state : describeState(state, file)})`,
      )
      printCopiedFiles(state)
      await printChangesThroughLink(file, state)
    }
    const elsewhere = module.elsewhere.filter(({ file }) => file.strategy === options.strategy)
    for (const { file, reason } of elsewhere) {
      output.print(`  ${file.target} (not for this machine: ${reason})`)
    }
    for (const source of module.undecided) {
      output.print(`  ${source} (no deployment strategy)`)
    }
    if (files.length === 0 && elsewhere.length === 0 && module.undecided.length === 0) {
      output.print(`  no ${options.strategy} file`)
    }
    for (const hook of HOOKS) {
      if (module.hooks[hook] == null) continue
      const found = scripts == null ? null : findHook(module, hook, scripts)
      const note =
        found === 'missing'
          ? ' (not found in scripts/)'
          : found === 'other-system'
            ? ' (no version for this system)'
            : ''
      output.print(`  ${hook}: script "${module.hooks[hook]}"${note}`)
    }
  }

  if (away.length > 0) {
    output.print(
      `Not for this machine: ${away.join(', ')} ("configfile modules status <module>" says why).`,
    )
  }
  const gone = removed.filter(file => file.notHere == null)
  if (gone.length > 0) {
    output.print(
      `No longer deployed by the repository (run "${undeployRemovedCommand(options.strategy)}"):`,
    )
    for (const file of gone) {
      output.print(`  ${file.target} (${await describeTarget(file)})`)
    }
  }
  const notHere = removed.filter(file => file.notHere != null)
  if (notHere.length > 0) {
    output.print(
      `No longer for this machine (unless "profiles" in ${configfilePaths(ctx.home).rc} is ` +
        `wrong, run "${undeployRemovedCommand(options.strategy)}"):`,
    )
    for (const file of notHere) {
      output.print(`  ${file.target} (${file.notHere}; ${await describeTarget(file)})`)
    }
  }
  if (heldBack.length > 0) {
    output.print('Deployed, but configfile cannot tell whether the repository still deploys them:')
    for (const { target, reason } of heldBack) {
      output.print(`  ${target} (${reason})`)
    }
  }

  if (changedHere) {
    output.info(
      'Files changed on this machine are kept, and are not in the repository: to have a change ' +
        'on every machine, make it in your working copy, then commit and push. ' +
        '"diff -u <file in the repository> <file>" shows it.',
    )
  }
  if (changedThroughLinks) {
    output.info(
      'Changes made through links are not in the repository: the next "configfile update" ' +
        "saves them in a patch, then puts the repository's version back and removes new files " +
        "(except those the repository's .gitignore lists). To keep them, make them in your " +
        `working copy, then commit and push. "git -C ${repo.repository} diff" shows the changes to its files.`,
    )
  }
  if (linkChecksUnavailable != null) {
    output.warn(`Changes made through links cannot be checked: ${linkChecksUnavailable}`)
  }
  if (unchecked > 0) {
    throw new CliError(`${plural(unchecked, 'file')} could not be checked: see why above.`)
  }
}

/** The context of a run that previews another system: scripts are picked for it. */
function previewing(ctx: Context, { preview }: Pick<Options, 'preview'>): Context {
  return preview.os == null ? ctx : { ...ctx, platform: platformOf(preview.os) }
}

/**
 * Says which machine a preview checks, and warns about profiles no module
 * names: a typo there would skip files without a word.
 */
function reportMachine(
  { modules, machine }: Pick<Repository, 'modules' | 'machine'>,
  options: Pick<Options, 'preview'>,
  ctx: Context,
): void {
  const { preview } = options
  if (preview.os != null || preview.profiles != null) {
    const profiles =
      machine.profiles.length === 0
        ? 'no profile'
        : `${machine.profiles.length === 1 ? 'profile' : 'profiles'} ${machine.profiles.map(name => `"${name}"`).join(', ')}`
    ctx.output.info(`As a machine running ${machine.os}, with ${profiles}:`)
  }
  const known = knownProfiles(modules)
  for (const name of machine.profiles.filter(profile => !known.includes(profile))) {
    const where = preview.profiles == null ? ` (in ${configfilePaths(ctx.home).rc})` : ''
    ctx.output.warn(
      `No module is for profile "${name}"${where}: ` +
        (known.length === 0
          ? 'the repository uses no profiles.'
          : `the repository uses ${known.map(profile => `"${profile}"`).join(', ')}.`),
    )
  }
}

/** What happened to a file of a linked source, seen from the mirror. */
function describeChange(change: MirrorChange): string {
  switch (change.kind) {
    case 'modified':
      return 'changed through the link'
    case 'deleted':
      return 'deleted through the link'
    case 'new':
      return 'new, not in the repository'
  }
}

type Verb = 'deploy' | 'undeploy'
type Unit = { module: UsableModule; files: ModuleFile[] }
type Scripts = Awaited<ReturnType<typeof loadScripts>>

/** The files of each module a command works on; modules without any are left out. */
function unitsOf(modules: readonly UsableModule[], strategy: Strategy): Unit[] {
  return modules
    .map(module => ({ module, files: module.files.filter(file => file.strategy === strategy) }))
    .filter(unit => unit.files.length > 0)
}

/** The settings that name the scripts a command runs, in the order they run. */
function hooksOf(verb: Verb): readonly [Hook, Hook] {
  return [`pre_${verb}`, `post_${verb}`]
}

/**
 * The scripts of the repository, when `--no-hooks` is not given and the
 * modules to work on name some to run; `null` otherwise.
 *
 * A name that matches no script is a mistake in the repository, found here
 * before anything is changed: the command fails, unless `--keep-going` is
 * given (the script then fails when its turn comes). A script that only has
 * versions for other systems is not a mistake: it is skipped in its turn.
 *
 * `named`: the modules were named on the command line. A named module whose
 * script will not run, because it has no file of the kind the command works
 * on, is said so; with every module selected, that is the usual case.
 */
async function loadHookScripts(
  verb: Verb,
  { modules, named: explicit }: { modules: readonly UsableModule[]; named: boolean },
  units: readonly Unit[],
  options: Options,
  ctx: Context,
): Promise<Scripts | null> {
  if (!options.hooks) return null

  for (const module of explicit ? modules : []) {
    if (units.some(unit => unit.module === module)) continue
    for (const hook of hooksOf(verb)) {
      if (module.hooks[hook] == null) continue
      ctx.output.warn(
        `${module.name}: ${describeHook(module, hook)} ${options.dryRun ? 'would not run' : 'was not run'}, ` +
          `the module has no ${options.strategy} file.`,
      )
    }
  }

  const named = units.flatMap(({ module }) =>
    hooksOf(verb).flatMap(hook => (module.hooks[hook] == null ? [] : [{ module, hook }])),
  )
  if (named.length === 0) return null

  let scripts: Scripts
  try {
    scripts = await loadScripts(ctx)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    const message = messageOf(error)
    throw new CliError(
      `${message}${/[.!?]$/.test(message) ? '' : '.'} ` +
        `Use --no-hooks to ${verb} without running the scripts the modules name.`,
      { cause: error },
    )
  }
  if (options.keepGoing) return scripts

  const missing = named.filter(({ module, hook }) => findHook(module, hook, scripts) === 'missing')
  if (missing.length === 0) return scripts
  for (const { module, hook } of missing) reportHookError(module, hookNotFound(module, hook), ctx)
  throw new CliError(
    `Nothing ${options.dryRun ? 'would be' : 'was'} ${verb}ed: ` +
      `${plural(missing.length, 'script')} the modules name ${missing.length === 1 ? 'does' : 'do'} not exist.`,
  )
}

async function deploy(names: string[], options: Options, given: Context): Promise<void> {
  // Scripts too are picked for the system previewed: only allowed in a dry run (below).
  const ctx = options.dryRun ? previewing(given, options) : given
  const { output, prompts } = ctx
  if (!options.dryRun && (options.preview.os != null || options.preview.profiles != null)) {
    throw new CliError(
      '--os and --profile only preview another machine: add --dry-run. To change this ' +
        `machine's profiles, edit "profiles" in ${configfilePaths(ctx.home).rc}.`,
    )
  }
  const repo = await loadRepository(ctx, options.preview)
  reportMachine(repo, options, ctx)
  const run = await prepare('deploy', repo, names, options, ctx)
  if (run == null) return

  const units = unitsOf(run.modules, options.strategy)
  const scripts = await loadHookScripts(
    'deploy',
    { modules: run.modules, named: !run.all },
    units,
    options,
    ctx,
  )
  if (units.length === 0) return
  let failures = run.failures

  if (options.dryRun) {
    const context = await deployContext(ctx, repo.repository)
    const failed = new FailedHooks('deploy')
    let wouldSkip = 0
    let wouldSkipLinks = 0
    let wouldSkipCopies = 0
    let wouldLeave = 0
    for (const { module, files } of units) {
      // Without its pre_deploy script, the files of a module would not be deployed.
      if (!planHook(module, 'pre_deploy', scripts, ctx)) {
        failed.add('pre_deploy', module)
        continue
      }

      let complete = module.invalidEntries.length === 0
      for (const file of files) {
        try {
          const decision = await planDeploy(file, { ...context, force: options.force })
          if (decision.action === 'conflict' && !prompts.interactive) {
            if (decision.replacedLink) wouldSkipLinks++
            else if (decision.paths == null) wouldSkip++
            else wouldSkipCopies++
            complete = false
          }
          // Files a copy could not update, whatever the answer.
          const plan =
            decision.action === 'update' || decision.action === 'conflict'
              ? decision.plan
              : undefined
          const replace = decision.action === 'update' ? decision.replace : 'none'
          if (
            plan != null &&
            previewCopy(file, plan, replace).some(copied => copied.reason != null)
          ) {
            wouldLeave++
            complete = false
          }
          output.print(
            `- ${file.target} (${describePlannedDeploy(file, decision, prompts.interactive)})`,
          )
        } catch (error) {
          failures++
          complete = false
          reportFileError(file, error, ctx)
        }
      }
      for (const { file, reason } of module.elsewhere) {
        if (file.strategy === options.strategy) {
          output.print(`- ${file.target} (not for this machine: ${reason})`)
        }
      }
      if (!planHook(module, 'post_deploy', scripts, ctx, { complete })) {
        failed.add('post_deploy', module)
      }
    }
    const problems = [
      ...skippedProblems(wouldSkip, prompts.interactive),
      ...skippedLinkProblems(wouldSkipLinks, prompts.interactive),
      ...skippedCopyProblems(wouldSkipCopies, prompts.interactive),
      ...unresolvedCopyProblems(wouldLeave),
      ...failed.problems(true),
    ]
    finish(failures, problems, 'Dry run finished.', ctx)
    return
  }

  let skipped = 0
  let skippedLinks = 0
  let skippedCopies = 0
  let unresolvedCopies = 0
  const outcome = await eachModule('deploy', units, scripts, options, ctx, async unit => {
    const result = await withCommandLock(ctx, async () =>
      deployFiles(unit.files, options, await deployContext(ctx, repo.repository), ctx),
    )
    failures += result.failures
    skipped += result.skipped
    skippedLinks += result.skippedLinks
    skippedCopies += result.skippedCopies
    unresolvedCopies += result.unresolvedCopies
    return (
      result.failures === 0 &&
      result.skipped === 0 &&
      result.skippedLinks === 0 &&
      result.skippedCopies === 0 &&
      result.unresolvedCopies === 0 &&
      unit.module.invalidEntries.length === 0
    )
  })

  const problems = [
    ...skippedProblems(skipped, prompts.interactive),
    ...skippedLinkProblems(skippedLinks, prompts.interactive),
    ...skippedCopyProblems(skippedCopies, prompts.interactive),
    ...unresolvedCopyProblems(unresolvedCopies),
    ...outcome.problems,
  ]
  finish(failures, problems, 'Deployment finished.', ctx, outcome.exitCode)
}

/** Deploys the files of a module while the lock is held. */
async function deployFiles(
  files: ModuleFile[],
  options: Options,
  context: DeployContext,
  ctx: Context,
): Promise<DeployCounts> {
  const { output, prompts } = ctx
  const counts: DeployCounts = {
    failures: 0,
    skipped: 0,
    skippedLinks: 0,
    skippedCopies: 0,
    unresolvedCopies: 0,
  }
  const reportError = (file: { target: string }, error: unknown) => {
    counts.failures++
    reportFileError(file, error, ctx)
  }

  /** Prints and records a result; counts what a copy could not do. */
  const report = (file: ModuleFile, result: Exclude<DeployResult, { status: 'conflict' }>) => {
    output.print(`- ${file.target} ${describeDeploy(file, result)}`)
    recordDeploy(file, result, ctx)
    if (result.status !== 'updated') return
    const { files: copied } = result.outcome
    for (const failed of copied.filter(item => item.result === 'failed')) {
      counts.failures++
      const target =
        failed.path === '' ? file.target : path.join(file.target, ...failed.path.split('/'))
      ctx.output.error(`${target}: ${failed.reason ?? 'failed'}`)
    }
    if (copied.some(item => item.result === 'conflict' && item.reason != null)) {
      counts.unresolvedCopies++
    }
  }

  const conflicts: { file: ModuleFile; paths: readonly string[] | null; replacedLink: boolean }[] =
    []
  for (const file of files) {
    try {
      const result = await deployFile(file, { ...context, force: options.force })
      if (result.status === 'conflict') {
        conflicts.push({
          file,
          paths: result.paths ?? null,
          replacedLink: result.replacedLink === true,
        })
      } else report(file, result)
    } catch (error) {
      reportError(file, error)
    }
  }

  // Asked once the other files of the module are deployed, so an answer never blocks them.
  for (const { file, paths, replacedLink } of conflicts) {
    const one = paths?.length === 1
    const message = replacedLink
      ? `${file.target} replaced configfile's link. Replace it with the link (yours is moved to .old)?`
      : paths == null
        ? `${file.target} already exists. Replace it (the current one is moved to .old)?`
        : `${conflictSubject(file, paths)} changed here and in the repository. Replace ` +
          `${one ? 'it' : 'them'} with the repository's version (yours ${one ? 'is' : 'are'} ` +
          'moved to .old)?'
    const replace =
      prompts.interactive &&
      (await prompts.confirm({ message: escapeControls(message), default: false }))

    if (paths == null && !replace) {
      if (replacedLink) counts.skippedLinks++
      else counts.skipped++
      output.print(
        `- ${file.target} (${replacedLink ? 'a file replaced the link, kept' : 'already exists, skipped'})`,
      )
      ctx.history.record({ kind: 'skipped', target: file.target, reason: 'exists' })
      continue
    }
    try {
      // A copy follows the repository for the rest either way.
      const choice =
        paths == null
          ? { force: true }
          : { copies: replace ? ('conflicts' as const) : ('skip' as const) }
      const result = await deployFile(file, { ...context, ...choice })
      if (result.status === 'conflict') {
        throw new CliError('the target changed while configfile was deploying it. Try again.')
      }
      report(file, result)
      if (paths != null && !replace) counts.skippedCopies++
    } catch (error) {
      reportError(file, error)
    }
  }

  return counts
}

/** What a deployment of a module's files could not do. */
interface DeployCounts {
  failures: number
  /** Local files that already existed, left as they are. */
  skipped: number
  /** Files that replaced configfile's links, left as they are. */
  skippedLinks: number
  /** Copies whose files changed on both sides were left as they are, as asked (or without a terminal). */
  skippedCopies: number
  /** Copies with files configfile could not update (behind a link, written meanwhile…). */
  unresolvedCopies: number
}

/** The copied file, or the files of a copied folder, changed on both sides. */
function conflictSubject(file: ModuleFile, paths: readonly string[]): string {
  if (paths.length === 1 && paths[0] === '') return file.target
  return `In ${file.target}, ${describePaths(paths)}`
}

/**
 * Deploys or undeploys modules one at a time: the `pre_` script of a module,
 * its files (`work`, which takes the lock), its `post_` script, then the next
 * module. Scripts run without the lock, as they may run configfile themselves.
 *
 * - A `pre_` script that fails leaves the files of its module untouched.
 * - `work` returns whether every file of the module was handled: the `post_`
 *   script is not run otherwise. When it fails as a whole (the lock or the
 *   record cannot be used), the run ends there.
 * - A script that fails ends the run, unless `--keep-going` is given. A signal
 *   received while a script runs always ends it, with the signal's exit code.
 *
 * Returns the problems to report, whether the run ended early, and the exit
 * code to use when a signal ended it.
 */
async function eachModule(
  verb: Verb,
  units: readonly Unit[],
  scripts: Scripts | null,
  options: Options,
  ctx: Context,
  work: (unit: Unit) => Promise<boolean>,
): Promise<{ problems: string[]; stopped: boolean; exitCode?: number }> {
  const [pre, post] = hooksOf(verb)
  const failed = new FailedHooks(verb)
  /**
   * Something was attempted already: a script was due to run (even one that
   * is missing or could not be started), or the files of a module were handled.
   */
  let started = false
  /** The modules whose files were left untouched, and why. */
  const leftOut: { name: string; reason: string }[] = []
  let recorded = 0
  let hint = ''
  let exitCode: number | undefined
  const leaveOut = (from: number, to: number, reason: string) => {
    for (const { module } of units.slice(from, to)) leftOut.push({ name: module.name, reason })
  }
  /** Writes them to the history: called on every way out, each module once. */
  const recordLeftOut = () => {
    for (const { name, reason } of leftOut.slice(recorded)) {
      ctx.history.record({ kind: 'failed', module: name, reason: `not ${verb}ed: ${reason}` })
    }
    recorded = leftOut.length
  }

  /** Runs a script of the module at `index`. `stop`: the run ends there. */
  const runStep = async (hook: Hook, index: number): Promise<'ok' | 'failed' | 'stop'> => {
    const { module } = units[index] as Unit
    if (scripts == null || module.hooks[hook] == null) return 'ok'

    started = true
    const result = await runHook(module, hook, scripts, options.strategy, ctx)
    if (!result.ok) failed.add(hook, module)
    // Before its files, the module itself is left out too.
    const next = hook === pre ? index : index + 1

    if (result.signal != null) {
      // configfile was asked to stop while the script ran: --keep-going does not apply.
      const reason = `interrupted (${result.signal}) during the ${hook} script of ${module.name}`
      leaveOut(next, units.length, reason)
      exitCode = 128 + (osConstants.signals[result.signal] ?? 0)
      return 'stop'
    }
    if (result.ok) return 'ok'

    const reason = `the ${hook} script of ${module.name} failed`
    if (options.keepGoing) {
      leaveOut(next, index + 1, reason)
      return 'failed'
    }
    leaveOut(next, units.length, reason)
    hint = ' Use --keep-going to go on after a script that fails.'
    return 'stop'
  }

  let stopped = false
  for (const [index, unit] of units.entries()) {
    const before = await runStep(pre, index)
    if (before === 'failed') continue
    stopped = before === 'stop'
    if (stopped) break

    let complete: boolean
    try {
      complete = await work(unit)
    } catch (error) {
      // A question cancelled with Ctrl+C ends the command as usual: only the
      // history says what was left out (the files of this module may be done).
      if (isPromptExit(error)) leaveOut(index + 1, units.length, 'cancelled')
      // The lock is taken again for each module: when it (or the record) can
      // no longer be, say what was left out. Before anything was done, the
      // error says it all.
      if (!(error instanceof CliError) || !started) {
        recordLeftOut()
        throw error
      }
      ctx.output.error(messageOf(error))
      leaveOut(index, units.length, messageOf(error))
      stopped = true
      break
    }
    started = true

    if (!complete && scripts != null && unit.module.hooks[post] != null) {
      const reason = hookNeedsFiles(verb)
      ctx.output.warn(
        `${unit.module.name}: ${describeHook(unit.module, post)} was not run, ${reason}.`,
      )
      recordSkippedHook(unit.module, post, reason, ctx)
      continue
    }
    stopped = complete && (await runStep(post, index)) === 'stop'
    if (stopped) break
  }

  const problems = failed.problems(false)
  if (exitCode != null) problems.push('Interrupted.')
  recordLeftOut()
  if (leftOut.length > 0) {
    problems.push(
      `${plural(leftOut.length, 'module')} ${leftOut.length === 1 ? 'was' : 'were'} ` +
        `not ${verb}ed: ${leftOut.map(({ name }) => name).join(', ')}.${hint}`,
    )
  }
  return { problems, stopped, ...(exitCode != null && { exitCode }) }
}

/** The modules whose scripts failed, for the summary of a run or of a dry run. */
class FailedHooks {
  readonly #modules = new Map<Hook, string[]>()

  constructor(verb: Verb) {
    for (const hook of hooksOf(verb)) this.#modules.set(hook, [])
  }

  add(hook: Hook, module: UsableModule): void {
    this.#modules.get(hook)?.push(module.name)
  }

  problems(dryRun: boolean): string[] {
    return [...this.#modules]
      .filter(([, modules]) => modules.length > 0)
      .map(
        ([hook, modules]) =>
          `The ${hook} script of ${modules.join(', ')} ${dryRun ? 'would fail' : 'failed'}.`,
      )
  }
}

/** A `post_` script only runs once every file of its module is handled. */
function hookNeedsFiles(verb: Verb): string {
  return verb === 'deploy'
    ? 'some files of the module are not deployed'
    : 'some files of the module could not be undeployed'
}

function describeHook(module: UsableModule, hook: Hook): string {
  return `${hook} script "${module.hooks[hook]}"`
}

/**
 * The script a setting of the module names. `other-system`: it only has
 * versions for other systems, so there is nothing to run on this one.
 */
function findHook(
  module: UsableModule,
  hook: Hook,
  { scripts, otherSystems }: Scripts,
): Script | 'other-system' | 'missing' {
  const name = module.hooks[hook]
  const script = scripts.find(candidate => candidate.name === name)
  if (script != null) return script
  return name != null && otherSystems.includes(name) ? 'other-system' : 'missing'
}

/** A script that is not run on purpose: said in the history, without failing the run. */
function recordSkippedHook(module: UsableModule, hook: Hook, reason: string, ctx: Context): void {
  ctx.history.record({
    kind: 'script-skipped',
    name: module.hooks[hook] ?? '',
    hook,
    module: module.name,
    reason,
  })
}

function noVersionFor(ctx: Context): string {
  return `no version for ${systemName(ctx.platform)}`
}

function hookNotFound(module: UsableModule, hook: Hook): string {
  return (
    `${describeHook(module, hook)} not found. ` +
    'Run "configfile scripts list" to see available scripts.'
  )
}

function reportHookError(module: UsableModule, reason: string, ctx: Context): void {
  ctx.output.error(`${module.name}: ${reason}`)
  ctx.history.record({ kind: 'failed', module: module.name, reason })
}

/**
 * Dry runs: says whether a script of the module would run. Returns `false`
 * when the script does not exist, which only happens with `--keep-going`:
 * without it, `loadHookScripts` has already failed the command.
 * `complete: false`: some files of the module would not be handled, so its
 * `post_` script would not run.
 */
function planHook(
  module: UsableModule,
  hook: Hook,
  scripts: Scripts | null,
  ctx: Context,
  { complete = true }: { complete?: boolean } = {},
): boolean {
  if (scripts == null || module.hooks[hook] == null) return true

  const describe = (plan: string) =>
    `- script "${module.hooks[hook]}" (${hook} of ${module.name}: ${plan})`
  if (!complete) {
    const verb = hook.endsWith('_undeploy') ? 'undeploy' : 'deploy'
    ctx.output.print(describe(`would not run, ${hookNeedsFiles(verb)}`))
    return true
  }
  const script = findHook(module, hook, scripts)
  if (script === 'missing') {
    reportHookError(module, hookNotFound(module, hook), ctx)
    return false
  }
  ctx.output.print(
    describe(script === 'other-system' ? `would be skipped, ${noVersionFor(ctx)}` : 'would run'),
  )
  return true
}

/**
 * Runs a script a module names (`pre_deploy`, `post_undeploy`…) the way
 * `scripts run` runs it, with the hook, the module's name and the kind of
 * files added to its environment. Unlike `scripts run`, configfile's messages
 * stay on stdout and the exit code of the script is not the command's.
 *
 * Returns whether it succeeded, and the signal configfile received while it
 * ran, if any (Ctrl+C, SIGTERM…): the script is left to end, then the run
 * must stop. A script that only has versions for other systems is skipped,
 * which is a success.
 */
async function runHook(
  module: UsableModule,
  hook: Hook,
  scripts: Scripts,
  strategy: Strategy,
  ctx: Context,
): Promise<{ ok: boolean; signal?: NodeJS.Signals }> {
  const script = findHook(module, hook, scripts)
  if (script === 'missing') {
    reportHookError(module, hookNotFound(module, hook), ctx)
    return { ok: false }
  }
  if (script === 'other-system') {
    const reason = noVersionFor(ctx)
    ctx.output.info(`${module.name}: ${describeHook(module, hook)} has ${reason}, skipped.`)
    recordSkippedHook(module, hook, reason, ctx)
    return { ok: true }
  }

  ctx.output.info(`Running "${script.name}", the ${hook} script of ${module.name}…`)
  let code: number
  let signal: NodeJS.Signals | undefined
  try {
    code = await runScript(script, [], {
      cwd: ctx.cwd,
      onSignal: received => {
        signal ??= received
      },
      env: {
        ...scriptEnvironment(script, scripts.repository, ctx.platform, scripts.profiles),
        CONFIGFILE_HOOK: hook,
        CONFIGFILE_MODULE: module.name,
        CONFIGFILE_DEPLOY: strategy,
      },
    })
  } catch (error) {
    reportHookError(module, messageOf(error), ctx)
    return { ok: false }
  }

  ctx.history.record({
    kind: 'script',
    name: script.name,
    file: script.path,
    exitCode: code,
    hook,
    module: module.name,
  })
  if (code !== 0) {
    ctx.output.error(`${module.name}: ${describeHook(module, hook)} exited with code ${code}.`)
  }
  return { ok: code === 0, ...(signal != null && { signal }) }
}

async function undeploy(names: string[], options: Options, ctx: Context): Promise<void> {
  const { output } = ctx
  if (options.removed && names.length > 0) {
    throw new CliError('Give module names or --removed, not both.')
  }
  if (options.removed && options.all) {
    throw new CliError('Give --all or --removed, not both: --all also undeploys removed files.')
  }

  const repo = await loadRepository(ctx)
  const run = options.removed
    ? { modules: [], away: [], failures: 0, all: false }
    : await prepare('undeploy', repo, names, options, ctx)
  // Undeploying every module also undeploys what the repository no longer deploys.
  const withRemoved = options.removed || options.all || run?.all === true
  // Named modules not for this machine: what was deployed for them, without their scripts.
  const away = withRemoved ? [] : (run?.away ?? [])
  if (run == null && !withRemoved) return
  const units = unitsOf(run?.modules ?? [], options.strategy)
  const scripts = await loadHookScripts(
    'undeploy',
    { modules: run?.modules ?? [], named: run != null && !run.all },
    units,
    options,
    ctx,
  )
  let failures = run?.failures ?? 0

  /** Returns whether the file was handled (removed, kept on purpose, or not deployed). */
  const undeployOne = async (file: UndeployableFile, context: DeployContext): Promise<boolean> => {
    try {
      if (options.dryRun) {
        output.print(
          `- ${file.target} (${describePlannedUndeploy(await planUndeploy(file, context))})`,
        )
        return true
      }
      const result = await undeployFile(file, context)
      output.print(`- ${file.target} ${describeUndeploy(result)}`)
      recordUndeploy(file, result, ctx)
      return true
    } catch (error) {
      failures++
      reportFileError(file, error, ctx)
      return false
    }
  }
  const undeployFiles = async (files: readonly ModuleFile[], context: DeployContext) => {
    let complete = true
    for (const file of files) complete = (await undeployOne(file, context)) && complete
    return complete
  }

  /**
   * The files the repository no longer deploys, or only those of the `away`
   * modules: no module is left to name a script for them here.
   */
  const undeployRemoved = async (context: DeployContext): Promise<number> => {
    const found = await removedFiles(context.record, repo, options.strategy, ctx)
    const ofAway = (file: { module: string | null }) =>
      away.some(module => module.path === file.module)
    const removed = withRemoved ? found.removed : found.removed.filter(ofAway)
    const heldBack = withRemoved ? found.heldBack : found.heldBack.filter(ofAway)
    for (const { target, reason } of heldBack) {
      output.warn(`${target} was not checked: ${reason}.`)
    }
    if (removed.length === 0) {
      if (options.removed && heldBack.length === 0) {
        output.info(`Every deployed ${options.strategy} file is still deployed by the repository.`)
      }
      for (const module of withRemoved ? [] : away) {
        if (heldBack.some(file => file.module === module.path)) continue
        output.info(
          `${module.name} is not for this machine (${module.notHere}): nothing is deployed for it.`,
        )
      }
      return 0
    }

    const which = withRemoved
      ? 'files the repository no longer deploys'
      : `files of ${away.map(module => module.name).join(', ')} (not for this machine)`
    output.info(
      options.dryRun
        ? `${which[0]?.toUpperCase()}${which.slice(1)} would be undeployed:`
        : `Undeploying the ${which}…`,
    )
    for (const file of removed) {
      try {
        if (options.dryRun) {
          const decision = await planUndeploy(file, context)
          const handOver = decision.action === 'keep' ? '; configfile would stop tracking it' : ''
          output.print(`- ${file.target} (${describePlannedUndeploy(decision)}${handOver})`)
          continue
        }
        const result = await undeployFile(file, context)
        if (result.status === 'kept') {
          // configfile no longer deploys it and cannot remove it safely: it is the user's now.
          await context.record.setDeployed(file.target, null)
          output.print(
            `- ${file.target} (kept: ${describeKept(result.state)}; configfile no longer tracks it)`,
          )
        } else {
          output.print(`- ${file.target} ${describeUndeploy(result)}`)
        }
        recordUndeploy(file, result, ctx, { forgotten: result.status === 'kept' })
      } catch (error) {
        failures++
        reportFileError(file, error, ctx)
      }
    }
    return removed.length
  }

  let count = units.reduce((sum, unit) => sum + unit.files.length, 0)
  if (options.dryRun) {
    const context = await deployContext(ctx, repo.repository)
    const failed = new FailedHooks('undeploy')
    for (const { module, files } of units) {
      // Without its pre_undeploy script, the files of a module would stay deployed.
      if (!planHook(module, 'pre_undeploy', scripts, ctx)) {
        failed.add('pre_undeploy', module)
        continue
      }
      const complete = await undeployFiles(files, context)
      if (!planHook(module, 'post_undeploy', scripts, ctx, { complete })) {
        failed.add('post_undeploy', module)
      }
    }
    if (withRemoved || away.length > 0) count += await undeployRemoved(context)
    const problems = failed.problems(true)
    if (count > 0 || failures > 0 || problems.length > 0) {
      finish(failures, problems, count > 0 ? 'Dry run finished.' : '', ctx)
    }
    return
  }

  const outcome = await eachModule('undeploy', units, scripts, options, ctx, unit =>
    withCommandLock(ctx, async () =>
      undeployFiles(unit.files, await deployContext(ctx, repo.repository)),
    ),
  )
  const problems = outcome.problems
  if (withRemoved || away.length > 0) {
    if (outcome.stopped) {
      problems.push('The files the repository no longer deploys were not checked.')
    } else {
      try {
        count += await withCommandLock(ctx, async () =>
          undeployRemoved(await deployContext(ctx, repo.repository)),
        )
      } catch (error) {
        // After the modules: what they did, and what failed, is still reported.
        if (!(error instanceof CliError) || (units.length === 0 && failures === 0)) throw error
        problems.push(
          `The files the repository no longer deploys were not checked: ${messageOf(error)}`,
        )
      }
    }
  }
  if (count === 0 && failures === 0 && problems.length === 0) return
  finish(failures, problems, count > 0 ? 'Undeployment finished.' : '', ctx, outcome.exitCode)
}

/** Loads the record: call it after taking the lock when files are changed. */
async function deployContext(ctx: Context, repository: string): Promise<DeployContext> {
  return {
    record: await DeploymentRecord.load(ctx.home),
    guard: new Guard({ home: ctx.home, cwd: ctx.cwd }),
    view: new RepositoryView(repository),
  }
}

/**
 * Selects the modules and files a deploy or undeploy works on, and reports
 * modules and settings entries that are skipped (they count as failures, as
 * do the settings that cannot name a script this command would run).
 *
 * Returns `null` when no module is selected. When the selected modules have
 * no file of the kind the command works on, says so and still returns them:
 * their scripts are reported as not run.
 */
async function prepare(
  verb: Verb,
  { modules }: Repository,
  names: string[],
  options: Options,
  ctx: Context,
): Promise<{
  /** The selected modules that can be used on this machine, in repository order. */
  modules: UsableModule[]
  /** The selected modules that are not for this machine (their `"when"`). */
  away: UsableModule[]
  failures: number
  /** Every module was selected (with --all, or at the question), even when there is none. */
  all: boolean
} | null> {
  const { output } = ctx
  const { selected, all } = await selectModules(verb, modules, names, options, ctx)
  if (selected.length === 0) return all ? { modules: [], away: [], failures: 0, all } : null

  let failures = 0
  const usable: UsableModule[] = []
  const away: UsableModule[] = []
  for (const module of selected) {
    if (module.error != null) {
      failures++
      output.error(`Module "${module.name}" was not ${verb}ed: ${module.error}.`)
      ctx.history.record({ kind: 'failed', module: module.name, reason: module.error })
      continue
    }
    // Not this machine's: neither its files nor its scripts, and nothing to fix here.
    if (module.notHere != null) {
      away.push(module)
      continue
    }

    usable.push(module)
    failures += module.invalidEntries.length
    for (const problem of module.invalidEntries) {
      ctx.history.record({ kind: 'failed', module: module.name, reason: problem })
    }
    // Only the scripts this command would run.
    for (const hook of hooksOf(verb)) {
      const problem = module.hookProblems[hook]
      if (problem == null) continue
      failures++
      ctx.history.record({ kind: 'failed', module: module.name, reason: problem })
    }
    reportSettings(module, ctx, verb)
    for (const source of module.undecided) {
      output.warn(
        `${module.name}: "${source}" was not ${verb}ed because no deployment strategy is defined. ` +
          `Set "deploy" to "global", "local" or "none" in ${module.settingsFile}.`,
      )
    }
  }

  if (verb === 'deploy' && away.length > 0) {
    if (all) {
      output.info(`Not for this machine, skipped: ${away.map(module => module.name).join(', ')}.`)
    } else {
      for (const module of away) {
        output.info(`${module.name}: not for this machine (${module.notHere}), skipped.`)
      }
    }
  }

  // Files for other machines, inside modules for this one. A dry run lists
  // them with the files of their module, when it has any here.
  const skipping = new Set<UsableModule>()
  for (const module of verb === 'deploy' ? usable : []) {
    const elsewhere = module.elsewhere.filter(({ file }) => file.strategy === options.strategy)
    if (elsewhere.length === 0) continue
    skipping.add(module)
    const here = module.files.some(file => file.strategy === options.strategy)
    if (options.dryRun && here) continue
    const reasons = [...new Set(elsewhere.map(({ reason }) => reason))].join('; ')
    output.info(
      `${module.name}: ${plural(elsewhere.length, 'file')} not for this machine (${reasons}), skipped.`,
    )
  }

  const files = usable
    .flatMap(module => module.files)
    .filter(file => file.strategy === options.strategy)
  const moduleNames = usable.map(module => module.name).join(', ')

  if (files.length === 0) {
    if (failures > 0)
      throw new CliError(
        `Nothing could be ${verb}ed. ${plural(failures, 'module or settings entry', 'modules or settings entries')} failed.`,
      )
    // The modules whose files are all for other machines were explained above.
    const empty = usable.filter(module => !skipping.has(module)).map(module => module.name)
    if (empty.length > 0)
      output.info(`No ${options.strategy} file to ${verb} in ${empty.join(', ')}.`)
    return { modules: usable, away, failures, all }
  }

  const action = verb === 'deploy' ? 'Deploying' : 'Undeploying'
  output.info(
    options.dryRun
      ? `Dry run, nothing is changed. ${action} ${moduleNames} would do:`
      : `${action} ${moduleNames}…`,
  )
  return { modules: usable, away, failures, all }
}

async function selectModules(
  verb: 'deploy' | 'undeploy',
  modules: Module[],
  names: string[],
  options: Options,
  ctx: Context,
): Promise<{ selected: Module[]; all: boolean }> {
  if (names.length > 0) {
    if (options.all) {
      throw new CliError('Give module names or --all, not both.')
    }

    const selected = pickModules(modules, names)
    const broken = selected.find(module => module.error != null)
    if (broken?.error != null) {
      throw new CliError(`Module "${broken.name}" cannot be ${verb}ed: ${broken.error}.`)
    }
    return { selected, all: false }
  }

  if (modules.length === 0) {
    ctx.output.info('No module found.')
    return { selected: [], all: options.all }
  }

  if (options.all) return { selected: modules, all: true }

  if (!ctx.prompts.interactive) {
    throw new CliError(`No module given. Pass module names, or --all to ${verb} every module.`)
  }

  const confirmed = await ctx.prompts.confirm({
    message:
      verb === 'deploy'
        ? 'No module given. Deploy all available modules?'
        : 'No module given. Undeploy all available modules, and the files the repository no longer deploys?',
    default: false,
  })
  if (!confirmed) {
    ctx.output.info(`Nothing ${verb}ed.`)
    return { selected: [], all: false }
  }

  ctx.history.option('all', true)
  return { selected: modules, all: true }
}

/** The modules named on the command line, in repository order. Fails on unknown names. */
function pickModules(modules: Module[], names: string[]): Module[] {
  const unknown = names.filter(name => !modules.some(module => module.name === name))
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown module${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. ` +
        'Run "configfile modules list" to see available modules.',
    )
  }
  return modules.filter(module => names.includes(module.name))
}

/**
 * Invalid entries (the file is not deployed) and settings that cannot name a
 * script are errors. With `verb`, the command only fails on the scripts it
 * would run: the other settings are warnings.
 */
function reportSettings(module: Module, ctx: Context, verb?: Verb): void {
  if (module.error != null) return
  for (const problem of module.invalidEntries) {
    ctx.output.error(`${module.name}: ${problem}.`)
  }
  for (const hook of HOOKS) {
    const problem = module.hookProblems[hook]
    if (problem == null) continue
    if (verb == null || hooksOf(verb).includes(hook))
      ctx.output.error(`${module.name}: ${problem}.`)
    else ctx.output.warn(`${module.name}: ${problem}.`)
  }
}

function skippedProblems(skipped: number, interactive: boolean): string[] {
  return !interactive && skipped > 0
    ? [`${plural(skipped, 'file')} already existed. Use --force to replace them.`]
    : []
}

function skippedLinkProblems(skipped: number, interactive: boolean): string[] {
  if (interactive || skipped === 0) return []
  const one = skipped === 1
  return [
    `${plural(skipped, 'file')} that replaced configfile's links ${one ? 'was' : 'were'} left as ` +
      `${one ? 'it is' : 'they are'}. Use --force to link ${one ? 'it' : 'them'} again ` +
      `(${one ? 'it is' : 'they are'} moved to .old).`,
  ]
}

/** Without a terminal, conflicts in copies fail the command; answering no to them does not. */
function skippedCopyProblems(skipped: number, interactive: boolean): string[] {
  if (interactive || skipped === 0) return []
  const one = skipped === 1
  return [
    `${plural(skipped, 'copy', 'copies')} changed both on this machine and in the repository ` +
      `${one ? 'was' : 'were'} left as ${one ? 'it is' : 'they are'}. Use --force to replace ` +
      `${one ? 'it' : 'them'} with the repository's version.`,
  ]
}

function unresolvedCopyProblems(count: number): string[] {
  if (count === 0) return []
  return [
    `${plural(count, 'copy', 'copies')} still ${count === 1 ? 'has' : 'have'} files configfile ` +
      'could not update: see why above.',
  ]
}

function finish(
  failures: number,
  problems: string[],
  success: string,
  ctx: Context,
  exitCode?: number,
): void {
  if (failures > 0) {
    problems.push(
      `${plural(failures, 'file, module or settings entry', 'files, modules or settings entries')} failed.`,
    )
  }
  if (problems.length > 0) {
    throw new CliError(problems.join(' '), exitCode == null ? {} : { exitCode })
  }
  ctx.output.success(success)
}

function reportFileError(file: { target: string }, error: unknown, ctx: Context): void {
  ctx.output.error(`${file.target}: ${messageOf(error)}`)
  ctx.history.record({ kind: 'failed', target: file.target, reason: messageOf(error) })
  if (process.env.DEBUG != null) {
    if (!(error instanceof CliError)) {
      ctx.output.stderr.write(`${(error as Error).stack}\n`)
    } else if (error.cause !== undefined) {
      ctx.output.stderr.write(`Caused by: ${inspect(error.cause)}\n`)
    }
  }
}

function describePlannedDeploy(
  file: ModuleFile,
  decision: DeployDecision,
  interactive: boolean,
): string {
  const how = howOf(file)
  switch (decision.action) {
    case 'create':
      return `would be ${how}`
    case 'up-to-date':
      return 'already up to date'
    case 'replace':
      return decision.what === 'copy'
        ? `would be replaced, the existing one moved to ${decision.backup}`
        : `would be ${how}, the existing ${decision.what} moved to ${decision.backup}`
    case 'refresh':
      if (decision.was !== 'copy') {
        return 'would be linked again (it pointed to an old location of the repository)'
      }
      return how === 'linked'
        ? "would be linked in place of configfile's copy"
        : 'would be copied again (the repository made a folder of the file, or the reverse)'
    case 'convert':
      return "would be copied in place of configfile's link"
    case 'update':
      return describeCopied(previewCopy(file, decision.plan, decision.replace), 'would')
    case 'conflict': {
      // The rest of a copy follows the repository whatever the answer.
      const rest =
        decision.plan == null
          ? []
          : previewCopy(file, decision.plan, 'none').filter(
              copied => copied.result !== 'conflict' || copied.reason != null,
            )
      const what = decision.replacedLink
        ? 'a file replaced the link'
        : decision.paths == null
          ? 'already exists'
          : `${describePaths(decision.paths)} changed here and in the repository`
      const answer = interactive
        ? `${what}: you would be asked whether to replace ${decision.paths?.length === 1 || decision.paths == null ? 'it' : 'them'}`
        : `${what}: would be skipped (use --force to replace ${decision.paths != null && decision.paths.length > 1 ? 'them' : 'it'})`
      return rest.length === 0 ? answer : `${describeCopied(rest, 'would')}; ${answer}`
    }
  }
}

/**
 * What happened (or `would` happen, in a dry run) to the files of a copy:
 * `updated from the repository`, `a, b: kept: changed on this machine`…
 */
function describeCopied(files: readonly CopiedFile[], tense: 'did' | 'would'): string {
  const paths = (keep: (copied: CopiedFile) => boolean) =>
    files.filter(keep).map(copied => copied.path)
  const would = tense === 'would'
  const reasons = [
    ...new Set(
      files.flatMap(copied =>
        copied.result === 'conflict' && copied.reason != null ? [copied.reason] : [],
      ),
    ),
  ]
  const backups = files.flatMap(copied => (copied.backup == null ? [] : [copied.backup]))
  const parts = [
    listed(
      paths(copied => copied.result === 'created' || copied.result === 'updated'),
      would ? 'would be updated from the repository' : 'updated from the repository',
    ),
    listed(
      paths(copied => copied.result === 'deleted'),
      would
        ? 'would be deleted: the repository no longer has it'
        : 'deleted: the repository no longer has it',
    ),
    backups.length === 0
      ? null
      : `yours ${would ? 'would be' : ''}${would ? ' ' : ''}moved to ${backups.join(', ')}`,
    listed(
      paths(copied => copied.result === 'kept'),
      would ? 'changed on this machine, would be kept' : 'kept: changed on this machine',
    ),
    listed(
      paths(copied => copied.result === 'conflict' && copied.reason == null),
      would
        ? 'changed here and in the repository, would be skipped'
        : 'skipped: changed here and in the repository',
    ),
    ...reasons.map(reason =>
      listed(
        paths(copied => copied.result === 'conflict' && copied.reason === reason),
        `${would ? 'would be left' : 'left'} as it is: ${reason}`,
      ),
    ),
    listed(
      paths(copied => copied.result === 'failed'),
      'failed (see below)',
    ),
  ].filter(part => part != null)
  return parts.length === 0 ? 'already up to date' : parts.join('; ')
}

/** `text` for a copied file, or `a, b: text` for files of a copied folder; `null` for none. */
function listed(paths: readonly string[], text: string): string | null {
  if (paths.length === 0) return null
  return paths.length === 1 && paths[0] === '' ? text : `${describePaths(paths)}: ${text}`
}

/** `it` for a copied file, or the first files of a copied folder. */
function describePaths(paths: readonly string[], shown = 5): string {
  if (paths.length === 1 && paths[0] === '') return 'it'
  const named = paths.slice(0, shown).join(', ')
  return paths.length > shown ? `${named} and ${paths.length - shown} more` : named
}

/** How a file is deployed, in messages: `linked` or `copied`. */
function howOf(file: Pick<ModuleFile, 'strategy' | 'method'>): 'linked' | 'copied' {
  return file.strategy === 'global' && file.method === 'link' ? 'linked' : 'copied'
}

function describePlannedUndeploy(decision: UndeployDecision): string {
  switch (decision.action) {
    case 'not-deployed':
      return 'not deployed'
    case 'keep':
      return `would be kept: ${describeKept(decision.state, 'would be')}`
    case 'remove':
      return `would be removed${describeBackup(decision.backup, 'would be')}`
  }
}

function describeState(state: TargetState, file: Pick<ModuleFile, 'strategy'>): string {
  switch (state.kind) {
    case 'missing':
      return 'not deployed'
    case 'deployed':
      return file.strategy === 'global' ? 'linked' : 'deployed'
    case 'copied': {
      if (
        [...state.changed, ...state.conflicts, ...state.outdated, ...state.deleted].some(
          path => path !== '',
        )
      ) {
        return 'copied'
      }
      if (state.conflicts.length > 0) {
        return 'copied, changed here and in the repository: deploy it again to choose'
      }
      if (state.changed.length > 0) return 'copied, changed on this machine'
      if (state.outdated.length > 0) {
        return 'copied, the repository has a newer version: deploy it again'
      }
      return 'copied'
    }
    case 'linked':
      return 'linked: deploy it again to copy it'
    case 'copied-not-linked':
      return state.changed
        ? 'copied, changed on this machine: deploy it again with --force to link it'
        : 'copied: deploy it again to link it'
    case 'modified':
      return 'modified since it was copied'
    case 'identical':
      return 'identical to the repository, but not copied by configfile'
    case 'stale':
      return 'deployed, but linked to an old location of the repository: deploy it again'
    case 'foreign':
      return `not deployed: a ${state.what} is in the way${compared(state.identical)}`
    case 'replaced-link':
      return `linked, but a file replaced the link${compared(state.identical)}`
    case 'source-missing':
      return state.ours
        ? 'deployed, but its source is missing from the repository'
        : 'its source is missing from the repository'
  }
}

/** ` (identical to the repository)`, ` (differs from the repository)`, or nothing when unknown. */
function compared(identical: boolean | undefined): string {
  if (identical == null) return ''
  return ` (${identical ? 'identical to' : 'differs from'} the repository)`
}

function describeKept(state: KeptState, tense: 'would be' | 'was' = 'was'): string {
  switch (state.kind) {
    case 'foreign':
      return `the ${state.what} there was not deployed by configfile`
    case 'identical':
      return 'it is identical to the repository, but configfile did not copy it'
    case 'modified':
      return 'it was modified since it was copied'
    case 'source-missing':
      return 'its source is missing from the repository, so it cannot be compared'
    case 'changed': {
      if (state.paths.length === 1 && state.paths[0] === '') return 'it was changed on this machine'
      const parts = [
        state.paths.length === 0 ? null : `${describePaths(state.paths)} changed on this machine`,
        state.others.length === 0
          ? null
          : `${plural(state.others.length, 'file')} configfile did not copy ` +
            `(${describePaths(state.others)})`,
        state.removed === 0
          ? null
          : `the other ${plural(state.removed, 'file')} ${
              tense === 'was' ? (state.removed === 1 ? 'was' : 'were') : 'would be'
            } removed`,
      ]
      return parts.filter(part => part != null).join('; ')
    }
  }
}

function describeBackup(backup: BackupCheck | null, tense: 'would be' | 'was'): string {
  if (backup == null) return ''
  switch (backup.status) {
    case 'ok':
      return tense === 'was' ? `, ${backup.path} restored` : `, ${backup.path} restored`
    case 'missing':
      return `; its backup ${backup.path} no longer exists, nothing ${tense} restored`
    case 'changed':
      return `; its backup ${backup.path} changed since it was made, so it ${tense === 'was' ? 'was' : 'would be'} not restored`
  }
}

export function describeDeploy(
  file: ModuleFile,
  result: Exclude<DeployResult, { status: 'conflict' }>,
): string {
  const how = howOf(file)
  switch (result.status) {
    case 'deployed':
      return `(${how})`
    case 'up-to-date':
      return '(already up to date)'
    case 'backed-up':
      return `(${how}, previous file moved to ${result.backup})`
    case 'converted':
      return how === 'copied'
        ? "(copied in place of configfile's link)"
        : "(linked in place of configfile's copy)"
    case 'updated':
      return `(${describeCopied(result.outcome.files, 'did')})`
  }
}

function describeUndeploy(result: UndeployResult): string {
  switch (result.status) {
    case 'removed': {
      const leftover =
        result.leftover == null ? '' : `; the removed copy could not be deleted: ${result.leftover}`
      return `(removed${describeBackup(result.backup, 'was')}${leftover})`
    }
    case 'not-deployed':
      return '(not deployed)'
    case 'kept':
      return `(kept: ${describeKept(result.state)})`
  }
}

/** Records a deployment in the history (files already in place are only counted). */
export function recordDeploy(
  file: ModuleFile,
  result: Exclude<DeployResult, { status: 'conflict' }>,
  ctx: Context,
): void {
  const how = file.strategy === 'global' && file.method === 'link' ? 'link' : 'copy'
  switch (result.status) {
    case 'up-to-date':
      ctx.history.unchanged()
      return
    case 'deployed':
    case 'backed-up':
    case 'converted':
      ctx.history.record({
        kind: 'deployed',
        how,
        source: file.source,
        target: file.target,
        ...(result.status === 'backed-up' && { backup: result.backup }),
        ...(result.status === 'converted' && { replaced: how === 'link' ? 'copy' : 'link' }),
      })
      return
    case 'updated':
      for (const copied of result.outcome.files) recordCopied(file, copied, ctx)
      return
  }
}

/** One file of a copy in the history, at its own path. */
function recordCopied(file: ModuleFile, copied: CopiedFile, ctx: Context): void {
  const inside = (root: string) =>
    copied.path === '' ? root : path.join(root, ...copied.path.split('/'))
  const target = inside(file.target)
  const backup = copied.backup == null ? {} : { backup: copied.backup }
  switch (copied.result) {
    case 'created':
    case 'updated':
      ctx.history.record({
        kind: 'deployed',
        how: 'copy',
        source: inside(file.source),
        target,
        ...(copied.backup == null
          ? copied.result === 'updated' && { replaced: 'copy' as const }
          : backup),
      })
      return
    case 'deleted':
      ctx.history.record({
        kind: 'removed',
        target,
        ...(copied.backup != null && { movedTo: copied.backup }),
      })
      return
    case 'kept':
      ctx.history.record({ kind: 'kept', target, reason: 'changed' })
      return
    case 'conflict':
      ctx.history.record({ kind: 'skipped', target, reason: 'conflict' })
      return
    case 'failed':
      ctx.history.record({ kind: 'failed', target, reason: copied.reason ?? 'failed' })
      return
  }
}

/** Records an undeployment in the history (files that were not deployed are only counted). */
function recordUndeploy(
  file: { target: string },
  result: UndeployResult,
  ctx: Context,
  { forgotten = false }: { forgotten?: boolean } = {},
): void {
  switch (result.status) {
    case 'not-deployed':
      ctx.history.unchanged()
      return
    case 'kept':
      ctx.history.record({
        kind: 'kept',
        target: file.target,
        reason: result.state.kind,
        ...(forgotten && { forgotten: true }),
      })
      return
    case 'removed':
      ctx.history.record({
        kind: 'removed',
        target: file.target,
        ...(result.backup != null && {
          backup: {
            path: result.backup.path,
            status: result.backup.status === 'ok' ? 'restored' : result.backup.status,
          },
        }),
        ...(result.leftover != null && { leftover: result.leftover }),
      })
      return
  }
}
