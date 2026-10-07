import { lstatSync } from 'node:fs'
import { cp, mkdir, open, readdir, readlink, realpath, rename, rm, symlink } from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.ts'
import {
  type Identity,
  identityOf,
  kindOf,
  lstatOrNull,
  messageOf,
  realpathOfExisting,
  removeTree,
  sameIdentity,
  siblingName,
  statOrNull,
} from './fsutil.ts'
import { configfilePaths, contains } from './paths.ts'
import type { RecordedFile } from './removed.ts'
import type { ModuleFile } from './repository.ts'
import { type Backup, type DeploymentRecord, isBackupPathOf } from './state.ts'

/**
 * A file undeploy can work on: a file of a module, or one the repository no
 * longer deploys, rebuilt from the record. Only module files can be deployed.
 */
export type UndeployableFile = ModuleFile | RecordedFile

/** What is currently at the target of a module file, and whose it is. */
export type TargetState =
  | { kind: 'missing' }
  /**
   * Global: a link to the source. Local: an unmodified copy configfile made.
   * `recorded`: false for links made before 1.0 (adopted when deploying).
   */
  | { kind: 'deployed'; recorded: boolean }
  /** Local: a copy configfile made, modified since. */
  | { kind: 'modified' }
  /** Local: identical to the source, but not copied by configfile. */
  | { kind: 'identical' }
  /** Global: the link configfile made, pointing to an old location of the source. */
  | { kind: 'stale' }
  /** Something configfile did not put there. */
  | { kind: 'foreign'; what: 'file' | 'folder' | 'link' }
  /** Something is there but the source is missing. `ours`: configfile put it there. */
  | { kind: 'source-missing'; ours: boolean }

export type DeployDecision =
  | { action: 'up-to-date' }
  | { action: 'create' }
  /** Move what is at the target aside (recorded as a backup), then deploy. */
  | { action: 'replace'; what: 'file' | 'folder' | 'link' | 'copy'; backup: string }
  /** Replace configfile's own outdated link; nothing is backed up. */
  | { action: 'refresh' }
  /** The target exists and differs; replaced only with `force`. */
  | { action: 'conflict' }

export type KeptState = Extract<
  TargetState,
  { kind: 'modified' | 'identical' | 'foreign' | 'source-missing' }
>

/** The backup undeploy would put back, and whether it can. */
export type BackupCheck = { path: string; status: 'ok' | 'missing' | 'changed' }

export type UndeployDecision =
  | { action: 'remove'; backup: BackupCheck | null }
  | { action: 'not-deployed' }
  | { action: 'keep'; state: KeptState }

export type DeployResult =
  | { status: 'deployed' }
  | { status: 'up-to-date' }
  | { status: 'backed-up'; backup: string }
  | { status: 'conflict' }

export type UndeployResult =
  | {
      status: 'removed'
      /** The backup that was checked (restored when its status is `ok`), or `null`. */
      backup: BackupCheck | null
      /** A removed copy that could not be deleted, left at this path. */
      leftover: string | null
    }
  | { status: 'not-deployed' }
  | { status: 'kept'; state: KeptState }

/** What deploying and undeploying need besides the file itself. */
export interface DeployContext {
  readonly record: DeploymentRecord
  readonly guard: Guard
}

// ---------------------------------------------------------------------------
// Inspecting and deciding (shared by dry runs and real runs)

export async function inspectFile(
  file: Pick<ModuleFile, 'source' | 'target' | 'strategy'>,
  record: DeploymentRecord,
): Promise<TargetState> {
  const existing = await lstatOrNull(file.target)
  if (existing == null) return { kind: 'missing' }

  const recorded = (await record.find(file.target))?.deployed
  const recordedHere = sameIdentity(recorded?.identity, identityOf(existing))
  const pointsToSource =
    existing.isSymbolicLink() &&
    path.resolve(path.dirname(file.target), await readlink(file.target)) === file.source
  const sourceExists = (await lstatOrNull(file.source)) != null

  if (file.strategy === 'global') {
    if (!sourceExists) return { kind: 'source-missing', ours: pointsToSource || recordedHere }
    if (pointsToSource) return { kind: 'deployed', recorded: recordedHere }
    // Our own link, to a source that no longer exists (the repository moved).
    // A link to another existing source (another module) is not ours to replace.
    const recordedSourceGone =
      recorded != null &&
      recorded.source !== file.source &&
      (await lstatOrNull(recorded.source)) == null
    if (recordedHere && existing.isSymbolicLink() && recordedSourceGone) return { kind: 'stale' }
    return { kind: 'foreign', what: kindOf(existing) }
  }

  if (!sourceExists) return { kind: 'source-missing', ours: false }
  const same = await sameContent(file.source, file.target)
  if (recordedHere) return same ? { kind: 'deployed', recorded: true } : { kind: 'modified' }
  return same ? { kind: 'identical' } : { kind: 'foreign', what: kindOf(existing) }
}

