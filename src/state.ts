import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.js'

/** On-disk shape of `~/.configfile/state.json`. Unknown keys are preserved. */
interface RawState {
  /** For each target, the backups configfile made of it, oldest first. */
  backups?: Record<string, string[]>
  [key: string]: unknown
}

/**
 * The backups (`<target>.old`, …) configfile made when deploying, stored in
 * `~/.configfile/state.json`. Undeploying only restores these, never a `.old`
 * file created by someone else.
 */
export class BackupRecord {
  readonly path: string
  #state: RawState

  private constructor(filePath: string, state: RawState) {
    this.path = filePath
    this.#state = state
  }

  static async load(home: string): Promise<BackupRecord> {
    const filePath = path.join(home, '.configfile', 'state.json')

    let content: string
    try {
      content = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new BackupRecord(filePath, {})
      throw new CliError(`Cannot read ${filePath}: ${(error as Error).message}`)
    }

    let state: unknown
    try {
      state = JSON.parse(content)
    } catch (error) {
      throw new CliError(`${filePath} is not valid JSON (${(error as Error).message}).`)
    }
    const backups = (state as RawState | null)?.backups
    const valid =
      state != null &&
      typeof state === 'object' &&
      !Array.isArray(state) &&
      (backups === undefined ||
        (typeof backups === 'object' &&
          backups !== null &&
          Object.values(backups).every(
            list => Array.isArray(list) && list.every(item => typeof item === 'string'),
          )))
    if (!valid) {
      throw new CliError(`${filePath} is not a valid configfile state file.`)
    }

    return new BackupRecord(filePath, state as RawState)
  }

  /**
   * The most recent backup recorded for `target`. `exists` is `false` when the
   * backup was deleted since; other errors are thrown, so nothing is removed
   * before the backup is known to be usable.
   */
  async latest(target: string): Promise<{ path: string; exists: boolean } | null> {
    const backup = this.#state.backups?.[target]?.at(-1)
    if (backup == null) return null

    try {
      await lstat(backup)
      return { path: backup, exists: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: backup, exists: false }
      throw new CliError(`Cannot check the backup ${backup}: ${(error as Error).message}`)
    }
  }

  async add(target: string, backup: string): Promise<void> {
    const backups = { ...this.#state.backups }
    backups[target] = [...(backups[target] ?? []), backup]
    await this.#save({ ...this.#state, backups })
  }

  async remove(target: string, backup: string): Promise<void> {
    const backups = { ...this.#state.backups }
    const remaining = (backups[target] ?? []).filter(item => item !== backup)
    if (remaining.length > 0) {
      backups[target] = remaining
    } else {
      delete backups[target]
    }
    await this.#save({ ...this.#state, backups })
  }

  async #save(state: RawState): Promise<void> {
    // Written to a temporary file first, so an interruption never leaves a half-written record.
    const temporary = `${this.path}.tmp`
    try {
      await mkdir(path.dirname(this.path), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`)
      await rename(temporary, this.path)
    } catch (error) {
      throw new CliError(`Cannot save ${this.path}: ${(error as Error).message}`)
    }
    this.#state = state
  }
}
