import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { type Command, CommanderError } from 'commander'

import { ConfigStore, DEFAULT_HISTORY_SIZE } from './config.ts'
import type { KeptState } from './deploy.ts'
import { CliError, isPromptExit } from './errors.ts'
import { errnoCode, lstatOrNull, messageOf } from './fsutil.ts'
import { redactUrl } from './output.ts'
import { configfilePaths } from './paths.ts'

/** At most this many changes are written per run; the rest are counted. */
const MAX_CHANGES = 1000

/** A rotation lock older than this was left by a configfile that died while rotating. */
const STALE_ROTATION_MS = 60_000

/**
 * Every command, and whether its runs are recorded: commands that change files
 * are recorded successful or not (dry runs excepted); read-only ones only when
 * they fail unexpectedly. A command missing here is recorded.
 */
export const COMMANDS = {
  init: 'recorded',
  'modules deploy': 'recorded',
  'modules undeploy': 'recorded',
  update: 'recorded',
  'scripts run': 'recorded',
  'modules list': 'read-only',
  'modules status': 'read-only',
  'scripts list': 'read-only',
  history: 'read-only',
} as const satisfies Record<string, 'recorded' | 'read-only'>

/** Why undeploy kept a file, as written in the history. */
export type KeptReason = KeptState['kind']

/** One thing configfile did (or failed to do) during a run. */
export type Change =
  | { kind: 'deployed'; how: 'link' | 'copy'; source: string; target: string; backup?: string }
  | { kind: 'skipped'; target: string; reason: 'exists' }
  | {
      kind: 'removed'
      target: string
      backup?: { path: string; status: 'restored' | 'missing' | 'changed' }
      leftover?: string
    }
  /** `forgotten`: configfile stopped tracking it (its entry left the repository). */
  | { kind: 'kept'; target: string; reason: KeptReason; forgotten?: true }
  | { kind: 'failed'; target: string; reason: string }
  | { kind: 'failed'; module: string; reason: string }
  | { kind: 'synced'; folder: string; upstream: string; from: string | null; to: string }
  | { kind: 'saved-patch'; file: string }
  | { kind: 'script'; name: string; file: string; exitCode: number }
  | { kind: 'cloned' | 'reused'; repository: string; folder: string }
  | { kind: 'configured'; file: string }

/** The command a run executed, with the options worth recording. */
export interface Invocation {
  readonly command: string
  readonly options: Readonly<Record<string, unknown>>
  readonly dryRun: boolean
}

/**
 * One line of `history.jsonl`. Version 1: later 1.x releases may add change
 * kinds and optional fields (readers skip what they do not know); any other
 * change gets a new `v`.
 */
export interface HistoryLine {
  v: 1
  time: string
  durationMs: number
  pid: number
  version: string
  command: string | null
  options: Record<string, unknown>
  cwd: string
  exitCode: number
  error?: { message: string; expected: boolean; stack?: string }
  changes: Change[]
  unchanged: number
  truncated?: number
}

/** A line read back from the history. */
export interface HistoryEntry {
  /** The line as written. */
  readonly raw: string
  /** `null` when the line was written in a newer format (another `v`). */
  readonly line: HistoryLine | null
  /** Changes that could not be read: unknown kinds (from a newer 1.x) or damaged ones. */
  readonly unreadableChanges: number
}

/** The size limit of the history (0: turned off), and a warning about its setting. */
export interface HistorySettings {
  readonly maxBytes: number
  readonly warning: string | null
}

/** The full name of the command that runs, whatever alias was typed (`m d` → `modules deploy`). */
export function commandPath(action: Command): string {
  const names: string[] = []
  for (let command: Command | null = action; command?.parent != null; command = command.parent) {
    names.unshift(command.name())
  }
  return names.join(' ')
}

/**
 * The command and its options. Options are copied from an allowlist per
 * command, never from the raw arguments: script arguments, for example, can
 * contain secrets, so only their number is kept.
 */