/** What deploying `file` would do. Runs every check a real deployment runs. */
export async function planDeploy(
  file: ModuleFile,
  { force, record, guard }: DeployContext & { force: boolean },
): Promise<DeployDecision> {
  await assertUsableSource(file)
  await guard.check(file)

  const state = await inspectFile(file, record)
  switch (state.kind) {
    case 'missing':
      return { action: 'create' }
    case 'deployed':
    case 'identical':
      return { action: 'up-to-date' }
    case 'stale':
      return { action: 'refresh' }
    case 'modified':
      return force
        ? { action: 'replace', what: 'copy', backup: nextBackupPath(file.target) }
        : { action: 'conflict' }
    case 'foreign':
      if (file.strategy === 'local' && !force) return { action: 'conflict' }
      return { action: 'replace', what: state.what, backup: nextBackupPath(file.target) }
    case 'source-missing':
      // assertUsableSource checked the source: it disappeared meanwhile.
      throw new CliError('the source file is missing from the repository.')
  }
}

/** What undeploying `file` would do. Runs every check a real undeployment runs. */
export async function planUndeploy(
  file: UndeployableFile,
  { record, guard }: DeployContext,
): Promise<UndeployDecision> {
  await guard.check(file)

  const state = await inspectFile(file, record)
  switch (state.kind) {
    case 'missing':
      return { action: 'not-deployed' }
    case 'deployed':
    case 'stale':
      return { action: 'remove', backup: await checkLatestBackup(file.target, record) }
    case 'source-missing':
      return state.ours && file.strategy === 'global'
        ? { action: 'remove', backup: await checkLatestBackup(file.target, record) }
        : { action: 'keep', state }
    case 'modified':
    case 'identical':
    case 'foreign':
      return { action: 'keep', state }
  }
}

// ---------------------------------------------------------------------------
// Deploying and undeploying (callers hold the lock, see `withLock`)

/**
 * Deploys a file: global files are symlinked, local files are copied (links
 * followed, so the copy never points into the repository).
 *
 * Anything in the way that configfile did not put there is moved aside to
 * `<target>.old` (or `.old.1`, …) and recorded before it is moved, so that
 * `undeployFile` can restore it. For local files this only happens with
 * `force`; otherwise a `conflict` is returned.
 */
export async function deployFile(
  file: ModuleFile,
  context: DeployContext & { force?: boolean },
): Promise<DeployResult> {
  const { record } = context
  const decision = await planDeploy(file, { ...context, force: context.force ?? false })

  if (decision.action === 'conflict') return { status: 'conflict' }
  if (decision.action === 'up-to-date') {
    // Adopt links made before 1.0, so that undeploy knows they are ours, and
    // complete records made before entries were kept.
    const stats = await lstatOrNull(file.target)
    const known = (await record.find(file.target))?.deployed
    const ours = stats != null && sameIdentity(known?.identity, identityOf(stats))
    if (
      (!ours && stats != null && file.strategy === 'global') ||
      (ours && known?.entry == null && file.entry != null)
    ) {
      await recordDeployed(file, record)
    }
    return { status: 'up-to-date' }
  }

  await mkdir(path.dirname(file.target), { recursive: true })

  if (decision.action === 'refresh') {
    await rm(file.target)
  }

  let backup: string | null = null
  if (decision.action === 'replace') {
    backup = decision.backup
    await moveAside(file.target, backup, record)
  }

  try {
    if (file.strategy === 'global') {
      await symlink(file.source, file.target)
    } else {
      await copyInto(file.source, file.target)
    }
  } catch (error) {
    throw await putBackAfterFailure(file.target, backup, record, error)
  }

  await recordDeployed(file, record)
  return backup == null ? { status: 'deployed' } : { status: 'backed-up', backup }
}

/**
 * Removes what configfile deployed (its link, or its copy when unmodified),
 * then puts back the most recent backup it made, if that backup is unchanged.
 * Nothing configfile did not create is ever removed.
 */
