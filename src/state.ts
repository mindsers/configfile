import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.js'
import {
  type Identity,
  identityOf,
  lstatOrNull,
  messageOf,
  realpathOfExisting,
  sameIdentity,
  writeFileAtomic,
} from './fsutil.js'
import { configfilePaths } from './paths.js'

/** A file configfile moved aside, as it was when moved. */
export interface Backup {
  readonly path: string
  /** `null` only for backups recorded before 1.0 (not verifiable). */
  readonly identity: Identity | null
  readonly kind: 'file' | 'folder' | 'link' | null
}

/** What configfile put at a target. */
export interface Deployed {
  readonly strategy: 'global' | 'local'
  readonly source: string
  readonly identity: Identity
}

/** Everything configfile knows about one target. */
export interface TargetRecord {
  readonly target: string
  readonly deployed: Deployed | null
  /** Oldest first. */
  readonly backups: readonly Backup[]
}

/** On-disk shape of `~/.configfile/state.json`. Unknown keys are preserved. */
interface RawState {
  version?: number
  targets?: Record<string, TargetRecord>
  /** Version 1 (pre-1.0 development builds): backup paths per target. */
  backups?: Record<string, string[]>
  [key: string]: unknown
}

/**
 * The record of what configfile deployed and of the backups it made, stored
 * in `~/.configfile/state.json`. Undeploying only removes what is recorded
 * here (or links pointing to their source) and only restores recorded
 * backups that are unchanged.
 *
 * Changes are saved immediately; callers hold the lock (see `withLock`)
 * while they change files and this record.
 */
export class DeploymentRecord {
  readonly path: string
  #state: RawState & { targets: Record<string, TargetRecord> }

  private constructor(filePath: string, state: RawState) {
    this.path = filePath
    this.#state = { ...state, version: 2, targets: state.targets ?? {} }
  }

  static async load(home: string): Promise<DeploymentRecord> {
    const filePath = path.join(configfilePaths(home).dir, 'state.json')

    let content: string
    try {
      content = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new DeploymentRecord(filePath, {})
      }
      throw new CliError(`Cannot read ${filePath}: ${messageOf(error)}`)
    }

    let state: unknown
    try {
      state = JSON.parse(content)
    } catch (error) {
      throw new CliError(`${filePath} is not valid JSON (${messageOf(error)}).`)
    }
    if (state == null || typeof state !== 'object' || Array.isArray(state)) {
      throw new CliError(`${filePath} is not a valid configfile state file.`)
    }

    const raw = state as RawState
    if (raw.version === 2) {
      if (!isTargets(raw.targets)) {
        throw new CliError(`${filePath} is not a valid configfile state file.`)
      }
      return new DeploymentRecord(filePath, raw)
    }
    return new DeploymentRecord(filePath, migrateVersion1(raw, filePath))
  }

  /**
   * The record of `target`, found by path, or by identity when the path is
   * written differently (letter case, Unicode normalization).
   */
  async find(target: string): Promise<TargetRecord | null> {
    const exact = this.#state.targets[await keyOf(target)]
    if (exact != null) return exact

    const stats = await lstatOrNull(target)
    if (stats == null) return null
    const lowerKey = (await keyOf(target)).toLowerCase()

    for (const [key, record] of Object.entries(this.#state.targets)) {
      if (key.toLowerCase() !== lowerKey) continue
      const recorded = await lstatOrNull(record.target)
      if (recorded != null && sameIdentity(identityOf(recorded), identityOf(stats))) return record
    }
    return null
  }

  async addBackup(target: string, backup: Backup): Promise<void> {
    await this.#update(target, record => ({ ...record, backups: [...record.backups, backup] }))
  }

  async removeBackup(target: string, backupPath: string): Promise<void> {
    await this.#update(target, record => ({
      ...record,
      backups: record.backups.filter(backup => backup.path !== backupPath),
    }))
  }

  async setDeployed(target: string, deployed: Deployed | null): Promise<void> {
    await this.#update(target, record => ({ ...record, deployed }))
  }

  async #update(target: string, change: (record: TargetRecord) => TargetRecord): Promise<void> {
    const existing = await this.find(target)
    const key = existing == null ? await keyOf(target) : await keyOf(existing.target)
    const next = change(existing ?? { target, deployed: null, backups: [] })

    const targets = { ...this.#state.targets }
    if (next.deployed == null && next.backups.length === 0) {
      delete targets[key]
    } else {
      targets[key] = next
    }

    const state = { ...this.#state, version: 2, targets }
    delete state.backups
    try {
      await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      throw new CliError(`Cannot save ${this.path}: ${messageOf(error)}`)
    }
    this.#state = state
  }
}

/** Real path of the parent folder, then the name in Unicode NFC form. */
async function keyOf(target: string): Promise<string> {
  const parent = await realpathOfExisting(path.dirname(target))
  return path.join(parent, path.basename(target).normalize('NFC'))
}

function migrateVersion1(raw: RawState, filePath: string): RawState {
  const backups = raw.backups ?? {}
  const valid = Object.entries(backups).every(
    ([target, list]) =>
      path.isAbsolute(target) &&
      Array.isArray(list) &&
      list.every(item => isBackupPathOf(target, item)),
  )
  if (typeof backups !== 'object' || !valid) {
    throw new CliError(`${filePath} is not a valid configfile state file.`)
  }

  // Version 1 only existed in development builds before 1.0; its backups were
  // not identified, so they are restored if they exist.
  const targets: Record<string, TargetRecord> = {}
  for (const [target, paths] of Object.entries(backups)) {
    targets[target] = {
      target,
      deployed: null,
      backups: paths.map(backupPath => ({ path: backupPath, identity: null, kind: null })),
    }
  }
  const { backups: _, ...rest } = raw
  return { ...rest, targets }
}

function isTargets(value: unknown): value is Record<string, TargetRecord> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(
    record =>
      record != null &&
      typeof record === 'object' &&
      typeof record.target === 'string' &&
      path.isAbsolute(record.target) &&
      Array.isArray(record.backups) &&
      record.backups.every(
        (backup: unknown) =>
          backup != null &&
          typeof backup === 'object' &&
          isBackupPathOf(record.target, (backup as Backup).path),
      ),
  )
}

/**
 * Backups are always `<target>.old` or `<target>.old.<n>`: anything else in the
 * record (edited by hand, or planted) must never be restored over a target.
 */
export function isBackupPathOf(target: string, backupPath: unknown): boolean {
  if (typeof backupPath !== 'string' || !backupPath.startsWith(`${target}.old`)) return false
  const suffix = backupPath.slice(`${target}.old`.length)
  return suffix === '' || /^\.\d+$/.test(suffix)
}