export function describeInvocation(action: Command): Invocation {
  const command = commandPath(action)
  const given = action.opts() as Record<string, unknown>
  const args = action.processedArgs as unknown[]
  const options: Record<string, unknown> = {}
  const copy = (...names: string[]) => {
    for (const name of names) {
      if (given[name] !== undefined) options[name] = given[name]
    }
  }

  switch (command) {
    case 'init':
      copy('force', 'folder')
      if (typeof given.repo === 'string') options.repo = redactUrl(given.repo)
      break
    case 'modules deploy':
    case 'modules undeploy':
    case 'modules status':
      options.modules = Array.isArray(args[0]) ? args[0] : []
      copy('local', 'all', 'force', 'dryRun', 'removed')
      break
    case 'scripts run':
      options.script = args[0]
      options.argCount = Array.isArray(args[1]) ? args[1].length : 0
      break
    case 'history':
      copy('limit', 'json')
      break
  }

  return { command, options, dryRun: given.dryRun === true }
}

/** Errors users are told about by design, as opposed to crashes. */
export function isExpectedError(error: unknown): boolean {
  return (
    error == null ||
    error instanceof CliError ||
    error instanceof CommanderError ||
    isPromptExit(error)
  )
}

/**
 * Runs of commands that change files are recorded, and any unexpected crash.
 * Usage errors and `--help` never reach a command, so `invocation` is `null`
 * and they are not recorded.
 */
export function shouldRecord(invocation: Invocation | null, error: unknown): boolean {
  const changing =
    invocation != null &&
    !invocation.dryRun &&
    (COMMANDS as Record<string, string>)[invocation.command] !== 'read-only'
  return changing || !isExpectedError(error)
}

const SSH_SCHEMES = new Set(['ssh://', 'git+ssh://', 'ssh+git://'])

/**
 * Hides credentials anywhere in a text: the user info of URLs
 * (`https://user:token@host`; a lone ssh user name such as `git` is kept, as
 * in `redactUrl`) and query parameters that look like secrets (`?token=…`).
 */
