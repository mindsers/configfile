import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Command, CommanderError } from 'commander'
import { describe, expect, it } from 'vitest'

import { CliError } from '../src/errors.js'
import {
  describeInvocation,
  History,
  type Invocation,
  parseHistoryLine,
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

/** The lines `history.read()` returns, written in the current format. */
async function linesOf(history: History, options?: { limit?: number }) {
  return (await history.read(options)).entries.map(entry => entry.line)
}

/** Number of lines in a history file. */
async function countLines(file: string): Promise<number> {
  return (await readFile(file, 'utf8')).split('\n').filter(line => line !== '').length
}

describe('History', () => {
  it('appends one line per run, in a private file', async () => {
    const { home } = await createSandbox()
    const first = new History(home)
    first.record({ kind: 'deployed', how: 'link', source: '/s', target: '/t' })
    first.unchanged()
    await expect(first.save(run())).resolves.toBeNull()
    await expect(new History(home).save(run({ exitCode: 3 }))).resolves.toBeNull()

    const lines = await linesOf(new History(home))
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
    const lines = await linesOf(history)
    expect(lines.length).toBeLessThan(6)
    expect(lines.at(-1)?.exitCode).toBe(6)
  })

  it('rotates once the file has reached the limit, not before', async () => {
    const { home } = await createSandbox()
    await new History(home).save(run({ exitCode: 1 }))
    const { size } = await stat(new History(home).file)

    await new History(home, { maxBytes: size + 1 }).save(run({ exitCode: 2 }))
    expect(existsSync(new History(home).previousFile)).toBe(false)

    await new History(home, { maxBytes: size * 2 }).save(run({ exitCode: 3 }))
    const history = new History(home)
    expect(await countLines(history.previousFile)).toBe(2)
    expect(await countLines(history.file)).toBe(1)
  })

  it('never loses the rotated file when several runs rotate at once', async () => {
    const { home } = await createSandbox()
    const history = new History(home)
    for (let i = 0; i < 40; i++) await history.save(run({ exitCode: i }))
    const { size } = await stat(history.file)

    // One rotation is due; the 20 new lines then fit under the limit.
    await Promise.all(
      Array.from({ length: 20 }, () => new History(home, { maxBytes: size }).save(run())),
    )

    expect(await countLines(history.previousFile)).toBeGreaterThanOrEqual(40)
    expect((await countLines(history.previousFile)) + (await countLines(history.file))).toBe(60)
  })

  it('skips rotating while another run rotates, and clears a rotation lock left behind', async () => {
    const { home } = await createSandbox()
    const history = new History(home)
    await history.save(run())
    const lock = path.join(path.dirname(history.file), 'history.rotating')
    await writeFile(lock, '')

    await new History(home, { maxBytes: 1 }).save(run())
    expect(existsSync(history.previousFile)).toBe(false)
    expect(await countLines(history.file)).toBe(2)

    const old = new Date(Date.now() - 5 * 60_000)
    await utimes(lock, old, old)
    await new History(home, { maxBytes: 1 }).save(run())
    await new History(home, { maxBytes: 1 }).save(run())
    expect(existsSync(lock)).toBe(false)
    expect(await countLines(history.previousFile)).toBe(3)
  })

  it('keeps the next line whole after a line left unfinished', async () => {
    const { home } = await createSandbox()
    const history = new History(home)
    await mkdir(path.dirname(history.file), { recursive: true })
    await writeFile(history.file, '{"v":1,"time":"2026')

    await history.save(run({ exitCode: 7 }))

    const { entries, invalid } = await history.read()
    expect(invalid).toBe(1)
    expect(entries.map(entry => entry.line?.exitCode)).toEqual([7])
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

  it('never rotates or reads through a symbolic link planted at the history', async () => {
    const { home, root } = await createSandbox()
    const history = new History(home, { maxBytes: 1 })
    await mkdir(path.dirname(history.file), { recursive: true })
    await writeFile(path.join(root, 'victim'), `${JSON.stringify({ v: 1 })}\n`)
    await symlink(path.join(root, 'victim'), history.file)

    await expect(history.save(run())).resolves.toBeInstanceOf(Error)
    const { entries, problems } = await history.read()

    expect((await lstat(history.file)).isSymbolicLink()).toBe(true)
    expect(existsSync(history.previousFile)).toBe(false)
    expect(entries).toEqual([])
    expect(problems).toEqual([expect.stringContaining('symbolic link')])
  })

  it('still reads the current file when the previous one cannot be read', async () => {
    const { home } = await createSandbox()
    const history = new History(home)
    await history.save(run({ exitCode: 5 }))
    await mkdir(history.previousFile)

    const { entries, problems } = await history.read()

    expect(entries.map(entry => entry.line?.exitCode)).toEqual([5])
    expect(problems).toEqual([expect.stringContaining(history.previousFile)])
  })

  it('refuses an invalid size limit', () => {
    expect(() => new History('/home', { maxBytes: -1 })).toThrow(RangeError)
    expect(() => new History('/home', { maxBytes: 1.5 })).toThrow(RangeError)
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
      module: 'zsh',
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

    const lines = await linesOf(new History(home))
    expect(lines[0]?.error).toEqual({ message: 'boom', expected: false })
    expect(lines[1]?.error?.stack).toContain('Error: boom')
  })

  it('keeps at most 1000 changes per run and counts the others', async () => {
    const { home } = await createSandbox()
    const history = new History(home)
    for (let i = 0; i < 1005; i++)
      history.record({ kind: 'skipped', target: `/t${i}`, reason: 'exists' })

    await history.save(run())

    const [line] = await linesOf(new History(home))
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

    expect(result.entries.map(entry => entry.line?.exitCode)).toEqual([2, 3])
    expect(result.invalid).toBe(1)
  })
})

describe('parseHistoryLine', () => {
  const valid = {
    v: 1,
    time: '2026-10-01T09:00:00.000Z',
    durationMs: 3,
    pid: 1,
    version: '1.0.0',
    command: 'update',
    options: {},
    cwd: '/work',
    exitCode: 0,
    changes: [],
    unchanged: 0,
  }
  const parse = (value: unknown) => parseHistoryLine(JSON.stringify(value))

  it('reads a valid line', () => {
    expect(parse(valid)).toMatchObject({ line: valid, unreadableChanges: 0 })
  })

  it.each([
    ['not an object', [1]],
    ['no version', { ...valid, v: undefined }],
    ['an older version', { ...valid, v: 0 }],
    ['options missing', { ...valid, options: undefined }],
    ['options null', { ...valid, options: null }],
    ['a time that is not text', { ...valid, time: 3 }],
    ['an exit code that is not a number', { ...valid, exitCode: '1' }],
    ['an error message that is not text', { ...valid, error: { message: 1, expected: true } }],
    ['changes that are not a list', { ...valid, changes: {} }],
    ['a negative unchanged count', { ...valid, unchanged: -1 }],
  ])('refuses a line with %s', (_, value) => {
    expect(parse(value)).toBeNull()
  })

  it('keeps lines written in a newer format, without reading them', () => {
    expect(parse({ v: 2, anything: true })).toEqual({
      raw: JSON.stringify({ v: 2, anything: true }),
      line: null,
      unreadableChanges: 0,
    })
  })

  it('skips changes it cannot read and counts them', () => {
    const entry = parse({
      ...valid,
      changes: [
        null,
        { kind: 'future-kind' },
        { kind: 'kept', target: '/t', reason: 'future-reason' },
        { kind: 'synced', folder: '/f', upstream: 'origin/main', from: 1, to: 2 },
        { kind: 'failed', reason: 'neither a target nor a module' },
        { kind: 'saved-patch', file: '/p' },
      ],
    })

    expect(entry?.line?.changes).toEqual([{ kind: 'saved-patch', file: '/p' }])
    expect(entry?.unreadableChanges).toBe(5)
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
  const promptExit = () => Object.assign(new Error('closed'), { name: 'ExitPromptError' })
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
    [
      'Ctrl+C at a question of a read-only command',
      invocation('modules status'),
      promptExit(),
      false,
    ],
    [
      'Ctrl+C at a question of a command that changes files',
      invocation('update'),
      promptExit(),
      true,
    ],
    ['a command missing from the table', invocation('future command'), null, true],
    ['an unexpected error before any command', null, new TypeError('x'), true],
  ])('%s: %s', (_, inv, error, expected) => {
    expect(shouldRecord(inv, error)).toBe(expected)
  })
})

describe('redactCredentials', () => {
  it.each([
    ['clone https://user:token@github.com/a/b failed', 'clone https://***@github.com/a/b failed'],
    ['ssh://git@host:22/r', 'ssh://git@host:22/r'],
    ['ssh://git:secret@host/r', 'ssh://***@host/r'],
    ['https://TOKEN@github.com/a/b', 'https://***@github.com/a/b'],
    ['HTTPS://U:T@host/r', 'HTTPS://***@host/r'],
    ['https://user:p@ss@host/r', 'https://***@host/r'],
    [
      "Cloning into 'https://a:one@h/r'... fatal: 'https://b:two@h/r'",
      "Cloning into 'https://***@h/r'... fatal: 'https://***@h/r'",
    ],
    ['https://***:***@host/r', 'https://***:***@host/r'],
    ['https://host/r.git?private_token=SECRET&x=1', 'https://host/r.git?private_token=***&x=1'],
    ['https://host/r?access_token=SECRET', 'https://host/r?access_token=***'],
    ['https://host/r?page=2', 'https://host/r?page=2'],
    ['no url here', 'no url here'],
    ['https://github.com/a/b', 'https://github.com/a/b'],
  ])('%s', (text, expected) => {
    expect(redactCredentials(text)).toBe(expected)
  })
})
