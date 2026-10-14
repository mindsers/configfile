import { constants as osConstants } from 'node:os'
import { inspect } from 'node:util'

import type { Command } from 'commander'

import type { Context } from '../context.ts'
import {
  type BackupCheck,
  type DeployContext,
  type DeployDecision,
  type DeployResult,
  deployFile,
  Guard,
  inspectFile,
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
import { plural } from '../output.ts'
import { runScript } from '../process.ts'
import { findRemovedFiles, type HeldBack, type RecordedFile } from '../removed.ts'
import {
  HOOKS,
  type Hook,
  loadRepository,
  loadScripts,
  type Module,
  type ModuleFile,
  type Script,
  scriptEnvironment,
  systemName,
} from '../repository.ts'
import { DeploymentRecord } from '../state.ts'

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
}

function normalize(options: RawOptions): Options {
  return {
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
    .action((names: string[], options: RawOptions) => status(names, normalize(options), ctx))

  modules
    .command('deploy')
    .alias('d')
    .argument('[modules...]', 'modules to deploy (use --all, or answer a question, when omitted)')
    .description('deploy the files of one or more modules')
    .option('-l, --local', 'copy the local files of the modules instead of linking global files')
    .option('-a, --all', 'deploy every module without asking')
    .option('-f, --force', 'replace existing local files without asking (they are moved to .old)')
    .option('-n, --dry-run', 'show what would be done, without changing anything')
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
    .option('-l, --local', 'remove the local copies of the modules instead of global links')
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

/** What `modules list` adds to a module's name: why it is ignored, or the scripts it names. */
function describeListed(module: Module): string {
  if (module.error != null) return ` (ignored: ${module.error})`
  const hooks = HOOKS.filter(hook => module.hooks[hook] != null)
  return hooks.length === 0 ? '' : ` (${hooks.join(', ')})`
}

async function status(names: string[], options: Options, ctx: Context): Promise<void> {
  const { output } = ctx
  const repo = await loadRepository(ctx)
  const selected = names.length === 0 ? repo.modules : pickModules(repo.modules, names)

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

  const describeTarget = async (file: Pick<ModuleFile, 'source' | 'target' | 'strategy'>) => {
    try {
      return describeState(await inspectFile(file, record))
    } catch (error) {
      return `cannot be checked: ${messageOf(error)}`
    }
  }

  for (const module of selected) {
    output.print(`${module.name}:`)

    if (module.error != null) {
      output.print(`  ignored: ${module.error}`)
      continue
    }
    reportSettings(module, ctx)

    const files = module.files.filter(file => file.strategy === options.strategy)
    for (const file of files) {
      output.print(`  ${file.target} (${await describeTarget(file)})`)
    }
    for (const source of module.undecided) {
      output.print(`  ${source} (no deployment strategy)`)
    }
    if (files.length === 0 && module.undecided.length === 0) {
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

  if (removed.length > 0) {
    output.print(
      `No longer deployed by the repository (run "${undeployRemovedCommand(options.strategy)}"):`,
    )
    for (const file of removed) {
      output.print(`  ${file.target} (${await describeTarget(file)})`)
    }
  }
  if (heldBack.length > 0) {
    output.print('Deployed, but configfile cannot tell whether the repository still deploys them:')
    for (const { target, reason } of heldBack) {
      output.print(`  ${target} (${reason})`)
    }
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

async function deploy(names: string[], options: Options, ctx: Context): Promise<void> {
  const { output, prompts } = ctx
  const run = await prepare('deploy', await loadRepository(ctx), names, options, ctx)
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
    const context = await deployContext(ctx)
    const failed = new FailedHooks('deploy')
    let wouldSkip = 0
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
            wouldSkip++
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
      if (!planHook(module, 'post_deploy', scripts, ctx, { complete })) {
        failed.add('post_deploy', module)
      }
    }
    const problems = [...skippedProblems(wouldSkip, prompts.interactive), ...failed.problems(true)]
    finish(failures, problems, 'Dry run finished.', ctx)
    return
  }

  let skipped = 0
  const outcome = await eachModule('deploy', units, scripts, options, ctx, async unit => {
    const result = await withCommandLock(ctx, async () =>
      deployFiles(unit.files, options, await deployContext(ctx), ctx),
    )
    failures += result.failures
    skipped += result.skipped
    return result.failures === 0 && result.skipped === 0 && unit.module.invalidEntries.length === 0
  })

  const problems = [...skippedProblems(skipped, prompts.interactive), ...outcome.problems]
  finish(failures, problems, 'Deployment finished.', ctx, outcome.exitCode)
}

/** Deploys the files of a module while the lock is held. */
async function deployFiles(
  files: ModuleFile[],
  options: Options,
  context: DeployContext,
  ctx: Context,
): Promise<{ failures: number; skipped: number }> {
  const { output, prompts } = ctx
  let failures = 0
  const reportError = (file: ModuleFile, error: unknown) => {
    failures++
    reportFileError(file, error, ctx)
  }

  const conflicts: ModuleFile[] = []
  for (const file of files) {
    try {
      const result = await deployFile(file, { ...context, force: options.force })
      if (result.status === 'conflict') {
        conflicts.push(file)
      } else {
        output.print(`- ${file.target} ${describeDeploy(result)}`)
        recordDeploy(file, result, ctx)
      }
    } catch (error) {
      reportError(file, error)
    }
  }

  // Asked once the other files of the module are deployed, so an answer never blocks them.
  let skipped = 0
  for (const file of conflicts) {
    const replace =
      prompts.interactive &&
      (await prompts.confirm({
        message: `${file.target} already exists. Replace it (the current one is moved to .old)?`,
        default: false,
      }))

    if (!replace) {
      skipped++
      output.print(`- ${file.target} (already exists, skipped)`)
      ctx.history.record({ kind: 'skipped', target: file.target, reason: 'exists' })
      continue
    }

    try {
      const result = await deployFile(file, { ...context, force: true })
      if (result.status === 'conflict') {
        throw new CliError('the target still exists after being moved aside.')
      }
      output.print(`- ${file.target} ${describeDeploy(result)}`)
      recordDeploy(file, result, ctx)
    } catch (error) {
      reportError(file, error)
    }
  }

  return { failures, skipped }
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
        ...scriptEnvironment(script, scripts.repository, ctx.platform),
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
    ? { modules: [], failures: 0, all: false }
    : await prepare('undeploy', repo, names, options, ctx)
  // Undeploying every module also undeploys what the repository no longer deploys.
  const withRemoved = options.removed || options.all || run?.all === true
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

  /** The files the repository no longer deploys: no module is left to name a script for them. */
  const undeployRemoved = async (context: DeployContext): Promise<number> => {
    const { removed, heldBack } = await removedFiles(context.record, repo, options.strategy, ctx)
    for (const { target, reason } of heldBack) {
      output.warn(`${target} was not checked: ${reason}.`)
    }
    if (removed.length === 0) {
      if (options.removed && heldBack.length === 0) {
        output.info(`Every deployed ${options.strategy} file is still deployed by the repository.`)
      }
      return 0
    }

    output.info(
      options.dryRun
        ? 'Files the repository no longer deploys would be undeployed:'
        : 'Undeploying the files the repository no longer deploys…',
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
    const context = await deployContext(ctx)
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
    if (withRemoved) count += await undeployRemoved(context)
    const problems = failed.problems(true)
    if (count > 0 || failures > 0 || problems.length > 0) {
      finish(failures, problems, count > 0 ? 'Dry run finished.' : '', ctx)
    }
    return
  }

  const outcome = await eachModule('undeploy', units, scripts, options, ctx, unit =>
    withCommandLock(ctx, async () => undeployFiles(unit.files, await deployContext(ctx))),
  )
  const problems = outcome.problems
  if (withRemoved) {
    if (outcome.stopped) {
      problems.push('The files the repository no longer deploys were not checked.')
    } else {
      try {
        count += await withCommandLock(ctx, async () => undeployRemoved(await deployContext(ctx)))
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
async function deployContext(ctx: Context): Promise<DeployContext> {
  return {
    record: await DeploymentRecord.load(ctx.home),
    guard: new Guard({ home: ctx.home, cwd: ctx.cwd }),
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
  /** The selected modules that can be used, in repository order. */
  modules: UsableModule[]
  failures: number
  /** Every module was selected (with --all, or at the question), even when there is none. */
  all: boolean
} | null> {
  const { output } = ctx
  const { selected, all } = await selectModules(verb, modules, names, options, ctx)
  if (selected.length === 0) return all ? { modules: [], failures: 0, all } : null

  let failures = 0
  const usable: UsableModule[] = []
  for (const module of selected) {
    if (module.error != null) {
      failures++
      output.error(`Module "${module.name}" was not ${verb}ed: ${module.error}.`)
      ctx.history.record({ kind: 'failed', module: module.name, reason: module.error })
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
          'Set "deploy" to "global", "local" or "none" in settings.json.',
      )
    }
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
    output.info(`No ${options.strategy} file to ${verb} in ${moduleNames}.`)
    return { modules: usable, failures, all }
  }

  const action = verb === 'deploy' ? 'Deploying' : 'Undeploying'
  output.info(
    options.dryRun
      ? `Dry run, nothing is changed. ${action} ${moduleNames} would do:`
      : `${action} ${moduleNames}…`,
  )
  return { modules: usable, failures, all }
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
 * script are errors, deprecations are warnings. With `verb`, the command
 * only fails on the scripts it would run: the other settings are warnings.
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
  for (const deprecation of module.deprecations) {
    ctx.output.warn(`${module.name}: ${deprecation}.`)
  }
}

function skippedProblems(skipped: number, interactive: boolean): string[] {
  return !interactive && skipped > 0
    ? [`${plural(skipped, 'file')} already existed. Use --force to replace them.`]
    : []
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
  switch (decision.action) {
    case 'create':
      return `would be ${file.strategy === 'global' ? 'linked' : 'copied'}`
    case 'up-to-date':
      return 'already up to date'
    case 'replace':
      return decision.what === 'copy'
        ? `would be replaced, the existing one moved to ${decision.backup}`
        : `would be ${file.strategy === 'global' ? 'linked' : 'copied'}, the existing ` +
            `${decision.what} moved to ${decision.backup}`
    case 'refresh':
      return 'would be linked again (it pointed to an old location of the repository)'
    case 'conflict':
      return interactive
        ? 'already exists: you would be asked whether to replace it'
        : 'already exists: would be skipped (use --force to replace it)'
  }
}

function describePlannedUndeploy(decision: UndeployDecision): string {
  switch (decision.action) {
    case 'not-deployed':
      return 'not deployed'
    case 'keep':
      return `would be kept: ${describeKept(decision.state)}`
    case 'remove':
      return `would be removed${describeBackup(decision.backup, 'would be')}`
  }
}

function describeState(state: TargetState): string {
  switch (state.kind) {
    case 'missing':
      return 'not deployed'
    case 'deployed':
      return 'deployed'
    case 'modified':
      return 'modified since it was copied'
    case 'identical':
      return 'identical to the repository, but not copied by configfile'
    case 'stale':
      return 'deployed, but linked to an old location of the repository: deploy it again'
    case 'foreign':
      return `not deployed: a ${state.what} is in the way`
    case 'source-missing':
      return state.ours
        ? 'deployed, but its source is missing from the repository'
        : 'its source is missing from the repository'
  }
}

function describeKept(state: KeptState): string {
  switch (state.kind) {
    case 'foreign':
      return `the ${state.what} there was not deployed by configfile`
    case 'identical':
      return 'it is identical to the repository, but configfile did not copy it'
    case 'modified':
      return 'it was modified since it was copied'
    case 'source-missing':
      return 'its source is missing from the repository, so it cannot be compared'
  }
}

/** `, <backup> restored` and its variants, for undeploy results and dry runs. */
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

function describeDeploy(result: Exclude<DeployResult, { status: 'conflict' }>): string {
  switch (result.status) {
    case 'deployed':
      return '(deployed)'
    case 'up-to-date':
      return '(already up to date)'
    case 'backed-up':
      return `(deployed, previous file moved to ${result.backup})`
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
function recordDeploy(
  file: ModuleFile,
  result: Exclude<DeployResult, { status: 'conflict' }>,
  ctx: Context,
): void {
  if (result.status === 'up-to-date') {
    ctx.history.unchanged()
    return
  }
  ctx.history.record({
    kind: 'deployed',
    how: file.strategy === 'global' ? 'link' : 'copy',
    source: file.source,
    target: file.target,
    ...(result.status === 'backed-up' && { backup: result.backup }),
  })
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
