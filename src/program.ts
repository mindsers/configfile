import { readFileSync } from 'node:fs'

import { Command, CommanderError } from 'commander'

import { registerInitCommand } from './commands/init.js'
import { registerModulesCommand } from './commands/modules.js'
import { registerScriptsCommand } from './commands/scripts.js'
import { registerUpdateCommand } from './commands/update.js'
import type { Context } from './context.js'
import { CliError, isPromptExit } from './errors.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

export function buildProgram(ctx: Context): Command {
  // showHelpAfterError, exitOverride and configureOutput are copied to
  // subcommands when they are created, so they are set before registering them.
  const program = new Command('configfile')
    .description('Manage your configuration files from a dotfiles git repository.')
    .version(pkg.version)
    .showHelpAfterError('(add --help for additional information)')
    .exitOverride()
    .configureOutput({
      writeOut: text => ctx.output.stdout.write(text),
      writeErr: text => ctx.output.stderr.write(text),
    })

  registerInitCommand(program, ctx)
  registerModulesCommand(program, ctx)
  registerScriptsCommand(program, ctx)
  registerUpdateCommand(program, ctx)

  return program
}

/** Runs the CLI with user arguments (no `node` / script path) and returns the exit code. */
export async function main(args: string[], ctx: Context): Promise<number> {
  try {
    await buildProgram(ctx).parseAsync(args, { from: 'user' })
    return 0
  } catch (error) {
    // Help, version and usage errors: commander already printed the message.
    if (error instanceof CommanderError) return error.exitCode

    if (error instanceof CliError) {
      ctx.output.error(error.message)
      return error.exitCode
    }

    if (isPromptExit(error)) {
      ctx.output.print('')
      ctx.output.info('Cancelled.')
      return 130
    }

    ctx.output.error(`Unexpected error: ${(error as Error).message ?? String(error)}`)
    if (process.env.DEBUG != null) {
      ctx.output.stderr.write(`${(error as Error).stack}\n`)
    } else {
      ctx.output.stderr.write('Run again with DEBUG=1 for details.\n')
    }
    return 1
  }
}
