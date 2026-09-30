import { lstatSync } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.js'
import { contains } from './paths.js'
import type { ModuleFile } from './repository.js'
import type { BackupRecord } from './state.js'

/** What is currently at the target of a module file. */
export type TargetState =
  | { kind: 'missing' }
  /** Global: the link to the source. Local: a copy identical to the source. */
  | { kind: 'deployed' }
  /** Local only: a file or folder that differs from the source. */
  | { kind: 'modified' }
  /** Global only: something that is not the link to the source. */
  | { kind: 'occupied'; what: 'file' | 'folder' | 'link' }
  /**
   * Something is at the target but the source is missing from the repository.
   * `ours`: it is the link configfile made (global files only).
   */
  | { kind: 'source-missing'; ours: boolean }

/** A target left in place by `undeploy`, and why. */
export type KeptState = Extract<TargetState, { kind: 'occupied' | 'modified' | 'source-missing' }>

export type DeployDecision =
  | { action: 'up-to-date' }
  | { action: 'create' }
  /** Move what is at the target aside, then deploy. */
  | { action: 'replace'; what: 'file' | 'folder' | 'link' | 'copy' }
  /** Local only, without `force`: the target exists and differs from the source. */
  | { action: 'conflict' }

export type UndeployDecision =
  | { action: 'remove' }
  | { action: 'not-deployed' }
  | { action: 'keep'; state: KeptState }

export type DeployResult =
  | { status: 'deployed' }
  | { status: 'up-to-date' }
  | { status: 'backed-up'; backup: string }
  | { status: 'conflict' }

export type UndeployResult =
  /** `missingBackup`: a recorded backup that was deleted since, so nothing could be restored. */
  | { status: 'removed'; restored: string | null; missingBackup: string | null }
  | { status: 'not-deployed' }
  | { status: 'kept'; state: KeptState }

/** The single place deciding what deploying a file does; dry runs use it too. */
export function decideDeploy(state: TargetState, { force }: { force: boolean }): DeployDecision {
  switch (state.kind) {
    case 'missing':
      return { action: 'create' }
    case 'deployed':
      return { action: 'up-to-date' }
    case 'occupied':
      return { action: 'replace', what: state.what }
    case 'modified':
      return force ? { action: 'replace', what: 'copy' } : { action: 'conflict' }
    case 'source-missing':
      // Deploying checks the source first, so this only happens in a race.
      throw new CliError('the source file is missing from the repository.')
  }
}

/** The single place deciding what undeploying a file does; dry runs use it too. */
export function decideUndeploy(state: TargetState): UndeployDecision {
  switch (state.kind) {
    case 'missing':
      return { action: 'not-deployed' }
    case 'deployed':
      return { action: 'remove' }
    case 'source-missing':
      return state.ours ? { action: 'remove' } : { action: 'keep', state }
    case 'occupied':
    case 'modified':
      return { action: 'keep', state }
  }
}

export async function inspectFile(file: ModuleFile): Promise<TargetState> {
  const existing = await lstatOrNull(file.target)
  if (existing == null) return { kind: 'missing' }

  const pointsToSource =
    existing.isSymbolicLink() &&
    path.resolve(path.dirname(file.target), await readlink(file.target)) === file.source

  if ((await lstatOrNull(file.source)) == null) {
    return { kind: 'source-missing', ours: file.strategy === 'global' && pointsToSource }
  }

  if (file.strategy === 'local') {
    return (await sameContent(file.source, file.target))
      ? { kind: 'deployed' }
      : { kind: 'modified' }
  }

  if (pointsToSource) return { kind: 'deployed' }
  if (existing.isSymbolicLink()) return { kind: 'occupied', what: 'link' }
  return { kind: 'occupied', what: existing.isDirectory() ? 'folder' : 'file' }
}

/**
 * Deploys a file: global files are symlinked, local files are copied.
 *
 * Anything already at the target that is not the deployed file is moved aside
 * to `<target>.old` (or `.old.1`, …) and recorded, so that `undeployFile` can
 * restore it. For local files this only happens with `force`; otherwise a
 * `conflict` is returned.
 */
export async function deployFile(
  file: ModuleFile,
  { force = false, record }: { force?: boolean; record: BackupRecord },
): Promise<DeployResult> {
  await assertSourceExists(file)
  await assertSafeTarget(file)

  const decision = decideDeploy(await inspectFile(file), { force })
  if (decision.action === 'up-to-date') return { status: 'up-to-date' }
  if (decision.action === 'conflict') return { status: 'conflict' }

  await mkdir(path.dirname(file.target), { recursive: true })

  let backup: string | null = null
  if (decision.action === 'replace') {
    backup = nextBackupPath(file.target)
    await rename(file.target, backup)
    try {
      await record.add(file.target, backup)
    } catch (error) {
      // Without a record, undeploy could not restore it: put it back and stop.
      await rename(backup, file.target).catch(() => {
        throw new CliError(`${(error as Error).message} The previous file is in ${backup}.`)
      })
      throw error
    }
  }

  try {
    if (file.strategy === 'global') {
      await symlink(file.source, file.target)
    } else {
      // verbatimSymlinks: links inside a copied folder stay identical to the source.
      await cp(file.source, file.target, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      })
    }
  } catch (error) {
    throw await undoFailedDeploy(file.target, backup, record, error)
  }

  return backup == null ? { status: 'deployed' } : { status: 'backed-up', backup }
}

