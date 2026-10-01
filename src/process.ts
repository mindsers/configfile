import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, open, readFile } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import path from 'node:path'

import { CliError } from './errors.ts'
import { errnoCode, lstatOrNull, messageOf } from './fsutil.ts'
import type { Script } from './repository.ts'

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
    // Installed before the child starts: a signal arriving in between would
    // otherwise end configfile and leave the script running on its own.
    let child: ChildProcess | undefined
    let pending: NodeJS.Signals | undefined
    const ignore = () => {}
    const forward = (signal: NodeJS.Signals) => {
      if (child == null) pending = signal
      else child.kill(signal)
    }
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

    try {
      child = spawn(command, args, { cwd, stdio: 'inherit' })
    } catch (error) {
      cleanup()
      reject(error)
      return
    }
    if (pending != null) child.kill(pending)

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
      return new CliError(`Cannot run script "${script.name}": ${(error as Error).message}`, {
        cause: error,
      })
  }
}

/** Returns the interpreter and its arguments from a `#!` first line, if any. */
async function readShebang(script: Script): Promise<[string, ...string[]] | null> {
  await using handle = await open(script.path, 'r').catch(error => {
    throw new CliError(`Cannot read script "${script.name}": ${(error as Error).message}`, {
      cause: error,
    })
  })

  const buffer = Buffer.alloc(512)
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
  const [firstLine = ''] = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/)

  if (!firstLine.startsWith('#!')) return null

  const [interpreter, ...interpreterArgs] = firstLine.slice(2).trim().split(/\s+/)
  return interpreter ? [interpreter, ...interpreterArgs] : null
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

/** What a command run by `capture` did. */
interface Captured {
  /** `null` when the command was stopped by a signal. */
  code: number | null
  signal: NodeJS.Signals | null
  /** It did not end within the time allowed, and was killed. */
  timedOut: boolean
  stdout: string
  stderr: string
}

/**
 * Runs a command and resolves with what it did, without showing its output.
 * Rejects when the command cannot be started (`ENOENT`, `EACCES`…). With
 * `timeoutMs`, the command is killed if it runs longer.
 */
function capture(
  command: string,
  args: string[],
  { cwd, timeoutMs }: { cwd: string; timeoutMs?: number },
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    // With a time limit, the command gets its own process group, so that
    // everything it started can be killed with it.
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: timeoutMs != null,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer =
      timeoutMs == null
        ? undefined
        : setTimeout(() => {
            timedOut = true
            try {
              if (child.pid != null) process.kill(-child.pid, 'SIGKILL')
            } catch {
              child.kill('SIGKILL')
            }
          }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut, stdout, stderr })
    })
  })
}

/** How a command that ran ended, for messages: "exit code 2" or "stopped by SIGKILL". */
function describeEnd({ code, signal }: Pick<Captured, 'code' | 'signal'>): string {
  return code == null ? `stopped by ${signal ?? 'a signal'}` : `exit code ${code}`
}

/**
 * Runs git and returns its output, without showing it. When git exits with an
 * error, fails with git's own message, or returns `null` with `allowFailure`.
 * Git that cannot be started always fails, saying why (see `startFailure`).
 */
export async function gitOutput(
  args: string[],
  { cwd, allowFailure = false }: { cwd: string; allowFailure?: boolean },
): Promise<string | null> {
  const result = await capture('git', args, { cwd }).catch(async error => {
    throw await startFailure(error, cwd)
  })

  if (result.code === 0) return result.stdout
  if (allowFailure) return null
  throw new CliError(`git ${args[0]} failed: ${result.stderr.trim() || describeEnd(result)}`)
}

/** Time allowed to `git --version`: it answers at once unless something is wrong. */
const VERSION_TIMEOUT_MS = 10_000

/**
 * Checks that git runs (`git --version`) before configfile needs it, so that
 * nothing is started with a git that cannot work. A missing git, and on macOS
 * the `/usr/bin/git` that only offers to install Apple's command line developer
 * tools, fail with how to install them on this system; any other failure with
 * git's own message. `command` and `timeoutMs` replace `git` and the time
 * allowed, for tests.
 */