export async function undeployFile(
  file: UndeployableFile,
  context: DeployContext,
): Promise<UndeployResult> {
  const { record } = context
  const decision = await planUndeploy(file, context)

  if (decision.action === 'not-deployed') return { status: 'not-deployed' }
  if (decision.action === 'keep') return { status: 'kept', state: decision.state }

  // Moved aside first: if the backup cannot be put back, the deployed file returns.
  const removed = siblingName(file.target, 'undeploy')
  await rename(file.target, removed)

  const { backup } = decision
  if (backup?.status === 'ok') {
    try {
      await rename(backup.path, file.target)
    } catch (error) {
      await rename(removed, file.target).catch(() => {})
      throw new CliError(`Cannot put the backup ${backup.path} back: ${messageOf(error)}`, {
        cause: error,
      })
    }
  }

  await record.setDeployed(file.target, null)
  if (backup != null && backup.status !== 'changed') {
    await record.removeBackup(file.target, backup.path)
  }

  let leftover: string | null = null
  try {
    await removeTree(removed)
  } catch {
    leftover = removed
  }
  return { status: 'removed', backup, leftover }
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

// ---------------------------------------------------------------------------
// Safety checks

/**
 * The source must exist and really be inside its module folder, links
 * included: a repository must not be able to deploy files from elsewhere
 * (for example `~/.ssh`). Links inside a local folder are checked too, since
 * copies follow them.
 */
export async function assertUsableSource(file: ModuleFile): Promise<void> {
  const stats = await statOrNull(file.source).catch(error => {
    throw new CliError(`Cannot read source file ${file.source}: ${messageOf(error)}`, {
      cause: error,
    })
  })
  if (stats == null) throw new CliError(`Source file ${file.source} does not exist.`)

  const module = await realpath(file.module)
  const assertInside = async (link: string) => {
    const real = await realpath(link).catch(() => null)
    if (real == null) throw new CliError(`${link} is a broken symbolic link.`)
    if (!contains(module, real)) {
      throw new CliError(`${link} leads outside the module folder (${real}).`)
    }
  }

  await assertInside(file.source)
  if (file.strategy === 'local' && stats.isDirectory()) {
    await walkLinks(await realpath(file.source), assertInside)
  }
}

/**
 * Visits every link of `folder`, following links to folders. A link to a
 * folder containing it would make the copy endless, so it is refused.
 */
async function walkLinks(folder: string, visit: (link: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const entryPath = path.join(folder, entry.name)
    if (entry.isSymbolicLink()) {
      await visit(entryPath)
      const real = await realpath(entryPath)
      if ((await statOrNull(real))?.isDirectory()) {
        if (contains(real, folder)) {
          throw new CliError(`${entryPath} leads to a folder containing it, which makes a loop.`)
        }
        await walkLinks(real, visit)
      }
    } else if (entry.isDirectory()) {
      await walkLinks(entryPath, visit)
    }
  }
}

/**
 * Refuses targets that are, by identity (whatever their letter case or the
 * links used to reach them), the home folder, the current folder, the
 * repository, the module, configfile's own files, one of their parents, or
 * inside the repository, the module or configfile's working folder.
 */
export class Guard {
  readonly #home: string
  readonly #cwd: string
  readonly #ancestors = new Map<string, Promise<Map<string, string>>>()

  constructor({ home, cwd }: { home: string; cwd: string }) {
    this.#home = home
    this.#cwd = cwd
  }

  async check(file: UndeployableFile): Promise<void> {
    const own = configfilePaths(this.#home)
    const stats = await lstatOrNull(file.target)

    if (stats != null && !stats.isSymbolicLink()) {
      const replaced = [
        [this.#home, 'the home folder'],
        [this.#cwd, 'the current folder'],
        [file.repository, 'the dotfiles repository'],
        ...(file.module == null ? [] : [[file.module, 'the module folder'] as const]),
        [own.dir, "configfile's working folder"],
        [own.rc, "configfile's configuration"],
      ] as const
      for (const [protectedPath, label] of replaced) {
        const ancestors = await this.#ancestorsOf(protectedPath)
        if (ancestors.has(key(identityOf(stats)))) {
          throw new CliError(`the target would replace ${label} (${protectedPath}).`)
        }
      }
    }

    const parents = await this.#ancestorsOf(path.dirname(file.target))
    for (const [protectedPath, label] of [
      [file.repository, 'the dotfiles repository'],
      ...(file.module == null ? [] : [[file.module, 'the module folder'] as const]),
      [own.dir, "configfile's working folder"],
    ] as const) {
      const identity = await statOrNull(protectedPath)
      if (identity != null && parents.has(key(identityOf(identity)))) {
        throw new CliError(
          `the target is inside ${label} (${protectedPath}), possibly through a symbolic link.`,
        )
      }
    }
  }

  /** Identities of `target` (links followed) and of all its parents, up to `/`. */
  #ancestorsOf(target: string): Promise<Map<string, string>> {
    let cached = this.#ancestors.get(target)
    if (cached == null) {
      cached = (async () => {
        const identities = new Map<string, string>()
        let current = await realpathOfExisting(target)
        for (;;) {
          const stats = await statOrNull(current)
          if (stats != null) identities.set(key(identityOf(stats)), current)
          const parent = path.dirname(current)
          if (parent === current) return identities
          current = parent
        }
      })()
      this.#ancestors.set(target, cached)
    }
    return cached
  }
}

function key(identity: Identity): string {
  return `${identity.dev}:${identity.ino}`
}

// ---------------------------------------------------------------------------
// File operations

async function recordDeployed(file: ModuleFile, record: DeploymentRecord): Promise<void> {
  const stats = await lstatOrNull(file.target)
  if (stats == null) return
  await record.setDeployed(file.target, {
    strategy: file.strategy,
    source: file.source,
    identity: identityOf(stats),
    ...(file.entry != null && { entry: file.entry }),
  })
}

/** Records the backup first, so that a crash never leaves an unknown `.old` file. */
async function moveAside(target: string, backup: string, record: DeploymentRecord): Promise<void> {
  const stats = await lstatOrNull(target)
  if (stats == null) return
  await record.addBackup(target, {
    path: backup,
    identity: identityOf(stats),
    kind: kindOf(stats),
    modified: stats.mtimeMs,
  })
  try {
    await rename(target, backup)
  } catch (error) {
    await record.removeBackup(target, backup)
    throw error
  }
}

/** Copies through a temporary sibling, so an interrupted copy never sits at the target. */
async function copyInto(source: string, target: string): Promise<void> {
  const temporary = siblingName(target, 'copy')
  try {
    await cp(source, temporary, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    })
    await rename(temporary, target)
  } catch (error) {
    await removeTree(temporary).catch(() => {})
    throw error
  }
}

/** After a failed deployment, puts the backup back and explains where things are. */
async function putBackAfterFailure(
  target: string,
  backup: string | null,
  record: DeploymentRecord,
  error: unknown,
): Promise<Error> {
  const reason = messageOf(error)
  if (backup == null) return new CliError(reason)

  try {
    await rename(backup, target)
    await record.removeBackup(target, backup)
    return new CliError(reason)
  } catch (restoreError) {
    return new CliError(
      `${reason} The previous file is in ${backup} (it could not be put back: ` +
        `${messageOf(restoreError)}).`,
      { cause: restoreError },
    )
  }
}

/** The most recent recorded backup of `target`, and whether it can be restored as is. */
async function checkLatestBackup(
  target: string,
  record: DeploymentRecord,
): Promise<BackupCheck | null> {
  const backup: Backup | undefined = (await record.find(target))?.backups.at(-1)
  if (backup == null || !isBackupPathOf(target, backup.path)) return null

  const stats = await lstatOrNull(backup.path).catch(error => {
    throw new CliError(`Cannot check the backup ${backup.path}: ${messageOf(error)}`, {
      cause: error,
    })
  })
  if (stats == null) return { path: backup.path, status: 'missing' }
  const replaced =
    (backup.identity != null && !sameIdentity(backup.identity, identityOf(stats))) ||
    (backup.kind != null && backup.kind !== kindOf(stats)) ||
    (backup.modified != null && backup.modified !== stats.mtimeMs)
  if (replaced) return { path: backup.path, status: 'changed' }
  return { path: backup.path, status: 'ok' }
}

/**
 * Whether the local copy `target` has the content of `source`. Links in the
 * source are followed (copies follow them); a link at the target never matches.
 */
async function sameContent(source: string, target: string): Promise<boolean> {
  const [sourceStats, targetStats] = await Promise.all([statOrNull(source), lstatOrNull(target)])
  if (sourceStats == null || targetStats == null || targetStats.isSymbolicLink()) return false

  if (sourceStats.isDirectory() && targetStats.isDirectory()) {
    const [sourceNames, targetNames] = await Promise.all([readdir(source), readdir(target)])
    sourceNames.sort()
    targetNames.sort()
    if (
      sourceNames.length !== targetNames.length ||
      sourceNames.some((name, i) => name !== targetNames[i])
    ) {
      return false
    }
    for (const name of sourceNames) {
      if (!(await sameContent(path.join(source, name), path.join(target, name)))) return false
    }
    return true
  }

  if (sourceStats.isFile() && targetStats.isFile()) {
    return sourceStats.size === targetStats.size && (await sameBytes(source, target))
  }
  return false
}

/** Compares two files of the same size by chunks, whatever their size. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  await using handleA = await open(a, 'r')
  await using handleB = await open(b, 'r')
  const size = 64 * 1024
  const bufferA = Buffer.alloc(size)
  const bufferB = Buffer.alloc(size)
  for (;;) {
    const [readA, readB] = await Promise.all([
      handleA.read(bufferA, 0, size, null),
      handleB.read(bufferB, 0, size, null),
    ])
    if (readA.bytesRead !== readB.bytesRead) return false
    if (readA.bytesRead === 0) return true
    if (!bufferA.subarray(0, readA.bytesRead).equals(bufferB.subarray(0, readB.bytesRead))) {
      return false
    }
  }
}
