import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Command, CommanderError } from 'commander'
import { describe, expect, it } from 'vitest'

import { CliError } from '../src/errors.js'
import {
  describeInvocation,
  History,
  type Invocation,
  redactCredentials,
  shouldRecord,
} from '../src/history.js'
import { createSandbox } from './helpers.js'

const run = (overrides: Partial<Parameters<History['save']>[0]> = {}) => ({
  time: new Date('2026-10-01T09:00:00.000Z'),
  version: '1.0.0',
  invocation: { command: 'modules deploy', options: { modules: ['zsh'] }, dryRun: false },
  cwd: '/work',
  exitCode: 0,
  error: null,
  ...overrides,
})

describe('History', () => {
  it('appends one line per run, in a private file', async () => {
    const { home } = await createSandbox()
    const first = new History(home)
    first.record({ kind: 'deployed', how: 'link', source: '/s', target: '/t' })
    first.unchanged()
    await expect(first.save(run())).resolves.toBeNull()
    await expect(new History(home).save(run({ exitCode: 3 }))).resolves.toBeNull()

    const { lines } = await new History(home).read()
    expect(lines).toMatchObject([
      {
        v: 1,
        command: 'modules deploy',
        options: { modules: ['zsh'] },
        exitCode: 0,
        changes: [{ kind: 'deployed', how: 'link', source: '/s', target: '/t' }],
        unchanged: 1,
        pid: process.pid,
        version: '1.0.0',
      },
      { exitCode: 3, changes: [], unchanged: 0 },
    ])
    expect((await stat(first.file)).mode & 0o777).toBe(0o600)
    expect((await stat(path.dirname(first.file))).mode & 0o777).toBe(0o700)
  })

  it('rotates the file when it reaches its maximum size, keeping one previous file', async () => {
    const { home } = await createSandbox()
    const save = (exitCode: number) => new History(home, { maxBytes: 300 }).save(run({ exitCode }))

    for (const exitCode of [1, 2, 3, 4, 5, 6]) await save(exitCode)

    const history = new History(home)
    const current = (await readFile(history.file, 'utf8')).trim().split('\n')
    const previous = (await readFile(history.previousFile, 'utf8')).trim().split('\n')
    expect(current.length).toBeGreaterThan(0)
    expect(previous.length).toBeGreaterThan(0)
    // The oldest lines were dropped by the second rotation; the newest is last.
    const { lines } = await history.read()
    expect(lines.length).toBeLessThan(6)
    expect(lines.at(-1)?.exitCode).toBe(6)
  })

  it('writes nothing when turned off', async () => {
    const { home } = await createSandbox()
    const history = new History(home, { maxBytes: 0 })

    await expect(history.save(run())).resolves.toBeNull()

    await expect(stat(history.file)).rejects.toThrow()
  })

  it('never follows a symbolic link planted at the history', async () => {
    const { home, root } = await createSandbox()
    const history = new History(home)
    await mkdir(path.dirname(history.file), { recursive: true })
    await writeFile(path.join(root, 'victim'), 'untouched')
    await symlink(path.join(root, 'victim'), history.file)

    await expect(history.save(run())).resolves.toBeInstanceOf(Error)
    expect(await readFile(path.join(root, 'victim'), 'utf8')).toBe('untouched')
  })

  it('returns the error instead of throwing when it cannot write', async () => {
    const { home } = await createSandbox()
    const history = new History(home)
    await mkdir(history.file, { recursive: true })

    await expect(history.save(run())).resolves.toBeInstanceOf(Error)
  })

  it('hides credentials anywhere in the line', async () => {
    const { home } = await createSandbox()
    const history = new History(home)
    history.record({
      kind: 'failed',
      reason: "fatal: could not read from 'https://user:ghp_SECRET@github.com/a/b.git'",
    })

    await history.save(run({ error: new CliError('git clone https://x:tok@host/r failed') }))

    const text = await readFile(history.file, 'utf8')
    expect(text).not.toContain('ghp_SECRET')
    expect(text).not.toContain('tok@')
  })

  it('records unexpected errors, with the stack only when DEBUG is set', async () => {
    const { home } = await createSandbox()
    await new History(home).save(run({ exitCode: 1, error: new Error('boom') }))
    process.env.DEBUG = '1'
    try {
      await new History(home).save(run({ exitCode: 1, error: new Error('boom') }))
    } finally {
      delete process.env.DEBUG
    }

    const { lines } = await new History(home).read()
    expect(lines[0]?.error).toEqual({ message: 'boom', expected: false })
    expect(lines[1]?.error?.stack).toContain('Error: boom')
  })

  it('keeps at most 1000 changes per run and counts the others', async () => {
    const { home } = await createSandbox()
    const history = new History(home)
    for (let i = 0; i < 1005; i++)
      history.record({ kind: 'skipped', target: `/t${i}`, reason: 'exists' })

    await history.save(run())

    const [line] = (await new History(home).read()).lines
    expect(line?.changes).toHaveLength(1000)
    expect(line?.truncated).toBe(5)
  })

  it('keeps every line whole when many runs write at once', async () => {
    const { home } = await createSandbox()

    await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const history = new History(home, { maxBytes: 4096 })
        history.record({ kind: 'script', name: `s${i}`, file: `/scripts/s${i}`, exitCode: 0 })
        return history.save(run({ exitCode: i }))
      }),
    )

    // read() counts any line that does not parse as invalid.
    const { invalid } = await new History(home).read()
    expect(invalid).toBe(0)
  })

  it('reads the last runs, oldest first, skipping unreadable lines', async () => {
    const { home } = await createSandbox()
    for (const exitCode of [1, 2, 3]) await new History(home).save(run({ exitCode }))
    const history = new History(home)
    await writeFile(history.file, `${await readFile(history.file, 'utf8')}not json\n`)

    const result = await history.read({ limit: 2 })

    expect(result.lines.map(line => line.exitCode)).toEqual([2, 3])
    expect(result.invalid).toBe(1)
  })
})