/**
 * Removes a deployed file (the link, or a copy that was not modified since),
 * then puts back the most recent backup configfile made of it, if any. Other
 * `.old` files are never touched.
 */
export async function undeployFile(
  file: ModuleFile,
  { record }: { record: BackupRecord },
): Promise<UndeployResult> {
  await assertSafeTarget(file)

  const decision = decideUndeploy(await inspectFile(file))
  if (decision.action === 'not-deployed') return { status: 'not-deployed' }
  if (decision.action === 'keep') return { status: 'kept', state: decision.state }

  // Checked before removing anything, so a problem never leaves the target empty.
  const backup = await record.latest(file.target)

  await rm(file.target, { recursive: true })

  if (backup == null) return { status: 'removed', restored: null, missingBackup: null }
  if (!backup.exists) {
    await record.remove(file.target, backup.path)
    return { status: 'removed', restored: null, missingBackup: backup.path }
  }

  try {
    await rename(backup.path, file.target)
  } catch (error) {
    throw new CliError(
      `${file.target} was removed, but its backup ${backup.path} could not be put back: ` +
        `${(error as Error).message}`,
    )
  }
  await record.remove(file.target, backup.path)

  return { status: 'removed', restored: backup.path, missingBackup: null }
}

/** The name the next backup of `target` will get. */
export function nextBackupPath(target: string): string {
  // lstat (not exists) so that a broken symlink also counts as taken.
  const taken = (candidate: string) => lstatSync(candidate, { throwIfNoEntry: false }) != null

  let backup = `${target}.old`
  for (let i = 1; taken(backup); i++) {
    backup = `${target}.old.${i}`
  }
  return backup
}

/** Fails with a readable message when the source of `file` is missing or unreadable. */
export async function assertSourceExists(file: ModuleFile): Promise<void> {
  try {
    await stat(file.source)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new CliError(
      code === 'ENOENT'
        ? `Source file ${file.source} does not exist.`
        : `Cannot read source file ${file.source}: ${(error as Error).message}`,
    )
  }
}

/**
 * Refuses targets that are, through symbolic links, inside the repository or
 * one of its parents (settings are checked on paths as written; this checks
 * where they really lead). The target itself is not followed: it may be the
 * deployed link.
 */
export async function assertSafeTarget(file: ModuleFile): Promise<void> {
  const repository = await realpath(file.repository)
  const target = path.join(
    await realpathOfExisting(path.dirname(file.target)),
    path.basename(file.target),
  )

  if (contains(repository, target) || contains(target, repository)) {
    throw new CliError(
      `the target leads into the dotfiles repository (${repository}) through a symbolic link. ` +
        'Deploying there would change the repository itself.',
    )
  }
}

/** Real path of `target`, or of its closest existing parent followed by the rest. */
async function realpathOfExisting(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch (error) {
    const parent = path.dirname(target)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === target) throw error
    return path.join(await realpathOfExisting(parent), path.basename(target))
  }
}

/**
 * After a failed deployment: removes what was partly created at the target and
 * puts the backup back. Explains where things are when that is not possible.
 */
async function undoFailedDeploy(
  target: string,
  backup: string | null,
  record: BackupRecord,
  error: unknown,
): Promise<Error> {
  const reason = (error as Error).message

  // EEXIST: something else created the target meanwhile; it is not ours to remove.
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
    try {
      await rm(target, { recursive: true, force: true })
    } catch (cleanupError) {
      return new CliError(
        `${reason} A partial copy was left at ${target} (${(cleanupError as Error).message})` +
          (backup == null ? '.' : `; the previous file is in ${backup}.`),
      )
    }
  }

  if (backup == null) return new CliError(reason)

  try {
    await rename(backup, target)
    await record.remove(target, backup)
    return new CliError(reason)
  } catch (restoreError) {
    return new CliError(
      `${reason} The previous file is in ${backup} (it could not be put back: ` +
        `${(restoreError as Error).message}).`,
    )
  }
}

/** Compares files, folders (recursively) and symlinks without following links. */
async function sameContent(a: string, b: string): Promise<boolean> {
  const [statsA, statsB] = await Promise.all([lstatOrNull(a), lstatOrNull(b)])
  if (statsA == null || statsB == null) return false

  if (statsA.isSymbolicLink() || statsB.isSymbolicLink()) {
    return (
      statsA.isSymbolicLink() &&
      statsB.isSymbolicLink() &&
      (await readlink(a)) === (await readlink(b))
    )
  }

  if (statsA.isDirectory() && statsB.isDirectory()) {
    const [namesA, namesB] = await Promise.all([readdir(a), readdir(b)])
    namesA.sort()
    namesB.sort()
    if (namesA.length !== namesB.length || namesA.some((name, i) => name !== namesB[i])) {
      return false
    }
    for (const name of namesA) {
      if (!(await sameContent(path.join(a, name), path.join(b, name)))) return false
    }
    return true
  }

  if (statsA.isFile() && statsB.isFile()) {
    return statsA.size === statsB.size && (await readFile(a)).equals(await readFile(b))
  }
  return false
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
