import type { Command } from 'commander'

import { ConfigStore } from '../config.js'
import type { Context } from '../context.js'
import {
  assertSourceExists,
  type DeployResult,
  deployFile,
  inspectFile,
  latestBackup,
  nextBackupPath,
  type TargetState,
  type UndeployResult,
  undeployFile,
} from '../deploy.js'
import { CliError } from '../errors.js'
import { plural } from '../output.js'
import { listModules, type Module, type ModuleFile } from '../repository.js'

interface SelectionOptions {
  local?: boolean
  all?: boolean
}

interface DeployOptions extends SelectionOptions {
  force?: boolean
  dryRun?: boolean
}

interface UndeployOptions extends SelectionOptions {
  dryRun?: boolean
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
    .action((names: string[], options: SelectionOptions) => status(names, options, ctx))

  modules
    .command('deploy')
    .alias('d')
    .argument('[modules...]', 'modules to deploy (use --all, or answer a question, when omitted)')
    .description('deploy the files of one or more modules')
    .option('-l, --local', 'copy the local files of the modules instead of linking global files')
    .option('-a, --all', 'deploy every module without asking')
    .option('-f, --force', 'replace existing local files without asking (they are moved to .old)')
    .option('-n, --dry-run', 'show what would be done, without changing anything')
    .action((names: string[], options: DeployOptions) => deploy(names, options, ctx))

  modules
    .command('undeploy')
    .alias('u')
    .argument('[modules...]', 'modules to undeploy (use --all, or answer a question, when omitted)')
    .description('remove the deployed files of one or more modules and restore their backups')
    .option('-l, --local', 'remove the local copies of the modules instead of global links')
    .option('-a, --all', 'undeploy every module without asking')
    .option('-n, --dry-run', 'show what would be done, without changing anything')
    .action((names: string[], options: UndeployOptions) => undeploy(names, options, ctx))
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
}

async function status(names: string[], options: SelectionOptions, ctx: Context): Promise<void> {
  const { output } = ctx
  const strategy = options.local === true ? 'local' : 'global'
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

    const files = module.files.filter(file => file.strategy === strategy)
    for (const file of files) {
      output.print(`  ${file.target} (${describeState(await inspectFile(file))})`)
    }
    for (const source of module.undecided) {
      output.print(`  ${source} (no deployment strategy)`)
    }
    if (files.length === 0 && module.undecided.length === 0) {
      output.print(`  no ${strategy} file`)
    }
  }
}

async function deploy(names: string[], options: DeployOptions, ctx: Context): Promise<void> {
  const { output, prompts } = ctx
  const run = await prepare('deploy', names, options, ctx)
  if (run == null) return

  const { files, failures } = run
  const force = options.force === true

  if (options.dryRun === true) {
    for (const file of files) {
      try {
        output.print(`- ${file.target} (${await planDeploy(file, force, prompts.interactive)})`)
      } catch (error) {
        failures.count++
        output.error(`${file.target}: ${(error as Error).message}`)
      }
    }
    finish(failures.count, [], 'Dry run finished.', ctx)
    return
  }

  const conflicts: ModuleFile[] = []

  const attempt = async (file: ModuleFile, forceFile: boolean) => {
    try {
      const result = await deployFile(file, { force: forceFile })
      if (result.status !== 'conflict') {
        output.print(`- ${file.target} ${describeDeploy(result)}`)
      } else if (forceFile) {
        // A forced deployment never conflicts; never let a file be dropped silently.
        throw new CliError('the target still exists after being moved aside.')
      } else {
        conflicts.push(file)
      }
    } catch (error) {
      failures.count++
      reportFileError(file, error, ctx)
    }
  }

  for (const file of files) {
    await attempt(file, force)
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

    if (replace) {
      await attempt(file, true)
    } else {
      skipped++
      output.print(`- ${file.target} (already exists, skipped)`)
    }
  }

  const problems: string[] = []
  if (!prompts.interactive && skipped > 0) {
    problems.push(`${plural(skipped, 'file')} already existed. Use --force to replace them.`)
  }
  finish(failures.count, problems, 'Deployment finished.', ctx)
}

async function undeploy(names: string[], options: UndeployOptions, ctx: Context): Promise<void> {
  const { output } = ctx
  const run = await prepare('undeploy', names, options, ctx)
  if (run == null) return

  const { files, failures } = run

  if (options.dryRun === true) {
    for (const file of files) {
      try {
        output.print(`- ${file.target} (${await planUndeploy(file)})`)
      } catch (error) {
        failures.count++
        output.error(`${file.target}: ${(error as Error).message}`)
      }
    }
    finish(failures.count, [], 'Dry run finished.', ctx)
    return
  }

  for (const file of files) {
    try {
      output.print(`- ${file.target} ${describeUndeploy(await undeployFile(file))}`)
    } catch (error) {
      failures.count++
      reportFileError(file, error, ctx)
    }
  }

  finish(failures.count, [], 'Undeployment finished.', ctx)
}

