import type { Command } from 'commander'

import { ConfigStore } from '../config.js'
import type { Context } from '../context.js'
import {
  assertSafeTarget,
  assertSourceExists,
  type DeployDecision,
  type DeployResult,
  decideDeploy,
  decideUndeploy,
  deployFile,
  inspectFile,
  type KeptState,
  nextBackupPath,
  type TargetState,
  type UndeployResult,
  undeployFile,
} from '../deploy.js'
import { CliError } from '../errors.js'
import { plural } from '../output.js'
import { listModules, type Module, type ModuleFile } from '../repository.js'
import { BackupRecord } from '../state.js'

type Strategy = ModuleFile['strategy']
type UsableModule = Extract<Module, { error: null }>

/** Command-line options, as commander gives them. */
interface RawOptions {
  local?: boolean
  all?: boolean
  force?: boolean
  dryRun?: boolean
}

/** Options once normalized at the command boundary. */
interface Options {
  strategy: Strategy
  all: boolean
  force: boolean
  dryRun: boolean
}

function normalize(options: RawOptions): Options {
  return {
    strategy: options.local === true ? 'local' : 'global',
    all: options.all === true,
    force: options.force === true,
    dryRun: options.dryRun === true,
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
    .action((names: string[], options: RawOptions) => deploy(names, normalize(options), ctx))

  modules
    .command('undeploy')
    .alias('u')
    .argument('[modules...]', 'modules to undeploy (use --all, or answer a question, when omitted)')
    .description('remove the deployed files of one or more modules and restore their backups')
    .option('-l, --local', 'remove the local copies of the modules instead of global links')
    .option('-a, --all', 'undeploy every module without asking')
    .option('-n, --dry-run', 'show what would be done, without changing anything')
    .action((names: string[], options: RawOptions) => undeploy(names, normalize(options), ctx))
}

async function loadModules(ctx: Context): Promise<Module[]> {
  const config = await new ConfigStore(ctx.home).read()

  return listModules(config.folderPath, {
    home: ctx.home,
    cwd: ctx.cwd,
    warn: message => ctx.output.warn(message),
  })
}

async function list(ctx: Context): Promise<void> {
  const modules = await loadModules(ctx)

  if (modules.length === 0) {
    ctx.output.info('No module found.')
    return
  }

  ctx.output.print(`${plural(modules.length, 'module')} found.`)
  for (const module of modules) {
    ctx.output.print(`- ${module.name}${module.error == null ? '' : ` (ignored: ${module.error})`}`)
  }
  for (const module of modules) reportSettings(module, ctx)
}

async function status(names: string[], options: Options, ctx: Context): Promise<void> {
  const { output } = ctx
  const modules = await loadModules(ctx)
  const selected = names.length === 0 ? modules : pickModules(modules, names)

  if (selected.length === 0) {
    output.info('No module found.')
    return
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
      let state: string
      try {
        state = describeState(await inspectFile(file))
      } catch (error) {
        state = `cannot be checked: ${(error as Error).message}`
      }
      output.print(`  ${file.target} (${state})`)
    }
    for (const source of module.undecided) {
      output.print(`  ${source} (no deployment strategy)`)
    }
    if (files.length === 0 && module.undecided.length === 0) {
      output.print(`  no ${options.strategy} file`)
    }
  }
}

async function deploy(names: string[], options: Options, ctx: Context): Promise<void> {
  const { output, prompts } = ctx
  const run = await prepare('deploy', names, options, ctx)
  if (run == null) return

  const { files, record } = run
  let failures = run.failures
  const reportError = (file: ModuleFile, error: unknown) => {
    failures++
    reportFileError(file, error, ctx)
  }

  if (options.dryRun) {
    let wouldSkip = 0
    for (const file of files) {
      try {
        const decision = await planDeploy(file, options)
        if (decision.action === 'conflict' && !prompts.interactive) wouldSkip++
        output.print(
          `- ${file.target} (${describePlannedDeploy(file, decision, prompts.interactive)})`,
        )
      } catch (error) {
        reportError(file, error)
      }
    }
    finish(failures, skippedProblems(wouldSkip, prompts.interactive), 'Dry run finished.', ctx)
    return
  }

  const conflicts: ModuleFile[] = []
  for (const file of files) {
    try {
      const result = await deployFile(file, { force: options.force, record })
      if (result.status === 'conflict') {
        conflicts.push(file)
      } else {
        output.print(`- ${file.target} ${describeDeploy(result)}`)
      }
    } catch (error) {
      reportError(file, error)
    }
  }

  // Asked once everything else is deployed, so an answer never blocks other files.
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
      continue
    }

    try {
      const result = await deployFile(file, { force: true, record })
      if (result.status === 'conflict') {
        throw new CliError('the target still exists after being moved aside.')
      }
      output.print(`- ${file.target} ${describeDeploy(result)}`)
    } catch (error) {
      reportError(file, error)
    }
  }

  finish(failures, skippedProblems(skipped, prompts.interactive), 'Deployment finished.', ctx)
}

async function undeploy(names: string[], options: Options, ctx: Context): Promise<void> {
  const { output } = ctx
  const run = await prepare('undeploy', names, options, ctx)
  if (run == null) return

  const { files, record } = run
  let failures = run.failures

  for (const file of files) {
    try {
      const line = options.dryRun
        ? `(${await planUndeploy(file, record)})`
        : describeUndeploy(await undeployFile(file, { record }))
      output.print(`- ${file.target} ${line}`)
    } catch (error) {
      failures++
      reportFileError(file, error, ctx)
    }
  }

  finish(failures, [], options.dryRun ? 'Dry run finished.' : 'Undeployment finished.', ctx)
}