export function redactCredentials(text: string): string {
  return text
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]+)@/gi,
      (match, scheme: string, userInfo: string) => {
        // Already hidden (by redactUrl), or an ssh user name: keep it as it is.
        if (/^[*:]+$/.test(userInfo)) return match
        if (SSH_SCHEMES.has(scheme.toLowerCase()) && !/[:@]/.test(userInfo)) return match
        return `${scheme}***@`
      },
    )
    .replace(
      /([?&][^=\s&#]*(?:token|key|secret|passw(?:or)?d|auth|signature|sig)[^=\s&#]*=)[^\s&#'"]+/gi,
      '$1***',
    )
}

/**
 * The history of what configfile changed: one JSON line per run in
 * `~/.configfile/history.jsonl`. Before a write, once the file has reached its
 * maximum size (`history_max_size` in `~/.configfilerc`; 0 turns it off), it
 * is renamed to `history.1.jsonl`, replacing the previous one.
 *
 * Commands record their changes in memory during a run; `main` saves them at
 * the end. Saving never throws: the history must never change a command's
 * result.
 *
 * Known limits: on NFS, appends from several machines can interleave; a run
 * killed by a signal (Ctrl+C outside a question) writes no line.
 */
export class History {
  readonly file: string
  readonly previousFile: string
  readonly #rotationLock: string
  readonly #home: string
  readonly #maxBytes: number | undefined
  #settings: Promise<HistorySettings> | undefined
  readonly #changes: Change[] = []
  readonly #options: Record<string, unknown> = {}
  #unchanged = 0
  #truncated = 0

  /** `maxBytes`: forces the size limit instead of reading it from `~/.configfilerc`. */
  constructor(home: string, { maxBytes }: { maxBytes?: number } = {}) {
    if (maxBytes != null && !(Number.isSafeInteger(maxBytes) && maxBytes >= 0)) {
      throw new RangeError(`maxBytes must be a positive integer or 0, not ${maxBytes}`)
    }
    const { dir } = configfilePaths(home)
    this.#home = home
    this.#maxBytes = maxBytes
    this.file = path.join(dir, 'history.jsonl')
    this.previousFile = path.join(dir, 'history.1.jsonl')
    this.#rotationLock = path.join(dir, 'history.rotating')
  }

  /** The size limit (0: history turned off), and a warning when the setting is invalid. */
  settings(): Promise<HistorySettings> {
    this.#settings ??=
      this.#maxBytes != null
        ? Promise.resolve({ maxBytes: this.#maxBytes, warning: null })
        : new ConfigStore(this.#home).readHistorySize().catch(error => ({
            maxBytes: DEFAULT_HISTORY_SIZE,
            warning: `Cannot read "history_max_size": ${messageOf(error)}; using 1MB.`,
          }))
    return this.#settings
  }

  record(change: Change): void {
    if (this.#changes.length < MAX_CHANGES) {
      this.#changes.push(change)
    } else {
      this.#truncated++
    }
  }

  /** Counts a file that was already as expected (nothing changed). */
  unchanged(): void {
    this.#unchanged++
  }

  /** Records an option decided during the run, such as `all` when confirmed at a question. */
  option(name: string, value: unknown): void {
    this.#options[name] = value
  }

  /** Appends the line of this run. Returns the error instead of throwing it. */
  async save(run: {
    time: Date
    version: string
    invocation: Invocation | null
    cwd: string
    exitCode: number
    error: unknown
  }): Promise<Error | null> {
    try {
      const { maxBytes } = await this.settings()
      if (maxBytes === 0) return null

      const line: HistoryLine = {
        v: 1,
        time: run.time.toISOString(),
        durationMs: Date.now() - run.time.getTime(),
        pid: process.pid,
        version: run.version,
        command: run.invocation?.command ?? null,
        options: { ...run.invocation?.options, ...this.#options },
        cwd: run.cwd,
        exitCode: run.exitCode,
        ...(run.error != null && { error: describeError(run.error) }),
        changes: this.#changes,
        unchanged: this.#unchanged,
        ...(this.#truncated > 0 && { truncated: this.#truncated }),
      }
      const text = `${JSON.stringify(line, (_, value) => (typeof value === 'string' ? redactCredentials(value) : value))}\n`

      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      await this.#rotate(maxBytes)
      await this.#append(text)
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * The last `limit` lines, oldest first, the number of lines that could not
   * be read, and the files that could not be read at all.
   */
  async read({ limit }: { limit?: number } = {}): Promise<{
    entries: HistoryEntry[]
    invalid: number
    problems: string[]
  }> {
    if (limit != null && !(Number.isSafeInteger(limit) && limit > 0)) {
      throw new RangeError(`limit must be a positive integer, not ${limit}`)
    }
    const entries: HistoryEntry[] = []
    const problems: string[] = []
    let invalid = 0

    for (const file of [this.previousFile, this.file]) {
      let content: string
      try {
        content = await readRegularFile(file)
      } catch (error) {
        if (errnoCode(error) !== 'ENOENT') problems.push(`Cannot read ${file}: ${messageOf(error)}`)
        continue
      }
      for (const raw of content.split('\n')) {
        if (raw.trim() === '') continue
        const entry = parseHistoryLine(raw)
        if (entry == null) {
          invalid++
        } else {
          entries.push(entry)
        }
      }
    }

    return { entries: limit == null ? entries : entries.slice(-limit), invalid, problems }
  }

  /**
   * One write in append mode keeps lines whole when several runs write at
   * once. O_NOFOLLOW: a symbolic link planted at the history's place is never
   * followed.
   */
  async #append(text: string): Promise<void> {
    const handle = await open(
      this.file,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    )
    // Not `await using`: when both fail, the write error must be the one reported.
    let failure: unknown = null
    try {
      // A line left unfinished (a full disk, for example) must not swallow this one.
      const { size } = await handle.stat()
      const last = Buffer.alloc(1)
      if (size > 0) await handle.read(last, 0, 1, size - 1)
      const content = Buffer.from(size > 0 && last[0] !== 0x0a ? `\n${text}` : text)
      const { bytesWritten } = await handle.write(content)
      if (bytesWritten !== content.length) throw new Error('the line was only partly written')
    } catch (error) {
      failure = error
    }
    try {
      await handle.close()
    } catch (error) {
      failure ??= error
    }
    if (failure != null) throw failure
  }

  /**
   * Renames a full history to `history.1.jsonl`. Runs rotating at the same
   * moment would otherwise rename each other's new file over the previous
   * one, so rotation takes a small lock of its own (not the deploy lock, so
   * no command ever waits for it): a run that cannot take it skips rotating,
   * and the size is checked again once the lock is held.
   */
  async #rotate(maxBytes: number): Promise<void> {
    if (!(await this.#isFull(maxBytes))) return

    let lock: Awaited<ReturnType<typeof open>>
    try {
      lock = await open(this.#rotationLock, 'wx', 0o600)
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error
      // Left by a configfile that died while rotating: remove it, the next run rotates.
      const stats = await lstatOrNull(this.#rotationLock)
      if (stats != null && Date.now() - stats.mtimeMs > STALE_ROTATION_MS) {
        await rm(this.#rotationLock, { force: true })
      }
      return
    }

    try {
      if (await this.#isFull(maxBytes)) await rename(this.file, this.previousFile)
    } finally {
      await lock.close()
      await rm(this.#rotationLock, { force: true })
    }
  }

  /** Only a regular file is rotated: a link or a folder in its place is left for `open` to refuse. */
  async #isFull(maxBytes: number): Promise<boolean> {
    const stats = await lstatOrNull(this.file)
    return stats?.isFile() === true && stats.size >= maxBytes
  }
}

/** Reads a file without following a symbolic link in its place. */
async function readRegularFile(file: string): Promise<string> {
  await using handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if (errnoCode(error) === 'ELOOP') throw new Error('it is a symbolic link, not a file')
    throw error
  })
  if (!(await handle.stat()).isFile()) throw new Error('it is not a file')
  return await handle.readFile('utf8')
}

/**
 * Parses one line of the history, checking its shape: a hand-edited, damaged
 * or newer line never reaches code that expects a valid one. `null` when the
 * line cannot be read.
 */
export function parseHistoryLine(raw: string): HistoryEntry | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(value) || typeof value.v !== 'number') return null
  if (value.v !== 1) {
    return value.v > 1 ? { raw, line: null, unreadableChanges: 0 } : null
  }

  const { error, changes } = value
  const valid =
    typeof value.time === 'string' &&
    typeof value.durationMs === 'number' &&
    typeof value.pid === 'number' &&
    typeof value.version === 'string' &&
    (value.command === null || typeof value.command === 'string') &&
    isObject(value.options) &&
    typeof value.cwd === 'string' &&
    Number.isInteger(value.exitCode) &&
    (error === undefined ||
      (isObject(error) &&
        typeof error.message === 'string' &&
        typeof error.expected === 'boolean' &&
        (error.stack === undefined || typeof error.stack === 'string'))) &&
    Array.isArray(changes) &&
    isCount(value.unchanged) &&
    (value.truncated === undefined || isCount(value.truncated))
  if (!valid) return null

  const readable = changes.filter(isChange)
  return {
    raw,
    line: { ...(value as unknown as HistoryLine), changes: readable },
    unreadableChanges: changes.length - readable.length,
  }
}

const KEPT_REASONS: Record<KeptReason, true> = {
  foreign: true,
  modified: true,
  identical: true,
  'source-missing': true,
}

function isChange(value: unknown): value is Change {
  if (!isObject(value)) return false
  const { backup } = value
  switch (value.kind) {
    case 'deployed':
      return (
        (value.how === 'link' || value.how === 'copy') &&
        areStrings(value.source, value.target) &&
        (backup === undefined || typeof backup === 'string')
      )
    case 'skipped':
      return typeof value.target === 'string' && value.reason === 'exists'
    case 'removed':
      return (
        typeof value.target === 'string' &&
        (backup === undefined ||
          (isObject(backup) &&
            typeof backup.path === 'string' &&
            ['restored', 'missing', 'changed'].includes(backup.status as string))) &&
        (value.leftover === undefined || typeof value.leftover === 'string')
      )
    case 'kept':
      return (
        typeof value.target === 'string' &&
        Object.hasOwn(KEPT_REASONS, value.reason as string) &&
        (value.forgotten === undefined || value.forgotten === true)
      )
    case 'failed':
      return (
        typeof value.reason === 'string' &&
        (typeof value.target === 'string') !== (typeof value.module === 'string')
      )
    case 'synced':
      return (
        areStrings(value.folder, value.upstream, value.to) &&
        (value.from === null || typeof value.from === 'string')
      )
    case 'saved-patch':
    case 'configured':
      return typeof value.file === 'string'
    case 'script':
      return areStrings(value.name, value.file) && Number.isInteger(value.exitCode)
    case 'cloned':
    case 'reused':
      return areStrings(value.repository, value.folder)
    default:
      return false
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function areStrings(...values: unknown[]): boolean {
  return values.every(value => typeof value === 'string')
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function describeError(error: unknown): NonNullable<HistoryLine['error']> {
  const stack = process.env.DEBUG != null && error instanceof Error ? error.stack : undefined
  return {
    message: messageOf(error),
    expected: isExpectedError(error),
    ...(stack != null && { stack }),
  }
}
