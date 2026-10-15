import type { Stats } from 'node:fs'
import { chmod, cp, link, mkdir, readdir, readlink, rename, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.ts'
import { checkLatestBackup, copyInto, moveAside, nextBackupPath } from './fileops.ts'
import {
  type ContentHash,
  errnoCode,
  hashFile,
  identityOf,
  kindOf,
  lstatOrNull,
  messageOf,
  removeTree,
  sameHash,
  sameIdentity,
  siblingName,
  statOrNull,
} from './fsutil.ts'
import type { RepositoryView } from './mirror.ts'
import type { Entry } from './repository.ts'
import type { CopyManifest, Deployed, DeploymentRecord, FileHash } from './state.ts'

/**
 * Global files copied into the home folder. configfile records what it
 * copied (the base) and compares three versions of each file: the base, the
 * file at the target, and the repository's version. A file changed on this
 * machine (by a tool that rewrites its configuration, or by hand) is kept; a
 * file changed in the repository, and not here, is updated; a file changed on
 * both sides is a conflict, replaced only on request, with a backup.
 *
 * A copied folder is compared file by file: files that only exist on this
 * machine (lockfiles, caches a tool creates) are never touched.
 */

/** A global file deployed by copying it, or recorded as such. */
export interface CopySubject {
  readonly source: string
  readonly target: string
  readonly entry?: Entry
}

/** What changing a file needs to check that it is the file that was read. */
interface Snapshot {
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

/** What is at a path of a copy, as read. */
export type Local =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'file'
      readonly hash: ContentHash
      readonly snapshot: Snapshot
      readonly mode: number
    }
  /**
   * Something else where a file is expected (a folder, a link). `blocked`:
   * reached through a link or a file, so configfile never acts on it.
   */
  | { readonly kind: 'other'; readonly blocked: boolean }

/**
 * What to do with one file of a copy:
 * - `create`, `update`, `delete`: follow the repository (unchanged here);
 * - `record`: the file already is the repository's version;
 * - `drop`: gone on both sides, only forgotten;
 * - `changed`: changed on this machine, and not in the repository: kept;
 * - `conflict`: changed on both sides, or something configfile did not copy
 *   is in the way: kept unless replacing is asked for.
 */
export type StepAction = 'create' | 'update' | 'delete' | 'record' | 'drop' | 'changed' | 'conflict'

export interface CopyStep {
  /** Inside the copied folder, with `/` separators; `''` for a copied file. */
  readonly path: string
  readonly action: StepAction
  readonly base: FileHash | null
  readonly repo: FileHash | null
  readonly local: Local
}

export interface CopyPlan {
  readonly folder: boolean
  readonly steps: readonly CopyStep[]
}

export type CopyState =
  | { readonly kind: 'missing' }
  /**
   * A link to the source (configfile's, or one made by hand or by 0.3), or
   * configfile's link to an old location of the repository: becomes a copy.
   */
  | { readonly kind: 'linked' }
  /**
   * Something configfile did not copy for this entry, moved aside when
   * deploying. `deployed`: it is configfile's copy for another entry.
   */
  | {
      readonly kind: 'foreign'
      readonly what: 'file' | 'folder' | 'link'
      readonly deployed: Deployed | null
    }
  /**
   * Not configfile's copy, but already the repository's version. Deploying
   * still moves it aside (as for any file configfile did not put there), so
   * that undeploying puts it back.
   */
  | { readonly kind: 'identical'; readonly what: 'file' | 'folder' }
  /**
   * configfile's copy. `adopted`: configfile linked it, and something (a tool
   * that saves by replacing the file) put a file in place of the link: the
   * repository's version is its base, so it is never overwritten unasked.
   */
  | { readonly kind: 'copy'; readonly plan: CopyPlan; readonly adopted: boolean }
  /**
   * configfile's copy of a file the repository turned into a folder, or the
   * reverse. `changed`: changed on this machine since it was copied.
   */
  | { readonly kind: 'reshaped'; readonly changed: boolean }
  | { readonly kind: 'source-missing'; readonly ours: boolean }

/** Whether a record describes what configfile deployed for this entry. */
export function isRecordFor(deployed: Deployed, file: CopySubject): boolean {
  if (deployed.strategy !== 'global') return false
  if (deployed.entry != null && file.entry != null) {
    return (
      deployed.entry.module === file.entry.module &&
      path.normalize(deployed.entry.source) === path.normalize(file.entry.source)
    )
  }
  return deployed.source === file.source
}

/** What is at the target of a global copy, and what keeping it up to date takes. */
export async function inspectCopy(
  file: CopySubject,
  record: DeploymentRecord,
  view: RepositoryView,
): Promise<CopyState> {
  const existing = await lstatOrNull(file.target)
  if (existing == null) return { kind: 'missing' }

  const known = (await record.find(file.target))?.deployed ?? null
  const ours = known != null && isRecordFor(known, file)
  const source = await statOrNull(file.source)
  if (source == null) return { kind: 'source-missing', ours }

  if (existing.isSymbolicLink()) {
    const pointsToSource =
      path.resolve(path.dirname(file.target), await readlink(file.target)) === file.source
    // configfile's own link to a location of the repository that no longer exists.
    const stale =
      ours &&
      known.copy == null &&
      sameIdentity(known.identity, identityOf(existing)) &&
      (await lstatOrNull(known.source)) == null
    if (pointsToSource || stale) return { kind: 'linked' }
    return { kind: 'foreign', what: 'link', deployed: null }
  }

  const folder = source.isDirectory()
  const sameKind = folder ? existing.isDirectory() : existing.isFile()
  if (ours && sameKind) {
    const base = known.copy ?? (await repositoryManifest(file, view, folder))
    if (base.kind === (folder ? 'folder' : 'file')) {
      const plan = await planCopy(file, view, filesOf(base), folder)
      return { kind: 'copy', plan, adopted: known.copy == null }
    }
  }
  if (
    ours &&
    known.copy != null &&
    known.copy.kind === (existing.isDirectory() ? 'folder' : 'file')
  ) {
    const undeploy = await planCopyUndeploy(file, known.copy, view)
    return { kind: 'reshaped', changed: undeploy.action === 'keep' }
  }

  if (sameKind) {
    const plan = await planCopy(file, view, {}, folder)
    if (plan.steps.every(step => step.action === 'record')) {
      return { kind: 'identical', what: folder ? 'folder' : 'file' }
    }
  }
  const othersCopy = known?.copy != null && !ours ? known : null
  return { kind: 'foreign', what: kindOf(existing), deployed: othersCopy }
}

/** The files a plan would change from the repository, keep, or leave in conflict. */
export function summarize(plan: CopyPlan): {
  outdated: string[]
  deleted: string[]
  changed: string[]
  conflicts: string[]
} {
  const paths = (...actions: StepAction[]) =>
    plan.steps.filter(step => actions.includes(step.action)).map(step => step.path)
  return {
    outdated: paths('create', 'update'),
    deleted: paths('delete'),
    changed: paths('changed'),
    conflicts: paths('conflict'),
  }
}

/** What happened to one file of a copy. */
export interface CopiedFile {
  /** Inside the copied folder, with `/` separators; `''` for a copied file. */
  readonly path: string
  /**
   * - `created`, `updated`, `deleted`: it follows the repository now;
   * - `kept`: changed on this machine, left as it is;
   * - `conflict`: changed here and in the repository, left as it is: by
   *   choice when there is no `reason`, otherwise because configfile could
   *   not replace it;
   * - `failed`: an error stopped configfile, said in `reason`.
   */
  readonly result: 'created' | 'updated' | 'deleted' | 'kept' | 'conflict' | 'failed'
  /** Where yours was moved before the repository's version replaced it. */
  readonly backup?: string
  readonly reason?: string
}

/** What applying a plan did, one entry per file that changed or was left as it is. */
export interface CopyOutcome {
  readonly files: readonly CopiedFile[]
}

/**
 * Which kept files are replaced by the repository's version (each moved aside
 * to `.old` first): none, the conflicts, or the conflicts and the files
 * changed on this machine.
 */
export type Replace = 'none' | 'conflicts' | 'all'

const BLOCKED = 'reached through a link or a file inside the copy, which configfile never follows'
const WRITTEN_MEANWHILE = 'written on this machine while configfile was running'

/** Whether `step` gets the repository's version when replacing is `replace`. */
function replaces(step: CopyStep, replace: Replace): boolean {
  return (
    (step.local.kind !== 'other' || !step.local.blocked) &&
    ((step.action === 'conflict' && replace !== 'none') ||
      (step.action === 'changed' && replace === 'all'))
  )
}

/**
 * What applying a plan would do, file by file, for a dry run: the same
 * rules as `applyCopy`, without reading anything again.
 */
export function previewCopy(file: CopySubject, plan: CopyPlan, replace: Replace): CopiedFile[] {
  const files: CopiedFile[] = []
  for (const step of plan.steps) {
    const target = pathOf(file.target, step.path)
    switch (step.action) {
      case 'record':
      case 'drop':
        break
      case 'create':
        files.push({ path: step.path, result: 'created' })
        break
      case 'update':
        files.push({ path: step.path, result: 'updated' })
        break
      case 'delete':
        files.push({ path: step.path, result: 'deleted' })
        break
      case 'changed':
      case 'conflict':
        if (replaces(step, replace)) {
          files.push({
            path: step.path,
            result:
              step.repo == null ? 'deleted' : step.local.kind === 'missing' ? 'created' : 'updated',
            ...(step.local.kind !== 'missing' && { backup: nextBackupPath(target) }),
          })
        } else if (step.action === 'changed') {
          files.push({ path: step.path, result: 'kept' })
        } else {
          const blocked = step.local.kind === 'other' && step.local.blocked
          files.push({ path: step.path, result: 'conflict', ...(blocked && { reason: BLOCKED }) })
        }
        break
    }
  }
  return files
}

/**
 * Applies a plan, then records the new base once (a crash in between is
 * recovered from: a file already updated is the repository's version).
 *
 * - New files are placed with a hard link from a temporary sibling, which
 *   fails when something appeared meanwhile; updates go through a rename.
 * - A file written on this machine since it was read is left as it is, as a
 *   conflict, even when replacing it was asked for.
 * - A file replaced by the repository's version is moved aside only once the
 *   new one is ready, and put back if the new one cannot be placed.
 * - An error on one file is reported for that file; the others go on.
 */
export async function applyCopy(
  file: CopySubject,
  plan: CopyPlan,
  {
    replace,
    record,
    always = false,
  }: {
    replace: Replace
    record: DeploymentRecord
    /** Record the base even when it did not change (it is not recorded yet). */
    always?: boolean
  },
): Promise<CopyOutcome> {
  const before = new Map(
    plan.steps.flatMap(step => (step.base == null ? [] : [[step.path, step.base] as const])),
  )
  const base = new Map(before)
  const files: CopiedFile[] = []

  // Deletions first, so that a file the repository turned into a folder can be created.
  const ordered = [...plan.steps].sort(
    (a, b) => Number(isWrite(a, replaces(a, replace))) - Number(isWrite(b, replaces(b, replace))),
  )
  for (const step of ordered) {
    const target = pathOf(file.target, step.path)
    const source = pathOf(file.source, step.path)
    const done = (result: CopiedFile['result'], extra: Omit<CopiedFile, 'path' | 'result'> = {}) =>
      files.push({ path: step.path, result, ...extra })
    try {
      switch (step.action) {
        case 'record':
          if (step.repo != null) base.set(step.path, step.repo)
          break
        case 'drop':
          base.delete(step.path)
          break
        case 'create': {
          const problem = await createFrom(source, target, file.target)
          if (problem != null) {
            done('conflict', { reason: problem })
            break
          }
          setOrDelete(base, step.path, step.repo)
          done('created')
          break
        }
        case 'update': {
          const problem = await replaceWith(source, target, step.local)
          if (problem != null) {
            done('conflict', { reason: problem })
            break
          }
          setOrDelete(base, step.path, step.repo)
          done('updated')
          break
        }
        case 'delete':
          if (!(await removeUnchanged(target, step.local, file.target))) {
            done('conflict', { reason: WRITTEN_MEANWHILE })
            break
          }
          base.delete(step.path)
          done('deleted')
          break
        case 'changed':
        case 'conflict': {
          if (!replaces(step, replace)) {
            const blocked = step.local.kind === 'other' && step.local.blocked
            if (step.action === 'changed') done('kept')
            else done('conflict', blocked ? { reason: BLOCKED } : {})
            break
          }
          const replaced = await replaceKept(step, { source, target, root: file.target, record })
          if ('reason' in replaced) {
            done('conflict', replaced)
            break
          }
          setOrDelete(base, step.path, step.repo)
          const result =
            step.repo == null ? 'deleted' : step.local.kind === 'missing' ? 'created' : 'updated'
          done(result, replaced.backup == null ? {} : { backup: replaced.backup })
          break
        }
      }
    } catch (error) {
      done('failed', { reason: messageOf(error) })
    }
  }

  if (always || !sameBase(before, base)) await recordCopy(file, plan.folder, base, record)
  return { files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }
}

/**
 * Replaces a file kept on this machine by the repository's version (or
 * deletes it, when the repository has none), moving it aside to `.old`.
 * The new file is ready before yours moves, and yours comes back if the new
 * one cannot be placed.
 */
async function replaceKept(
  step: CopyStep,
  {
    source,
    target,
    root,
    record,
  }: { source: string; target: string; root: string; record: DeploymentRecord },
): Promise<{ backup?: string } | { reason: string; backup?: string }> {
  if (step.local.kind === 'file' && !(await unchangedSince(target, step.local.snapshot))) {
    return { reason: WRITTEN_MEANWHILE }
  }
  let staged: string | null = null
  if (step.repo != null) {
    if ((await statOrNull(source)) == null) {
      return { reason: "the repository's version is missing from configfile's copy of it" }
    }
    staged = siblingName(target, 'copy')
    if (target !== root && !(await ensureFolders(root, target))) return { reason: BLOCKED }
    await cp(source, staged, { dereference: true, errorOnExist: true, force: false })
  }
  try {
    let backup: string | undefined
    if (step.local.kind !== 'missing') {
      const aside = nextBackupPath(target)
      if (await moveAside(target, aside, record)) backup = aside
    }
    if (staged == null) return backup == null ? {} : { backup }
    if (await placeNew(staged, target)) return backup == null ? {} : { backup }
    // Something appeared at its place meanwhile: yours comes back if it can.
    if (backup != null && (await lstatOrNull(target)) == null) {
      await rename(backup, target)
      await record.removeBackup(target, backup)
      return { reason: WRITTEN_MEANWHILE }
    }
    return backup == null
      ? { reason: WRITTEN_MEANWHILE }
      : { reason: `${WRITTEN_MEANWHILE}; yours is in ${backup}`, backup }
  } finally {
    if (staged != null) await rm(staged, { force: true }).catch(() => {})
  }
}

function sameBase(a: ReadonlyMap<string, FileHash>, b: ReadonlyMap<string, FileHash>): boolean {
  return a.size === b.size && [...a].every(([inner, hash]) => sameHash(hash, b.get(inner)))
}

/**
 * Copies the source to the target, which nothing occupies, and records the
 * repository's version as its base (not necessarily what was copied: see
 * `RepositoryView`). The base is read before anything is copied, and a copy
 * that cannot be recorded is removed: there is never a copy configfile
 * doesn't know about.
 */
export async function createCopy(
  file: CopySubject,
  view: RepositoryView,
  record: DeploymentRecord,
): Promise<void> {
  const { folder, manifest } = await readRepositoryVersion(file, view)
  await copyInto(file.source, file.target)
  try {
    await recordCopy(file, folder, new Map(Object.entries(filesOf(manifest))), record)
  } catch (error) {
    await removeTree(file.target).catch(() => {})
    throw error
  }
}

/** Whether the source is a folder, and the repository's version of its files. */
async function readRepositoryVersion(
  file: CopySubject,
  view: RepositoryView,
): Promise<{ folder: boolean; manifest: CopyManifest }> {
  const folder = (await statOrNull(file.source))?.isDirectory() ?? false
  return { folder, manifest: await repositoryManifest(file, view, folder) }
}

/**
 * Replaces configfile's link by a copy of what it showed, which keeps the
 * changes tools made through it: they become changes made on this machine.
 * When anything fails, the link comes back.
 */
export async function convertLink(
  file: CopySubject,
  view: RepositoryView,
  record: DeploymentRecord,
): Promise<void> {
  const { folder, manifest } = await readRepositoryVersion(file, view)
  const aside = siblingName(file.target, 'link')
  await rename(file.target, aside)
  let copied = false
  try {
    await copyInto(file.source, file.target)
    copied = true
    await recordCopy(file, folder, new Map(Object.entries(filesOf(manifest))), record)
  } catch (error) {
    // Only the copy configfile made goes: what a tool wrote there meanwhile stays.
    if (copied) await removeTree(file.target).catch(() => {})
    if ((await lstatOrNull(file.target)) == null) await rename(aside, file.target).catch(() => {})
    if ((await lstatOrNull(aside)) != null) {
      throw new CliError(`${messageOf(error)} The link could not be put back: it is in ${aside}.`, {
        cause: error,
      })
    }
    throw error
  }
  await rm(aside, { force: true })
}

// ---------------------------------------------------------------------------
// Undeploying

/** A file of a copy, as read when deciding to remove it. */
export interface ReadFile {
  readonly path: string
  readonly hash: ContentHash
  readonly snapshot: Snapshot
}

export type CopyUndeploy =
  /**
   * Nothing changed here: the whole copy can be removed, once `files` are
   * checked to be still as read (see `unchangedFiles`).
   */
  | { readonly action: 'remove'; readonly files: readonly ReadFile[] }
  /**
   * Some files stay: `changed` were changed on this machine, `others` are
   * files the record doesn't list (created by a tool, copied from files the
   * repository doesn't track, or `.old` backups). `removable`: the files
   * that can go.
   */
  | {
      readonly action: 'keep'
      readonly changed: readonly string[]
      readonly others: readonly string[]
      readonly removable: readonly ReadFile[]
    }

/**
 * What undeploying a copy can remove: files that are still configfile's base
 * or the repository's current version (when the source is gone, only the
 * base counts). Everything else stays.
 */
export async function planCopyUndeploy(
  file: CopySubject,
  manifest: CopyManifest,
  view: RepositoryView,
): Promise<CopyUndeploy> {
  const folder = manifest.kind === 'folder'
  const base = filesOf(manifest)
  const changed: string[] = []
  const removable: ReadFile[] = []
  const reader = new LocalReader(file.target)

  for (const [inner, hash] of Object.entries(base)) {
    const local = await reader.read(inner)
    if (local.kind === 'missing') continue
    const repo = await view.versionOf(pathOf(file.source, inner))
    if (local.kind === 'file' && (sameHash(local.hash, hash) || sameHash(local.hash, repo))) {
      removable.push({ path: inner, hash: local.hash, snapshot: local.snapshot })
    } else {
      changed.push(inner)
    }
  }

  const others = folder ? (await reader.files()).filter(inner => !Object.hasOwn(base, inner)) : []
  if (changed.length === 0 && others.length === 0) return { action: 'remove', files: removable }
  return { action: 'keep', changed, others, removable }
}

/**
 * Whether a copy is still as read when planning: nothing wrote to its files,
 * and, for a folder, nothing new appeared in it.
 */
export async function unchangedFiles(target: string, files: readonly ReadFile[]): Promise<boolean> {
  for (const file of files) {
    if (!(await unchangedSince(pathOf(target, file.path), file.snapshot))) return false
  }
  if (!(await lstatOrNull(target))?.isDirectory()) return true
  const now = await new LocalReader(target).files()
  return now.length === files.length
}

/**
 * Removes the files of a copy that can go (see `planCopyUndeploy`), and the
 * folders they leave empty inside the copy, then puts back the backups made
 * when they were replaced. The record keeps the files that stay. A file that
 * cannot be removed is said once the others are done.
 */
export async function removeCopiedFiles(
  file: CopySubject,
  plan: Extract<CopyUndeploy, { action: 'keep' }>,
  manifest: CopyManifest,
  record: DeploymentRecord,
): Promise<{ removed: string[]; restored: string[] }> {
  const base = new Map(Object.entries(filesOf(manifest)))
  const reader = new LocalReader(file.target)
  const removed: string[] = []
  const restored: string[] = []
  const failed: string[] = []

  for (const { path: inner, hash } of plan.removable) {
    const target = pathOf(file.target, inner)
    try {
      const local = await reader.read(inner)
      // Written since it was planned: it stays.
      if (local.kind !== 'file' || !sameHash(local.hash, hash)) continue
      if (!(await removeUnchanged(target, local, file.target))) continue
      removed.push(inner)
      base.delete(inner)

      const backup = await checkLatestBackup(target, record)
      if (backup?.status === 'ok') {
        await rename(backup.path, target)
        restored.push(inner)
      }
      if (backup != null && backup.status !== 'changed') {
        await record.removeBackup(target, backup.path)
      }
    } catch (error) {
      failed.push(`${inner} (${messageOf(error)})`)
    }
  }

  if (base.size === 0) await record.setDeployed(file.target, null)
  else await recordCopy(file, manifest.kind === 'folder', base, record)
  if (failed.length > 0) {
    throw new CliError(
      `${removed.length} files removed, but these could not be: ${failed.join(', ')}.`,
    )
  }
  return { removed, restored }
}

// ---------------------------------------------------------------------------
// Reading and comparing

/** The repository's version of every file of the source. */
async function repositoryManifest(
  file: CopySubject,
  view: RepositoryView,
  folder: boolean,
): Promise<CopyManifest> {
  if (!folder) {
    const hash = await view.versionOf(file.source)
    if (hash == null) throw new CliError(`Cannot read ${file.source}.`)
    return { kind: 'file', ...hash }
  }
  const files: [string, FileHash][] = []
  for (const inner of await view.filesUnder(file.source)) {
    const hash = await view.versionOf(pathOf(file.source, inner))
    if (hash != null) files.push([inner, hash])
  }
  // Defined, not assigned: a file named `__proto__` is a file like any other.
  return { kind: 'folder', files: Object.fromEntries(files) }
}

/** The files of a manifest by path (`''`: a copied file). */
function filesOf(manifest: CopyManifest): Record<string, FileHash> {
  if (manifest.kind === 'folder') return { ...manifest.files }
  const { kind: _, ...hash } = manifest
  return { '': hash }
}

/** Compares the base, the target and the repository's version of each file of the copy. */
async function planCopy(
  file: CopySubject,
  view: RepositoryView,
  base: Readonly<Record<string, FileHash>>,
  folder: boolean,
): Promise<CopyPlan> {
  const repoFiles = folder ? await view.filesUnder(file.source) : ['']
  const paths = [...new Set([...Object.keys(base), ...repoFiles])].sort()
  const reader = new LocalReader(file.target)

  const repoSet = new Set(repoFiles)
  const steps: CopyStep[] = []
  for (const inner of paths) {
    const repo = repoSet.has(inner) ? await view.versionOf(pathOf(file.source, inner)) : null
    const known = Object.hasOwn(base, inner) ? (base[inner] ?? null) : null
    const local = await reader.read(inner)
    const action = decide(known, repo, local)
    if (action != null) steps.push({ path: inner, action, base: known, repo, local })
  }
  return { folder, steps: reconcile(steps) }
}

/**
 * Fixes the decisions that depend on each other:
 * - a file the repository renamed by letter case only (or Unicode
 *   normalization) is one file on disks that ignore the difference: it is
 *   found at both names, and must not be deleted at the old one;
 * - the files of a folder that replaces a file the repository deletes are
 *   planned as missing, not blocked by that file (`applyCopy` deletes before
 *   it creates).
 */
function reconcile(steps: CopyStep[]): CopyStep[] {
  const deleted = new Map<number, CopyStep>()
  for (const step of steps) {
    if (step.action === 'delete' && step.local.kind === 'file') {
      deleted.set(step.local.snapshot.ino, step)
    }
  }
  const renamed = new Set<CopyStep>()
  const deletedFiles = new Set(
    steps.filter(step => step.action === 'delete').map(step => step.path),
  )

  const fixed = steps.map(step => {
    if (step.action === 'delete') return step
    // The same file under its new name: its base comes with it.
    const same = step.local.kind === 'file' ? deleted.get(step.local.snapshot.ino) : undefined
    if (same != null && same !== step && step.base == null) {
      renamed.add(same)
      const action = decide(same.base, step.repo, step.local)
      return action == null ? step : { ...step, action, base: same.base }
    }
    // Blocked by a file the repository deletes: there will be nothing there.
    const blocker = ancestorsOf(step.path).find(parent => deletedFiles.has(parent))
    // A folder whose files the repository deletes, made a file: deleting
    // them leaves nothing there (or, with files a tool made, a conflict then).
    const emptied =
      step.local.kind === 'other' &&
      !step.local.blocked &&
      [...deletedFiles].some(deleted => deleted.startsWith(`${step.path}/`))
    if ((step.local.kind === 'other' && step.local.blocked && blocker != null) || emptied) {
      const local: Local = { kind: 'missing' }
      const action = decide(step.base, step.repo, local)
      return action == null ? step : { ...step, action, local }
    }
    return step
  })
  return fixed.map(step => (renamed.has(step) ? { ...step, action: 'drop' as const } : step))
}

/** `a/b/c` → `a`, `a/b`. */
function ancestorsOf(inner: string): string[] {
  const parts = inner.split('/')
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** The three-way decision for one file; `null` for a file that only exists here. */
function decide(base: FileHash | null, repo: FileHash | null, local: Local): StepAction | null {
  const is = (hash: FileHash | null) => local.kind === 'file' && sameHash(local.hash, hash)
  if (base == null && repo == null) return null
  if (base == null) {
    if (local.kind === 'missing') return 'create'
    return is(repo) ? 'record' : 'conflict'
  }
  if (repo == null) {
    if (local.kind === 'missing') return 'drop'
    return is(base) ? 'delete' : 'conflict'
  }
  if (is(repo)) return 'record'
  if (is(base)) return 'update'
  return sameHash(repo, base) ? 'changed' : 'conflict'
}

/**
 * Reads the files of a copy without ever following a link: a path reached
 * through a link (or a file) is blocked, and configfile never acts on it.
 */
class LocalReader {
  readonly #target: string
  readonly #folders = new Map<string, Promise<'folder' | 'missing' | 'blocked'>>()

  constructor(target: string) {
    this.#target = target
  }

  async read(inner: string): Promise<Local> {
    const parent = path.posix.dirname(inner)
    if (inner !== '' && parent !== '.') {
      const state = await this.#folder(parent)
      if (state === 'missing') return { kind: 'missing' }
      if (state === 'blocked') return { kind: 'other', blocked: true }
    }
    const full = pathOf(this.#target, inner)
    const stats = await lstatOrNull(full)
    if (stats == null) return { kind: 'missing' }
    if (!stats.isFile()) return { kind: 'other', blocked: false }
    return {
      kind: 'file',
      hash: await hashFile(full, { follow: false }),
      snapshot: snapshotOf(stats),
      mode: stats.mode & 0o7777,
    }
  }

  /** The files of the copied folder, links included, never followed. */
  async files(inner = ''): Promise<string[]> {
    const folder = pathOf(this.#target, inner)
    // A folder that cannot be read is not empty: the error keeps the copy.
    const names = await readdir(folder, { withFileTypes: true }).catch((error: unknown) => {
      if (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ENOTDIR') return []
      throw error
    })
    const files: string[] = []
    for (const entry of names) {
      // A temporary file configfile left behind (a crash) is not a file of the copy.
      if (TEMPORARY.test(entry.name)) continue
      const child = inner === '' ? entry.name : `${inner}/${entry.name}`
      // Another repository's `.git` (a plugin a tool cloned) counts as one.
      if (entry.isDirectory() && entry.name !== '.git') files.push(...(await this.files(child)))
      else files.push(child)
    }
    return files
  }

  #folder(inner: string): Promise<'folder' | 'missing' | 'blocked'> {
    let state = this.#folders.get(inner)
    if (state == null) {
      state = (async () => {
        const parent = path.posix.dirname(inner)
        if (parent !== '.') {
          const above = await this.#folder(parent)
          if (above !== 'folder') return above
        }
        const stats = await lstatOrNull(pathOf(this.#target, inner))
        if (stats == null) return 'missing'
        return stats.isDirectory() ? 'folder' : 'blocked'
      })()
      this.#folders.set(inner, state)
    }
    return state
  }
}

// ---------------------------------------------------------------------------
// Changing files

/** The names `siblingName` gives to configfile's temporary files. */
const TEMPORARY = /^\..+\.configfile-[a-z]+-\d+-[0-9a-f]{8}$/

function pathOf(root: string, inner: string): string {
  return inner === '' ? root : path.join(root, ...inner.split('/'))
}

function snapshotOf(stats: Stats): Snapshot {
  return { ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs }
}

/** Whether `target` is still the file that was read: nothing wrote to it since. */
async function unchangedSince(target: string, snapshot: Snapshot): Promise<boolean> {
  const stats = await lstatOrNull(target)
  if (stats == null || !stats.isFile()) return false
  const now = snapshotOf(stats)
  return (
    now.ino === snapshot.ino &&
    now.size === snapshot.size &&
    now.mtimeMs === snapshot.mtimeMs &&
    now.ctimeMs === snapshot.ctimeMs
  )
}

function isWrite(step: CopyStep, replacing: boolean): boolean {
  return step.action === 'create' || step.action === 'update' || (replacing && step.repo != null)
}

function setOrDelete(base: Map<string, FileHash>, inner: string, hash: FileHash | null): void {
  if (hash == null) base.delete(inner)
  else base.set(inner, hash)
}

/**
 * Creates the folders above `target` inside `root`, refusing to go through
 * a link or a file: what is created never lands outside the copy.
 */
async function ensureFolders(root: string, target: string): Promise<boolean> {
  const parts = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    const stats = await lstatOrNull(current)
    if (stats == null) {
      await mkdir(current).catch(error => {
        if (errnoCode(error) !== 'EEXIST') throw error
      })
      if (!(await lstatOrNull(current))?.isDirectory()) return false
    } else if (!stats.isDirectory()) {
      return false
    }
  }
  return true
}

/**
 * Copies `source` to `target`, where nothing is: never over a file that
 * appeared meanwhile. Returns why it could not, or `null`.
 */
async function createFrom(source: string, target: string, root: string): Promise<string | null> {
  if ((await statOrNull(source)) == null) {
    return "the repository's version is missing from configfile's copy of it"
  }
  if (target !== root && !(await ensureFolders(root, target))) return BLOCKED
  const temporary = siblingName(target, 'copy')
  try {
    await cp(source, temporary, { dereference: true, errorOnExist: true, force: false })
    return (await placeNew(temporary, target)) ? null : WRITTEN_MEANWHILE
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/**
 * Moves the file `temporary` to `target` only if nothing is there: a hard
 * link fails when something is, an atomic "create, never replace". Returns
 * whether it did.
 */
async function placeNew(temporary: string, target: string): Promise<boolean> {
  try {
    await link(temporary, target)
    return true
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return false
    // A file system without hard links: checked, then renamed.
    if ((await lstatOrNull(target)) != null) return false
    await rename(temporary, target)
    return true
  }
}

/**
 * Replaces the file read as `local` by a copy of `source`, keeping its
 * permissions. Returns why it could not, or `null`.
 */
async function replaceWith(source: string, target: string, local: Local): Promise<string | null> {
  if (local.kind !== 'file') return BLOCKED
  if ((await statOrNull(source)) == null) {
    return "the repository's version is missing from configfile's copy of it"
  }
  const temporary = siblingName(target, 'copy')
  try {
    await cp(source, temporary, { dereference: true, errorOnExist: true, force: false })
    await chmod(temporary, local.mode)
    if (!(await unchangedSince(target, local.snapshot))) return WRITTEN_MEANWHILE
    await rename(temporary, target)
    return null
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/** Deletes the file read as `local` if nothing changed it since, then the folders left empty. */
async function removeUnchanged(target: string, local: Local, root: string): Promise<boolean> {
  if (local.kind !== 'file' || !(await unchangedSince(target, local.snapshot))) return false
  await rm(target)
  // Only inside the copied folder, and only folders left empty.
  let folder = path.dirname(target)
  while (target !== root && folder.startsWith(`${root}${path.sep}`)) {
    const removed = await rmdir(folder).then(
      () => true,
      () => false,
    )
    if (!removed) break
    folder = path.dirname(folder)
  }
  return true
}

/** Records the target as configfile's copy, with `base` as what it holds. */
async function recordCopy(
  file: CopySubject,
  folder: boolean,
  base: ReadonlyMap<string, FileHash>,
  record: DeploymentRecord,
): Promise<void> {
  const stats = await lstatOrNull(file.target)
  if (stats == null) {
    await record.setDeployed(file.target, null)
    return
  }
  const hash = base.get('')
  if (!folder && hash == null) {
    // Nothing configfile copied is left there.
    await record.setDeployed(file.target, null)
    return
  }
  const sorted = [...base.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const copy: CopyManifest =
    folder || hash == null
      ? { kind: 'folder', files: Object.fromEntries(sorted) }
      : { kind: 'file', ...hash }
  await record.setDeployed(file.target, {
    strategy: 'global',
    source: file.source,
    identity: identityOf(stats),
    ...(file.entry != null && { entry: file.entry }),
    copy,
  })
}

/** Removes a whole copy that nothing changed (see `planCopyUndeploy`), never through a link. */
export async function removeWholeCopy(target: string): Promise<void> {
  const aside = siblingName(target, 'undeploy')
  await rename(target, aside)
  await removeTree(aside)
}