export async function ensureGit({
  cwd,
  command = 'git',
  timeoutMs = VERSION_TIMEOUT_MS,
}: {
  /** An existing folder: `git --version` does not depend on it. */
  cwd: string
  command?: string
  timeoutMs?: number
}): Promise<void> {
  const result = await capture(command, ['--version'], { cwd, timeoutMs }).catch(async error => {
    throw await startFailure(error, cwd)
  })
  if (result.code === 0) return

  const output = `${result.stderr}\n${result.stdout}`.trim()
  if (result.timedOut) {
    throw new CliError(
      `git did not answer within ${timeoutMs / 1000} seconds (git --version). ` +
        'Check the git found in PATH, or reinstall it.',
    )
  }
  // What macOS's git prints when the developer tools are not installed (it may
  // also open a window offering to install them). Other xcrun errors, such as a
  // wrong DEVELOPER_DIR or a removed Xcode, are reported as they are.
  if (
    /invalid active developer path \(\/Library\/Developer\/CommandLineTools\)|No developer tools were found/.test(
      output,
    )
  ) {
    throw new CliError(
      `git needs Apple's command line developer tools (${firstLine(output)}). Install them with: ` +
        'xcode-select --install (a window offering to install them may already be open).',
    )
  }
  throw new CliError(`git does not work: ${output === '' ? describeEnd(result) : output}`)
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? ''
}

/**
 * Why git could not be started: not installed, or not executable. Node also
 * reports a missing working folder as `ENOENT`, so that is checked first.
 */
async function startFailure(error: unknown, cwd: string): Promise<Error> {
  const code = errnoCode(error)
  if (code === 'ENOENT' && (await lstatOrNull(cwd).catch(() => null)) == null) {
    return new CliError(`Cannot run git in ${cwd}: the folder does not exist.`, { cause: error })
  }
  if (code === 'ENOENT') return gitMissing()
  if (code === 'EACCES') {
    return new CliError(
      'git was found but cannot be executed (permission denied). Check the permissions of the ' +
        `git found in PATH, or reinstall git. ${gitInstallHint(process.platform, await osRelease())}`,
      { cause: error },
    )
  }
  return new CliError(`Cannot run git: ${messageOf(error)}`, { cause: error })
}

async function gitMissing(): Promise<CliError> {
  return new CliError(
    `git is not installed. ${gitInstallHint(process.platform, await osRelease())}`,
  )
}

/** How to install git on this system; `osRelease` is the content of `/etc/os-release`. */
export function gitInstallHint(platform: NodeJS.Platform, osRelease: string | null): string {
  if (platform === 'darwin') {
    return 'Install it with: xcode-select --install (or: brew install git)'
  }
  const field = (name: string) =>
    new RegExp(`^${name}=["']?([^"'\n]*)`, 'm').exec(osRelease ?? '')?.[1]?.toLowerCase() ?? ''
  const ids = [field('ID'), ...field('ID_LIKE').split(/\s+/)]
  const commands: [string[], string][] = [
    [['debian', 'ubuntu'], 'sudo apt install git'],
    [['fedora', 'rhel', 'centos'], 'sudo dnf install git'],
    [['alpine'], 'sudo apk add git'],
    [['arch'], 'sudo pacman -S git'],
    [['suse', 'opensuse'], 'sudo zypper install git'],
  ]
  const known = commands.find(([names]) => names.some(name => ids.includes(name)))
  return known == null
    ? 'Install it with the package manager of your system.'
    : `Install it with: ${known[1]}`
}

async function osRelease(): Promise<string | null> {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    const content = await readFile(file, 'utf8').catch(() => null)
    if (content != null) return content
  }
  return null
}

/** Runs git with its output shown to the user. */
export async function git(args: string[], { cwd }: { cwd: string }, label: string): Promise<void> {
  let code: number
  try {
    code = await run('git', args, { cwd })
  } catch (error) {
    throw await startFailure(error, cwd)
  }

  if (code !== 0) {
    throw new CliError(`${label} failed (exit code ${code}).`, { exitCode: code })
  }
}
