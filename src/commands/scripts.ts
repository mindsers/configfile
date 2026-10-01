import type { Command } from 'commander'

import { ConfigStore } from '../config.js'
import type { Context } from '../context.js'
import { CliError } from '../errors.js'
import { plural } from '../output.js'
import { runScript } from '../process.js'
import { listScripts, type Script } from '../repository.js'

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

async function loadScripts(ctx: Context): Promise<Script[]> {
  const config = await new ConfigStore(ctx.home).read()

  return listScripts(config.folderPath, config.scriptExtensions, {
    warn: message => ctx.output.warn(message),
  })
}

async function list(ctx: Context): Promise<void> {
  const scripts = await loadScripts(ctx)

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
  const script = (await loadScripts(ctx)).find(candidate => candidate.name === name)

  if (script == null) {
    throw new CliError(
      `Script "${name}" not found. Run "configfile scripts list" to see available scripts.`,
    )
  }

  // stdout belongs to the script, so that its output can be piped or redirected.
  const output = ctx.output.toStderr()

  output.info(`Running "${name}"…`)
  const code = await runScript(script, args, ctx)
  // The arguments are never recorded: they may contain secrets.
  ctx.history.record({ kind: 'script', name: script.name, file: script.path, exitCode: code })

  if (code !== 0) {
    throw new CliError(`Script "${name}" exited with code ${code}.`, code)
  }

  output.success(`Script "${name}" finished.`)
}