/**
 * Selects the modules and files a deploy or undeploy works on, and reports
 * modules and settings entries that are skipped (they count as failures).
 * Returns `null` when there is nothing to do.
 */
async function prepare(
  verb: 'deploy' | 'undeploy',
  names: string[],
  options: Options,
  ctx: Context,
): Promise<{ files: ModuleFile[]; failures: number; record: BackupRecord } | null> {
  const { output } = ctx
  const selected = await selectModules(verb, await loadModules(ctx), names, options, ctx)
  if (selected.length === 0) return null

  let failures = 0
  const usable: UsableModule[] = []
  for (const module of selected) {
    if (module.error != null) {
      failures++
      output.error(`Module "${module.name}" was not ${verb}ed: ${module.error}.`)
      continue
    }

    usable.push(module)
    failures += module.invalidEntries.length
    reportSettings(module, ctx)
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
        `Nothing could be ${verb}ed. ${plural(failures, 'module or settings entry')} failed.`,
      )
    output.info(`No ${options.strategy} file to ${verb} in ${moduleNames}.`)
    return null
  }

  const action = verb === 'deploy' ? 'Deploying' : 'Undeploying'
  output.info(
    options.dryRun
      ? `Dry run, nothing is changed. ${action} ${moduleNames} would do:`
      : `${action} ${moduleNames}…`,
  )
  return { files, failures, record: await BackupRecord.load(ctx.home) }
}

async function selectModules(
  verb: 'deploy' | 'undeploy',
  modules: Module[],
  names: string[],
  options: Options,
  ctx: Context,
): Promise<Module[]> {
  if (names.length > 0) {
    if (options.all) {
      throw new CliError('Give module names or --all, not both.')
    }

    const selected = pickModules(modules, names)
    const broken = selected.find(module => module.error != null)
    if (broken?.error != null) {
      throw new CliError(`Module "${broken.name}" cannot be ${verb}ed: ${broken.error}.`)
    }
    return selected
  }

  if (modules.length === 0) {
    ctx.output.info('No module found.')
    return []
  }

  if (options.all) return modules

  if (!ctx.prompts.interactive) {
    throw new CliError(`No module given. Pass module names, or --all to ${verb} every module.`)
  }

  const confirmed = await ctx.prompts.confirm({
    message: `No module given. ${verb === 'deploy' ? 'Deploy' : 'Undeploy'} all available modules?`,
    default: false,
  })
  if (!confirmed) {
    ctx.output.info(`Nothing ${verb}ed.`)
    return []
  }

  return modules
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

/** Invalid entries are errors (the file is not deployed), deprecations are warnings. */
function reportSettings(module: Module, ctx: Context): void {
  if (module.error != null) return
  for (const problem of module.invalidEntries) {
    ctx.output.error(`${module.name}: ${problem}.`)
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

function finish(failures: number, problems: string[], success: string, ctx: Context): void {
  if (failures > 0) {
    problems.push(`${plural(failures, 'file, module or settings entry')} failed.`)
  }
  if (problems.length > 0) {
    throw new CliError(problems.join(' '))
  }
  ctx.output.success(success)
}

function reportFileError(file: ModuleFile, error: unknown, ctx: Context): void {
  ctx.output.error(`${file.target}: ${(error as Error).message}`)
  if (!(error instanceof CliError) && process.env.DEBUG != null) {
    ctx.output.stderr.write(`${(error as Error).stack}\n`)
  }
}

/** What deploying would do, with the same checks as a real deployment. */
async function planDeploy(file: ModuleFile, options: Options): Promise<DeployDecision> {
  await assertSourceExists(file)
  await assertSafeTarget(file)
  return decideDeploy(await inspectFile(file), { force: options.force })
}

async function planUndeploy(file: ModuleFile, record: BackupRecord): Promise<string> {
  await assertSafeTarget(file)
  const decision = decideUndeploy(await inspectFile(file))

  switch (decision.action) {
    case 'not-deployed':
      return 'not deployed'
    case 'keep':
      return `would be kept: ${describeKept(decision.state)}`
    case 'remove': {
      const backup = await record.latest(file.target)
      if (backup == null) return 'would be removed'
      if (!backup.exists) return `would be removed; its backup ${backup.path} no longer exists`
      return `would be removed, ${backup.path} restored`
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
        ? `would be replaced, the existing one moved to ${nextBackupPath(file.target)}`
        : `would be linked, the existing ${decision.what} moved to ${nextBackupPath(file.target)}`
    case 'conflict':
      return interactive
        ? 'already exists: you would be asked whether to replace it'
        : 'already exists: would be skipped (use --force to replace it)'
  }
}

function describeState(state: TargetState): string {
  switch (state.kind) {
    case 'missing':
      return 'not deployed'
    case 'deployed':
      return 'deployed'
    case 'modified':
      return 'differs from the repository'
    case 'occupied':
      return `not deployed: a ${state.what} is in the way`
    case 'source-missing':
      return state.ours
        ? 'deployed, but its source is missing from the repository'
        : 'its source is missing from the repository'
  }
}

function describeKept(state: KeptState): string {
  switch (state.kind) {
    case 'occupied':
      return `the ${state.what} there was not deployed by configfile`
    case 'modified':
      return 'it differs from the repository (modified since it was copied?)'
    case 'source-missing':
      return 'its source is missing from the repository, so it cannot be compared'
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
    case 'removed':
      if (result.restored != null) return `(removed, ${result.restored} restored)`
      if (result.missingBackup != null) {
        return `(removed; its backup ${result.missingBackup} no longer exists, nothing restored)`
      }
      return '(removed)'
    case 'not-deployed':
      return '(not deployed)'
    case 'kept':
      return `(kept: ${describeKept(result.state)})`
  }
}