/**
 * Selects the modules and files a deploy or undeploy works on, and reports
 * modules and files that are skipped. Returns `null` when there is nothing to do.
 */
async function prepare(
  verb: 'deploy' | 'undeploy',
  names: string[],
  options: SelectionOptions & { dryRun?: boolean },
  ctx: Context,
): Promise<{ files: ModuleFile[]; failures: { count: number } } | null> {
  const { output } = ctx
  const strategy = options.local === true ? 'local' : 'global'
  const selected = await selectModules(verb, await loadModules(ctx), names, options, ctx)
  if (selected.length === 0) return null

  const failures = { count: 0 }
  for (const module of selected) {
    if (module.error != null) {
      failures.count++
      output.error(`Module "${module.name}" was not ${verb}ed: ${module.error}.`)
    }
    for (const source of module.undecided) {
      output.warn(
        `${module.name}: "${source}" was not ${verb}ed because no deployment strategy is defined. ` +
          'Set "deploy" to "global", "local" or "none" in settings.json.',
      )
    }
  }

  const files = selected.flatMap(module => module.files).filter(file => file.strategy === strategy)
  const moduleNames = selected
    .filter(module => module.error == null)
    .map(module => module.name)
    .join(', ')

  if (files.length === 0) {
    if (failures.count > 0) throw new CliError(`Nothing could be ${verb}ed.`)
    output.info(`No ${strategy} file to ${verb} in ${moduleNames}.`)
    return null
  }

  const action = verb === 'deploy' ? 'Deploying' : 'Undeploying'
  output.info(
    options.dryRun === true
      ? `Dry run, nothing is changed. ${action} ${moduleNames} would do:`
      : `${action} ${moduleNames}…`,
  )
  return { files, failures }
}

async function selectModules(
  verb: 'deploy' | 'undeploy',
  modules: Module[],
  names: string[],
  options: SelectionOptions,
  ctx: Context,
): Promise<Module[]> {
  if (names.length > 0) {
    if (options.all === true) {
      throw new CliError('Give module names or --all, not both.')
    }

    const selected = pickModules(modules, names)
    const broken = selected.find(module => module.error != null)
    if (broken != null) {
      throw new CliError(`Module "${broken.name}" cannot be ${verb}ed: ${broken.error}.`)
    }
    return selected
  }

  if (modules.length === 0) {
    ctx.output.info('No module found.')
    return []
  }

  if (options.all === true) return modules

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

/** The modules named on the command line, in that order. Fails on unknown names. */
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

function finish(failures: number, problems: string[], success: string, ctx: Context): void {
  if (failures > 0) {
    problems.push(`${plural(failures, 'file or module')} failed.`)
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

async function planDeploy(file: ModuleFile, force: boolean, interactive: boolean) {
  await assertSourceExists(file)
  const state = await inspectFile(file)
  const verb = file.strategy === 'global' ? 'linked' : 'copied'

  switch (state.kind) {
    case 'missing':
      return `would be ${verb}`
    case 'deployed':
      return 'already up to date'
    case 'occupied':
      return `would be linked, the existing ${state.what} moved to ${nextBackupPath(file.target)}`
    case 'modified':
      if (force)
        return `would be replaced, the existing one moved to ${nextBackupPath(file.target)}`
      return interactive
        ? 'already exists: you would be asked whether to replace it'
        : 'already exists: would be skipped (use --force to replace it)'
  }
}

async function planUndeploy(file: ModuleFile) {
  const state = await inspectFile(file)

  switch (state.kind) {
    case 'missing':
      return 'not deployed'
    case 'occupied':
      return `would be kept: the ${state.what} there was not deployed by configfile`
    case 'modified':
      return 'would be kept: it was modified since it was copied'
    case 'deployed': {
      const backup = await latestBackup(file.target)
      return backup == null ? 'would be removed' : `would be removed, ${backup} restored`
    }
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
    case 'occupied':
      return `not deployed: a ${state.what} is in the way`
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
      return result.restored == null ? '(removed)' : `(removed, ${result.restored} restored)`
    case 'not-deployed':
      return '(not deployed)'
    case 'kept':
      return `(kept: ${result.reason})`
  }
}
