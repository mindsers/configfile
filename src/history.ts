import { constants } from 'node:fs'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'

import { type Command, CommanderError } from 'commander'

import { ConfigStore } from './config.js'
import type { KeptState } from './deploy.js'
import { CliError, isPromptExit } from './errors.js'
import { errnoCode, lstatOrNull, messageOf } from './fsutil.js'
import { redactUrl } from './output.js'
import { configfilePaths } from './paths.js'

/** At most this many changes are written per run; the rest are counted. */
const MAX_CHANGES = 1000

/** Commands that change files: each run is recorded, successful or not (dry runs excepted). */
export const RECORDED = new Set([
  'init',
  'modules deploy',
  'modules undeploy',
  'update',
  'scripts run',
])

/** Commands that change nothing: only recorded when they fail unexpectedly. */
export const READ_ONLY = new Set(['modules list', 'modules status', 'scripts list', 'history'])

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
  | { kind: 'kept'; target: string; reason: KeptState['kind'] }
  | { kind: 'failed'; target?: string; module?: string; reason: string }
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

/** One line of `history.jsonl`. */
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
      copy('local', 'all', 'force', 'dryRun')
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

/** Runs of commands that change files are recorded, and any unexpected crash. */
export function shouldRecord(invocation: Invocation | null, error: unknown): boolean {
  const changing = invocation != null && RECORDED.has(invocation.command) && !invocation.dryRun
  return changing || !isExpectedError(error)
}

/** Hides credentials in URLs (`https://user:token@host`) anywhere in a text. */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, (match, scheme, credentials) =>
    // Already hidden (by redactUrl): keep it as it is.
    /^[*:]+$/.test(credentials) ? match : `${scheme}***@`,
  )
}

/**
 * The history of what configfile changed: one JSON line per run in
 * `~/.configfile/history.jsonl`, rotated to `history.1.jsonl` when it reaches
 * its maximum size (`history_max_size` in `~/.configfilerc`; 0 turns it off).
 *
 * Commands record their changes in memory during a run; `main` saves them at
 * the end. Saving never throws: the history must never change a command's
 * result.
 */
export class History {
  readonly file: string
  readonly previousFile: string
  readonly #home: string
  readonly #maxBytes: number | undefined
  #settings: Promise<{ maxBytes: number; warning: string | null }> | undefined
  readonly #changes: Change[] = []
  #unchanged = 0
  #truncated = 0

  /** `maxBytes`: forces the size limit instead of reading it from `~/.configfilerc`. */
  constructor(home: string, { maxBytes }: { maxBytes?: number } = {}) {
    const { dir } = configfilePaths(home)
    this.#home = home
    this.#maxBytes = maxBytes
    this.file = path.join(dir, 'history.jsonl')
    this.previousFile = path.join(dir, 'history.1.jsonl')
  }

  /** The size limit (0: history turned off), and a warning when the setting is invalid. */
  settings(): Promise<{ maxBytes: number; warning: string | null }> {
    this.#settings ??=
      this.#maxBytes != null
        ? Promise.resolve({ maxBytes: this.#maxBytes, warning: null })
        : new ConfigStore(this.#home).readHistorySize()
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
        options: { ...run.invocation?.options },
        cwd: run.cwd,
        exitCode: run.exitCode,
        ...(run.error != null && { error: describeError(run.error) }),
        changes: this.#changes,
        unchanged: this.#unchanged,
        ...(this.#truncated > 0 && { truncated: this.#truncated }),
      }
      const content = Buffer.from(
        `${JSON.stringify(line, (_, value) => (typeof value === 'string' ? redactCredentials(value) : value))}\n`,
      )

      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      await this.#rotate(maxBytes)

      // One write in append mode keeps lines whole when several runs write at once.
      // O_NOFOLLOW: a symbolic link planted at the history's place is never followed.
      const handle = await open(
        this.file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        const { bytesWritten } = await handle.write(content)
        if (bytesWritten !== content.length) throw new Error('the line was only partly written')
      } finally {
        await handle.close()
      }
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  /** The last `limit` runs, oldest first, and the number of lines that could not be read. */
  async read({ limit }: { limit?: number } = {}): Promise<{
    lines: HistoryLine[]
    invalid: number
  }> {
    const lines: HistoryLine[] = []
    let invalid = 0

    for (const file of [this.previousFile, this.file]) {
      let content: string
      try {
        content = await readFile(file, 'utf8')
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') continue
        throw new CliError(`Cannot read ${file}: ${messageOf(error)}`)
      }
      for (const text of content.split('\n')) {
        if (text.trim() === '') continue
        try {
          const line = JSON.parse(text) as HistoryLine
          if (line?.v !== 1 || typeof line.time !== 'string' || !Array.isArray(line.changes)) {
            throw new Error('not a history line')
          }
          lines.push(line)
        } catch {
          invalid++
        }
      }
    }

    return { lines: limit == null ? lines : lines.slice(-limit), invalid }
  }

  async #rotate(maxBytes: number): Promise<void> {
    const stats = await lstatOrNull(this.file)
    if (stats == null || stats.size < maxBytes) return
    try {
      await rename(this.file, this.previousFile)
    } catch (error) {
      // Another configfile rotated it at the same moment.
      if (errnoCode(error) !== 'ENOENT') throw error
    }
  }
}

function describeError(error: unknown): NonNullable<HistoryLine['error']> {
  const stack = process.env.DEBUG != null && error instanceof Error ? error.stack : undefined
  return {
    message: messageOf(error),
    expected: isExpectedError(error),
    ...(stack != null && { stack }),
  }
}
