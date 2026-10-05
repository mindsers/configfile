import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'

import { afterEach } from 'vitest'

import type { Context, Prompts } from '../src/context.ts'
import { History, type HistoryLine } from '../src/history.ts'
import { Output } from '../src/output.ts'
import { main } from '../src/program.ts'

const sandboxes: string[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

export interface Sandbox {
  root: string
  home: string
  /** Default dotfiles repository location (not created until written to). */
  repo: string
  cwd: string
  /** Writes a file relative to the sandbox root, creating parent folders. */
  write(file: string, content?: string, mode?: number): Promise<string>
  /** Writes `~/.configfilerc` pointing at `repo`. */
  configure(extra?: Record<string, unknown>): Promise<void>
}

export async function createSandbox(): Promise<Sandbox> {
  // realpath: on macOS the temp dir is a symlink, which would break path comparisons.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'configfile-test-')))
  sandboxes.push(root)

  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  await mkdir(home, { recursive: true })
  await mkdir(cwd, { recursive: true })

  const sandbox: Sandbox = {
    root,
    home,
    cwd,
    repo: path.join(home, 'dotfiles'),
    async write(file, content = '', mode) {
      const target = path.join(root, file)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
      if (mode != null) await chmod(target, mode)
      return target
    },
    async configure(extra = {}) {
      await writeFile(
        path.join(home, '.configfilerc'),
        JSON.stringify({ repo_url: null, folder_path: sandbox.repo, ...extra }),
      )
    },
  }

  return sandbox
}

class Capture extends Writable {
  text = ''

  override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.text += chunk.toString()
    callback()
  }
}

export interface FakeContext extends Context {
  stdout: Capture
  stderr: Capture
  /** Messages of the prompts that were shown, in order. */
  asked: string[]
}

export interface CliOptions {
  /** `false` simulates stdin not being a terminal. Defaults to `true`. */
  interactive?: boolean
  /** The current folder. Defaults to `<sandbox>/cwd`. */
  cwd?: string
  /** The system configfile believes it runs on. Defaults to `linux`, whatever the host. */
  platform?: NodeJS.Platform
}

/**
 * A context with captured output. `answers` are consumed in order by the
 * prompts; an unexpected prompt rejects, so the command exits with code 1 and
 * "Unexpected prompt: <message>" on stderr.
 */
export function createContext(
  sandbox: Sandbox,
  answers: Array<boolean | string | Error> = [],
  { interactive = true, cwd = sandbox.cwd, platform = 'linux' }: CliOptions = {},
): FakeContext {
  const stdout = new Capture()
  const stderr = new Capture()
  const asked: string[] = []
  const queue = [...answers]

  const answer = <T>(message: string): Promise<T> => {
    asked.push(message)
    if (queue.length === 0) {
      return Promise.reject(new Error(`Unexpected prompt: ${message}`))
    }
    const next = queue.shift()
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as T)
  }

  const prompts: Prompts = {
    interactive,
    confirm: ({ message }) => answer<boolean>(message),
    input: ({ message }) => answer<string>(message),
  }

  return {
    home: sandbox.home,
    cwd,
    platform,
    output: new Output(stdout, stderr),
    prompts,
    history: new History(sandbox.home),
    stdout,
    stderr,
    asked,
  }
}

/** Runs the CLI in-process and returns its exit code and output. */
export async function runCli(
  sandbox: Sandbox,
  args: string[],
  answers: Array<boolean | string | Error> = [],
  options: CliOptions = {},
) {
  const ctx = createContext(sandbox, answers, options)
  const code = await main(args, ctx)

  return { code, stdout: ctx.stdout.text, stderr: ctx.stderr.text, asked: ctx.asked }
}

/**
 * Runs git for test setup, independent of the developer's git configuration
 * (vitest.config.ts also points GIT_CONFIG_GLOBAL to /dev/null).
 */
export function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  )
}

/** A git repository with one commit, in `<sandbox>/remote`, to clone from. */
export async function createRemote(sandbox: Sandbox): Promise<string> {
  const remote = path.join(sandbox.root, 'remote')
  await sandbox.write('remote/files/.gitkeep')
  git(remote, 'init', '--quiet')
  git(remote, 'add', '.')
  git(remote, 'commit', '--quiet', '-m', 'first')
  return remote
}

/** Every line of the history files (rotated file first); fails on an unreadable line. */
export async function readHistory(sandbox: Sandbox): Promise<HistoryLine[]> {
  const { entries, invalid, problems } = await new History(sandbox.home).read()
  if (invalid > 0 || problems.length > 0) throw new Error(`Unreadable history: ${problems}`)
  return entries.map(entry => {
    if (entry.line == null || entry.unreadableChanges > 0)
      throw new Error(`Unreadable: ${entry.raw}`)
    return entry.line
  })
}