describe('describeInvocation', () => {
  /** Parses `args` with a program shaped like configfile's, returning the invocation. */
  async function invocationOf(args: string[]): Promise<Invocation | null> {
    let invocation: Invocation | null = null
    const program = new Command('configfile').exitOverride()
    program.hook('preAction', (_, action) => {
      invocation = describeInvocation(action)
    })
    program
      .command('init')
      .option('-f, --force')
      .option('--repo <url>')
      .option('--folder <path>')
      .action(() => {})
    const modules = program.command('modules').alias('m')
    modules
      .command('deploy')
      .alias('d')
      .argument('[modules...]')
      .option('-l, --local')
      .option('-n, --dry-run')
      .action(() => {})
    program
      .command('scripts')
      .command('run')
      .argument('<name>')
      .argument('[args...]')
      .action(() => {})
    await program.parseAsync(args, { from: 'user' })
    return invocation
  }

  it('names the command whatever alias was typed', async () => {
    await expect(invocationOf(['m', 'd', 'zsh', '-l'])).resolves.toEqual({
      command: 'modules deploy',
      options: { modules: ['zsh'], local: true },
      dryRun: false,
    })
  })

  it('marks dry runs', async () => {
    await expect(invocationOf(['modules', 'deploy', '-n'])).resolves.toMatchObject({
      dryRun: true,
    })
  })

  it('never keeps script arguments, only their number', async () => {
    const invocation = await invocationOf(['scripts', 'run', 'setup', '--', 'token=s3cr3t', 'x'])

    expect(invocation?.options).toEqual({ script: 'setup', argCount: 2 })
    expect(JSON.stringify(invocation)).not.toContain('s3cr3t')
  })

  it('hides credentials of the repository URL', async () => {
    const invocation = await invocationOf(['init', '--repo', 'https://me:tok@host/r.git'])

    expect(invocation?.options).toEqual({ repo: 'https://***:***@host/r.git' })
  })
})

describe('shouldRecord', () => {
  const invocation = (command: string, dryRun = false): Invocation => ({
    command,
    options: {},
    dryRun,
  })

  it.each([
    ['a command that changes files', invocation('modules deploy'), null, true],
    ['the same command failing', invocation('update'), new CliError('x'), true],
    ['a dry run', invocation('modules undeploy', true), null, false],
    ['a read-only command', invocation('modules status'), null, false],
    [
      'an expected error of a read-only command',
      invocation('scripts list'),
      new CliError('x'),
      false,
    ],
    [
      'an unexpected error of a read-only command',
      invocation('modules list'),
      new Error('x'),
      true,
    ],
    ['help or a usage error', null, new CommanderError(1, 'c', 'm'), false],
    ['an unexpected error before any command', null, new TypeError('x'), true],
  ])('%s: %s', (_, inv, error, expected) => {
    expect(shouldRecord(inv, error)).toBe(expected)
  })
})

describe('redactCredentials', () => {
  it.each([
    ['clone https://user:token@github.com/a/b failed', 'clone https://***@github.com/a/b failed'],
    ['ssh://git@host:22/r', 'ssh://***@host:22/r'],
    ['no url here', 'no url here'],
    ['https://github.com/a/b', 'https://github.com/a/b'],
  ])('%s', (text, expected) => {
    expect(redactCredentials(text)).toBe(expected)
  })
})
