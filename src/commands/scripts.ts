import type { Command } from 'commander'

import { ConfigStore } from '../config.ts'
import type { Context } from '../context.ts'
import { CliError } from '../errors.ts'
import { plural } from '../output.ts'
import { runScript } from '../process.ts'
import { listScripts, type Script, systemName } from '../repository.ts'

export function registerScriptsCommand(program: Command, ctx: Context): void {
  const scripts = program
    .command('scripts')
    .alias('s')
    .description('work with the scripts of your dotfiles repository')

  scripts
    .command('list', { isDefault: true })
    .alias('l')
    .description('list available scripts')
    .action(() => list(ctx))

  scripts
    .command('run')
    .alias('r')
    .argument('<name>', 'script to run')
    .argument('[args...]', 'arguments passed to the script (put them after "--")')
    .description('run a script')
    .action((name: string, args: string[]) => run(name, args, ctx))
}

async function loadScripts(ctx: Context): Promise<{ repository: string; scripts: Script[] }> {
  const config = await new ConfigStore(ctx.home, {
    warn: message => ctx.output.warn(message),
  }).read()

  const scripts = await listScripts(config.folderPath, config.scriptExtensions, ctx.platform, {
    warn: message => ctx.output.warn(message),
  })
  return { repository: config.folderPath, scripts }
}

async function list(ctx: Context): Promise<void> {
  const { scripts } = await loadScripts(ctx)

  if (scripts.length === 0) {
    ctx.output.info('No script found.')
    return
  }

  ctx.output.print(`${plural(scripts.length, 'script')} found.`)
  for (const script of scripts) {
    ctx.output.print(`- ${script.name}`)
  }
}

async function run(name: string, args: string[], ctx: Context): Promise<void> {
  const { repository, scripts } = await loadScripts(ctx)
  const script = scripts.find(candidate => candidate.name === name)

  if (script == null) {
    throw new CliError(
      `Script "${name}" not found. Run "configfile scripts list" to see available scripts.`,
    )
  }

  // stdout belongs to the script, so that its output can be piped or redirected.
  const output = ctx.output.toStderr()

  output.info(`Running "${name}"…`)
  // So that a script finds the repository's files wherever it is, and knows
  // which system's version runs. Documented in the README ("Scripts").
  const env = {
    CONFIGFILE_REPO: repository,
    CONFIGFILE_SCRIPT: script.name,
    CONFIGFILE_OS: systemName(ctx.platform),
  }
  const code = await runScript(script, args, { cwd: ctx.cwd, env })
  // The arguments are never recorded: they may contain secrets.
  ctx.history.record({ kind: 'script', name: script.name, file: script.path, exitCode: code })

  if (code !== 0) {
    throw new CliError(`Script "${name}" exited with code ${code}.`, { exitCode: code })
  }

  output.success(`Script "${name}" finished.`)
}
