import { readFileSync } from 'node:fs'

import { Command, CommanderError } from 'commander'

import { registerHistoryCommand } from './commands/history.js'
import { registerInitCommand } from './commands/init.js'
import { registerModulesCommand } from './commands/modules.js'
import { registerScriptsCommand } from './commands/scripts.js'
import { registerUpdateCommand } from './commands/update.js'
import type { Context } from './context.js'
import { CliError, isPromptExit } from './errors.js'
import { messageOf } from './fsutil.js'
import { describeInvocation, type Invocation, shouldRecord } from './history.js'

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
  registerHistoryCommand(program, ctx)

  return program
}

/** Runs the CLI with user arguments (no `node` / script path) and returns the exit code. */
export async function main(args: string[], ctx: Context): Promise<number> {
  const time = new Date()
  let invocation: Invocation | null = null

  const program = buildProgram(ctx)
  // Runs before the action of any command, nested ones included (not for --help or usage errors).
  // A run killed by a signal (Ctrl+C outside a question) ends before its line is written.
  program.hook('preAction', (_, action) => {
    invocation = describeInvocation(action)
  })

  const { code, error } = await execute(program, args, ctx)

  if (shouldRecord(invocation, error)) {
    const failed = await ctx.history.save({
      time,
      version: pkg.version,
      invocation,
      cwd: ctx.cwd,
      exitCode: code,
      error,
    })
    const { warning } = await ctx.history.settings()
    if (warning != null) ctx.output.warn(warning)
    if (failed != null) {
      ctx.output.warn(
        `This run could not be recorded in the history: ${messageOf(failed)}. ` +
          'Fix the file, or set "history_max_size" to 0 in ~/.configfilerc to turn the history off.',
      )
    }
  }
  return code
}

/** Parses and runs the command, turning errors into messages and an exit code. */
async function execute(
  program: Command,
  args: string[],
  ctx: Context,
): Promise<{ code: number; error: unknown }> {
  try {
    await program.parseAsync(args, { from: 'user' })
    return { code: 0, error: null }
  } catch (error) {
    // Help, version and usage errors: commander already printed the message.
    if (error instanceof CommanderError) return { code: error.exitCode, error }

    if (error instanceof CliError) {
      ctx.output.error(error.message)
      return { code: error.exitCode, error }
    }

    if (isPromptExit(error)) {
      ctx.output.print('')
      ctx.output.info('Cancelled.')
      return { code: 130, error }
    }

    ctx.output.error(`Unexpected error: ${messageOf(error)}`)
    if (process.env.DEBUG != null) {
      ctx.output.stderr.write(`${(error as Error).stack}\n`)
    } else {
      ctx.output.stderr.write('Run again with DEBUG=1 for details.\n')
    }
    return { code: 1, error }
  }
}
