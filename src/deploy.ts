import { lstatSync } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.js'
import type { ModuleFile } from './repository.js'

/** What is currently at the target of a module file. */
export type TargetState =
  | { kind: 'missing' }
  /** Global: the link to the source. Local: a copy identical to the source. */
  | { kind: 'deployed' }
  /** Local only: a file or folder that differs from the source. */
  | { kind: 'modified' }
  /** Global only: something that is not the link to the source. */
  | { kind: 'occupied'; what: 'file' | 'folder' | 'link' }

export type DeployResult =
  | { status: 'deployed' }
  | { status: 'up-to-date' }
  | { status: 'backed-up'; backup: string }
  /** Local only, without `force`: the target exists and differs from the source. */
  | { status: 'conflict' }

export type UndeployResult =
  | { status: 'removed'; restored: string | null }
  | { status: 'not-deployed' }
  /** Left in place because configfile did not put it there, or it was modified since. */
  | { status: 'kept'; reason: string }

export async function inspectFile(file: ModuleFile): Promise<TargetState> {
  const existing = await lstatOrNull(file.target)
  if (existing == null) return { kind: 'missing' }

  if (file.strategy === 'local') {
    return (await sameContent(file.source, file.target))
      ? { kind: 'deployed' }
      : { kind: 'modified' }
  }

  if (existing.isSymbolicLink()) {
    const linkTarget = path.resolve(path.dirname(file.target), await readlink(file.target))
    return linkTarget === file.source ? { kind: 'deployed' } : { kind: 'occupied', what: 'link' }
  }
  return { kind: 'occupied', what: existing.isDirectory() ? 'folder' : 'file' }
}

/**
 * Deploys a file: global files are symlinked, local files are copied.
 *
 * Anything already at the target that is not the deployed file is moved aside
 * to `<target>.old` (or `.old.1`, …). For local files this only happens with
 * `force`; otherwise a `conflict` is returned.
 */
export async function deployFile(file: ModuleFile, { force = false } = {}): Promise<DeployResult> {
  await assertSourceExists(file)

  const state = await inspectFile(file)
  if (state.kind === 'deployed') return { status: 'up-to-date' }
  if (state.kind === 'modified' && !force) return { status: 'conflict' }

  await mkdir(path.dirname(file.target), { recursive: true })
  const backup = state.kind === 'missing' ? null : await moveAside(file.target)

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
    throw await restoreAfterFailure(file.target, backup, error)
  }

  return backup == null ? { status: 'deployed' } : { status: 'backed-up', backup }
}

/**
 * Removes a deployed file (the link, or a copy that was not modified since),
 * then puts back the most recent backup made by a deployment, if any.
 */
export async function undeployFile(file: ModuleFile): Promise<UndeployResult> {
  const state = await inspectFile(file)

  switch (state.kind) {
    case 'missing':
      return { status: 'not-deployed' }
    case 'occupied':
      return { status: 'kept', reason: `the ${state.what} there was not deployed by configfile` }
    case 'modified':
      return { status: 'kept', reason: 'it was modified since it was copied' }
    case 'deployed':
      break
  }

  await rm(file.target, { recursive: true })

  const backup = await latestBackup(file.target)
  if (backup != null) await rename(backup, file.target)

  return { status: 'removed', restored: backup }
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

/** The most recently created backup of `target` (`.old`, `.old.1`, …), or `null`. */
export async function latestBackup(target: string): Promise<string | null> {
  const dir = path.dirname(target)
  const pattern = new RegExp(`^${escapeRegExp(path.basename(target))}\\.old(\\.\\d+)?$`)

  const names = await readdir(dir).catch(() => [])
  let latest: { path: string; changed: number; number: number } | null = null

  for (const name of names) {
    const match = pattern.exec(name)
    if (match == null) continue

    const candidate = path.join(dir, name)
    // ctime changes when a file is renamed, so it tells when the backup was made.
    // The backup number only breaks ties (renames within the same millisecond).
    const changed = (await lstat(candidate)).ctimeMs
    const number = match[1] == null ? 0 : Number(match[1].slice(1))
    if (
      latest == null ||
      changed > latest.changed ||
      (changed === latest.changed && number > latest.number)
    ) {
      latest = { path: candidate, changed, number }
    }
  }

  return latest?.path ?? null
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

async function moveAside(target: string): Promise<string> {
  const backup = nextBackupPath(target)
  await rename(target, backup)
  return backup
}

/** Puts the backup back after a failed deployment, and explains where things are. */
async function restoreAfterFailure(
  target: string,
  backup: string | null,
  error: unknown,
): Promise<Error> {
  const reason = (error as Error).message
  if (backup == null) return new CliError(reason)

  try {
    await rename(backup, target)
    return new CliError(reason)
  } catch {
    return new CliError(`${reason} The previous file was moved to ${backup}.`)
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
