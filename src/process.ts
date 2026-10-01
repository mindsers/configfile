import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, open } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import path from 'node:path'

import { CliError } from './errors.js'
import type { Script } from './repository.js'

/**
 * Runs a command with inherited stdio and resolves with its exit code.
 *
 * While it runs, Ctrl+C and Ctrl+\ are left to the child (the terminal sends
 * them to both processes) and SIGTERM / SIGHUP are forwarded to it, so the
 * child is not left running when configfile is asked to stop, and its own exit
 * code is reported. (Nothing can be done if configfile is killed with SIGKILL.)
 */
export function run(command: string, args: string[], { cwd }: { cwd: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })

    const ignore = () => {}
    const forward = (signal: NodeJS.Signals) => child.kill(signal)
    const handlers: [NodeJS.Signals, (signal: NodeJS.Signals) => void][] = [
      ['SIGINT', ignore],
      ['SIGQUIT', ignore],
      ['SIGTERM', forward],
      ['SIGHUP', forward],
    ]
    for (const [signal, handler] of handlers) process.on(signal, handler)
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
    }

    child.once('error', error => {
      cleanup()
      reject(error)
    })
    child.once('close', (code, signal) => {
      cleanup()
      if (code != null) {
        resolve(code)
        return
      }
      // Shell convention for a process killed by a signal.
      const signalNumber = signal == null ? 0 : (osConstants.signals[signal] ?? 0)
      resolve(128 + signalNumber)
    })
  })
}

/** Used for scripts that have no shebang line. */
const INTERPRETERS: Record<string, string> = {
  '.js': process.execPath,
  '.mjs': process.execPath,
  '.cjs': process.execPath,
  '.sh': 'sh',
}

/**
 * Runs a script and resolves with its exit code. The file mode is never
 * modified, so the dotfiles repository stays clean:
 * - a script with a shebang line (`#!/usr/bin/env python3`) is run directly
 *   when executable, otherwise with that interpreter (arguments of the
 *   shebang line are split on spaces);
 * - a `.js` or `.sh` script without shebang line is run with node or sh;
 * - any other executable file (such as a compiled program) is run directly.
 */
export async function runScript(
  script: Script,
  args: string[],
  { cwd }: { cwd: string },
): Promise<number> {
  const executable = await isExecutable(script.path)
  const shebang = await readShebang(script)

  const launch = async (command: string, commandArgs: string[]) => {
    try {
      return await run(command, commandArgs, { cwd })
    } catch (error) {
      throw launchError(script, shebang?.[0], error)
    }
  }

  if (shebang != null) {
    if (executable) return launch(script.path, args)

    const [interpreter, ...interpreterArgs] = shebang
    return launch(interpreter, [...interpreterArgs, script.path, ...args])
  }

  const interpreter = INTERPRETERS[path.extname(script.path)]
  if (interpreter != null) return launch(interpreter, [script.path, ...args])
  if (executable) return launch(script.path, args)

  throw new CliError(
    `Script "${script.name}" has no shebang line (such as "#!/bin/sh") and is not executable. ` +
      `Add one, or run: chmod +x "${script.path}"`,
  )
}

function launchError(script: Script, interpreter: string | undefined, error: unknown): CliError {
  switch ((error as NodeJS.ErrnoException).code) {
    case 'ENOENT':
      return new CliError(
        interpreter == null
          ? `Cannot run script "${script.name}": a program it needs is not installed.`
          : `Interpreter "${interpreter}" of script "${script.name}" not found.`,
      )
    case 'ENOEXEC':
      return new CliError(
        `Script "${script.name}" cannot be executed. Add a shebang line (such as "#!/bin/sh").`,
      )
    case 'EACCES':
      return new CliError(
        `Permission denied when running script "${script.name}" (${script.path}).`,
      )
    default:
      return new CliError(`Cannot run script "${script.name}": ${(error as Error).message}`)
  }
}

/** Returns the interpreter and its arguments from a `#!` first line, if any. */
async function readShebang(script: Script): Promise<[string, ...string[]] | null> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(script.path, 'r')
  } catch (error) {
    throw new CliError(`Cannot read script "${script.name}": ${(error as Error).message}`)
  }

  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const [firstLine = ''] = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/)

    if (!firstLine.startsWith('#!')) return null

    const [interpreter, ...interpreterArgs] = firstLine.slice(2).trim().split(/\s+/)
    return interpreter ? [interpreter, ...interpreterArgs] : null
  } finally {
    await handle.close()
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Clones `url` into `folder` with the user's own git (credentials, SSH agent…). */
export async function gitClone(
  url: string,
  folder: string,
  { cwd }: { cwd: string },
): Promise<void> {
  await git(['clone', '--', url, folder], { cwd }, 'git clone')
}

/**
 * Runs git and returns its output, without showing it. Fails with git's own
 * message unless `allowFailure` is set (then `null` is returned on failure).
 */
export async function gitOutput(
  args: string[],
  { cwd, allowFailure = false }: { cwd: string; allowFailure?: boolean },
): Promise<string | null> {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => {
        stdout += chunk
      })
      child.stderr.on('data', chunk => {
        stderr += chunk
      })
      child.once('error', error => {
        reject(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? new CliError('git is not installed or not in PATH.')
            : error,
        )
      })
      child.once('close', code => resolve({ code, stdout, stderr }))
    },
  )

  if (result.code === 0) return result.stdout
  if (allowFailure) return null
  throw new CliError(`git ${args[0]} failed: ${result.stderr.trim() || `exit code ${result.code}`}`)
}

/** Runs git with its output shown to the user. */
export async function git(args: string[], { cwd }: { cwd: string }, label: string): Promise<void> {
  let code: number
  try {
    code = await run('git', args, { cwd })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError('git is not installed or not in PATH.')
    }
    throw error
  }

  if (code !== 0) {
    throw new CliError(`${label} failed (exit code ${code}).`, code)
  }
}
