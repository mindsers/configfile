import { mkdir, readdir, readlink, realpath, rename, rm, symlink } from 'node:fs/promises'
import path from 'node:path'

import {
  applyCopy,
  type CopyOutcome,
  type CopyPlan,
  type CopyState,
  convertLink,
  createCopy,
  inspectCopy,
  isRecordFor,
  planCopyUndeploy,
  type ReadFile,
  type Replace,
  removeCopiedFiles,
  removeWholeCopy,
  summarize,
  unchangedFiles,
} from './copy.ts'
import { CliError } from './errors.ts'
import {
  type BackupCheck,
  checkLatestBackup,
  copyInto,
  moveAside,
  nextBackupPath,
  putBackAfterFailure,
  sameContent,
} from './fileops.ts'
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
import type { RepositoryView } from './mirror.ts'
import { configfilePaths, contains } from './paths.ts'
import type { RecordedFile } from './removed.ts'
import type { ModuleFile } from './repository.ts'
import type { Deployed, DeploymentRecord } from './state.ts'

/**
 * A file undeploy can work on: a file of a module, or one the repository no
 * longer deploys, rebuilt from the record. Only module files can be deployed.
 */
export type UndeployableFile = ModuleFile | RecordedFile

/** What `inspectFile` needs to know about a file. */
export type InspectedFile = Pick<
  UndeployableFile,
  'source' | 'target' | 'strategy' | 'method' | 'entry'
>

/** What is currently at the target of a module file, and whose it is. */
export type TargetState =
  | { kind: 'missing' }
  /**
   * Global: a link to the source. Local: an unmodified copy configfile made.
   * `recorded`: false for links made before 1.0 (adopted when deploying).
   */
  | { kind: 'deployed'; recorded: boolean }
  /**
   * Global copy: configfile's copy. The files (paths inside a copied folder,
   * `''` for a copied file) the repository changed (`outdated`) or deleted
   * (`deleted`) since, which update or deploy bring along; those changed on
   * this machine (kept); those changed on both sides. `adopted`: configfile
   * linked it, and a file replaced the link.
   */
  | {
      kind: 'copied'
      outdated: readonly string[]
      deleted: readonly string[]
      changed: readonly string[]
      conflicts: readonly string[]
      adopted: boolean
    }
  /** Global copy: still configfile's link, which deploying turns into a copy. */
  | { kind: 'linked' }
  /**
   * Global link: configfile's copy, which deploying turns into a link.
   * `changed`: changed on this machine, or holding files configfile did not
   * copy (a tool's): only replaced with force, or once the user agrees.
   */
  | { kind: 'copied-not-linked'; changed: boolean }
  /** Local: a copy configfile made, modified since. */
  | { kind: 'modified' }
  /**
   * Local file or global copy: identical to the source, but not copied by
   * configfile. Deploying a global copy still moves it to `.old`.
   */
  | { kind: 'identical' }
  /** Global: the link configfile made, pointing to an old location of the source. */
  | { kind: 'stale' }
  /**
   * Something configfile did not put there, or its copy for another entry.
   * `identical`: for a file or a folder, whether it is the repository's version.
   */
  | { kind: 'foreign'; what: 'file' | 'folder' | 'link'; identical?: boolean }
  /**
   * Global link: configfile linked it, and a file (or folder) replaced the
   * link, as tools that save through a new file do. `identical`: whether it is
   * the repository's version.
   */
  | { kind: 'replaced-link'; identical: boolean }
  /** Something is there but the source is missing. `ours`: configfile put it there. */
  | { kind: 'source-missing'; ours: boolean }

export type DeployDecision =
  | { action: 'up-to-date' }
  | { action: 'create' }
  /**
   * Move what is at the target aside (recorded as a backup), then deploy.
   * `deployed`: it is configfile's copy for another entry.
   */
  | {
      action: 'replace'
      what: 'file' | 'folder' | 'link' | 'copy'
      backup: string
      deployed?: Deployed
    }
  /**
   * Replace configfile's own outdated link, or (`was: 'copy'`, for a link
   * entry) its unchanged copy; nothing is backed up.
   */
  | { action: 'refresh'; was?: 'copy' }
  /** Global copy: replace configfile's link with a copy of what it showed. */
  | { action: 'convert' }
  /**
   * Global copy: follow the repository where nothing changed on this
   * machine, and replace what `replace` says.
   */
  | { action: 'update'; plan: CopyPlan; replace: Replace; adopted: boolean }
  /**
   * The target exists and differs; replaced only with `force` (or once the
   * user agrees). For a global copy, `paths` changed both here and in the
   * repository, and `plan` is what the rest would get.
   */
  | { action: 'conflict'; paths?: readonly string[]; plan?: CopyPlan; replacedLink?: true }

/**
 * How a deployment treats a global copy changed both here and in the
 * repository: `ask` returns a conflict without changing anything, `skip`
 * updates the rest and leaves the conflicts, `conflicts` replaces them (with a
 * backup), `all` also replaces what changed on this machine (as `force` does).
 */
export type CopyChoice = 'ask' | 'skip' | 'conflicts' | 'all'

export type { BackupCheck } from './fileops.ts'
export { nextBackupPath } from './fileops.ts'

export type KeptState =
  | Extract<TargetState, { kind: 'modified' | 'identical' | 'foreign' | 'source-missing' }>
  /**
   * Global copy: `paths` changed on this machine, `others` are files
   * configfile did not copy, and `removed` files were (or would be) removed.
   */
  | {
      kind: 'changed'
      paths: readonly string[]
      others: readonly string[]
      removed: number
    }

export type UndeployDecision =
  /**
   * `copy`: the files of configfile's copy as read, checked again just
   * before removing them (see `unchangedFiles`).
   */
  | { action: 'remove'; backup: BackupCheck | null; copy?: readonly ReadFile[] }
  | { action: 'not-deployed' }
  | { action: 'keep'; state: KeptState }

export type DeployResult =
  | { status: 'deployed' }
  | { status: 'up-to-date' }
  | { status: 'backed-up'; backup: string }
  /** Global: configfile's link replaced by a copy, or its copy by a link. */
  | { status: 'converted' }
  /** Global copy: what following the repository did, and kept. */
  | { status: 'updated'; outcome: CopyOutcome }
  | { status: 'conflict'; paths?: readonly string[]; plan?: CopyPlan; replacedLink?: true }

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
  /** The repository's version of the files, which copies are compared with. */
  readonly view: RepositoryView
}

/** Whether a file is deployed as a global copy (rather than a link, or a local copy). */
export function isGlobalCopy(file: Pick<UndeployableFile, 'strategy' | 'method'>): boolean {
  return file.strategy === 'global' && file.method === 'copy'
}

// ---------------------------------------------------------------------------
// Inspecting and deciding (shared by dry runs and real runs)

export async function inspectFile(
  file: InspectedFile,
  record: DeploymentRecord,
  view: RepositoryView,
): Promise<TargetState> {
  if (isGlobalCopy(file)) return stateOfCopy(await inspectCopy(file, record, view))

  const existing = await lstatOrNull(file.target)
  if (existing == null) return { kind: 'missing' }

  const recorded = (await record.find(file.target))?.deployed
  // A copy is configfile's for its own entry only (see the copy logic), never as a link.
  const recordedHere =
    recorded?.copy == null && sameIdentity(recorded?.identity, identityOf(existing))
  // A link entry, where configfile copied the file before.
  if (
    file.strategy === 'global' &&
    recorded?.copy != null &&
    isRecordFor(recorded, file) &&
    !existing.isSymbolicLink() &&
    (await lstatOrNull(file.source)) != null
  ) {
    const plan = await planCopyUndeploy(file, recorded.copy, view)
    return { kind: 'copied-not-linked', changed: plan.action === 'keep' }
  }
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
    if (existing.isSymbolicLink()) return { kind: 'foreign', what: 'link' }
    const identical = await sameContent(file.source, file.target)
    if (recorded != null && recorded.copy == null && isRecordFor(recorded, file)) {
      return { kind: 'replaced-link', identical }
    }
    return { kind: 'foreign', what: kindOf(existing), identical }
  }

  if (!sourceExists) return { kind: 'source-missing', ours: false }
  const same = await sameContent(file.source, file.target)
  if (recordedHere) return same ? { kind: 'deployed', recorded: true } : { kind: 'modified' }
  return same ? { kind: 'identical' } : { kind: 'foreign', what: kindOf(existing) }
}

function stateOfCopy(state: CopyState): TargetState {
  switch (state.kind) {
    case 'missing':
    case 'linked':
    case 'identical':
      return { kind: state.kind }
    case 'foreign':
      // Identical files are their own state: anything else in the way differs.
      return state.what === 'link'
        ? { kind: 'foreign', what: 'link' }
        : { kind: 'foreign', what: state.what, identical: false }
    case 'source-missing':
      return { kind: 'source-missing', ours: state.ours }
    case 'copy':
      return { kind: 'copied', ...summarize(state.plan), adopted: state.adopted }
    case 'reshaped':
      // The repository made a folder of the file, or the reverse.
      return {
        kind: 'copied',
        outdated: state.changed ? [] : [''],
        deleted: [],
        changed: [],
        conflicts: state.changed ? [''] : [],
        adopted: false,
      }
  }
}

/** What deploying `file` would do. Runs every check a real deployment runs. */
export async function planDeploy(
  file: ModuleFile,
  {
    force,
    copies = 'ask',
    record,
    guard,
    view,
  }: DeployContext & { force: boolean; copies?: CopyChoice },
): Promise<DeployDecision> {
  await assertUsableSource(file)

  if (isGlobalCopy(file)) {
    const decision = planCopyDeploy(
      file,
      await inspectCopy(file, record, view),
      force ? 'all' : copies,
    )
    // Updating files inside a copied folder never replaces it: it may be the current folder.
    const inPlace = ['update', 'conflict', 'up-to-date'].includes(decision.action)
    await guard.check(file, { inPlace })
    return decision
  }
  await guard.check(file)

  const state = await inspectFile(file, record, view)
  switch (state.kind) {
    case 'copied-not-linked':
      // An unchanged copy becomes a link; a copy changed here only with force.
      if (!state.changed) return { action: 'refresh', was: 'copy' }
      return force
        ? { action: 'replace', what: 'copy', backup: nextBackupPath(file.target) }
        : { action: 'conflict' }
    case 'copied':
    case 'linked':
      throw new CliError('the file is deployed as a copy, not a link.')
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
    case 'replaced-link': {
      // Most likely a tool's own save: replaced only with force, or once the user agrees.
      if (!force) return { action: 'conflict', replacedLink: true }
      const what = (await lstatOrNull(file.target))?.isDirectory() ? 'folder' : 'file'
      return { action: 'replace', what, backup: nextBackupPath(file.target) }
    }
    case 'foreign':
      if (file.strategy === 'local' && !force) return { action: 'conflict' }
      return { action: 'replace', what: state.what, backup: nextBackupPath(file.target) }
    case 'source-missing':
      // assertUsableSource checked the source: it disappeared meanwhile.
      throw new CliError('the source file is missing from the repository.')
  }
}

/** Whether configfile's copy at the target (for this entry) is unchanged, and still as read. */
async function isUnchangedCopy(
  file: ModuleFile,
  { record, view }: DeployContext,
): Promise<boolean> {
  const known = (await record.find(file.target))?.deployed
  if (known?.copy == null || !isRecordFor(known, file)) return false
  const plan = await planCopyUndeploy(file, known.copy, view)
  return plan.action === 'remove' && (await unchangedFiles(file.target, plan.files))
}

/** A copy left as it is, as a conflict: what deploying it does when the answer is no. */
const keptAsConflict: CopyPlan = {
  folder: false,
  steps: [
    {
      path: '',
      action: 'conflict',
      base: null,
      repo: null,
      local: { kind: 'other', blocked: false },
    },
  ],
}

function planCopyDeploy(file: ModuleFile, state: CopyState, choice: CopyChoice): DeployDecision {
  switch (state.kind) {
    case 'missing':
      return { action: 'create' }
    case 'linked':
      return { action: 'convert' }
    case 'identical':
      // Not configfile's: moved aside like any other file, so that undeploy puts it back.
      return { action: 'replace', what: state.what, backup: nextBackupPath(file.target) }
    case 'foreign':
      return {
        action: 'replace',
        what: state.what,
        backup: nextBackupPath(file.target),
        ...(state.deployed != null && { deployed: state.deployed }),
      }
    case 'source-missing':
      throw new CliError('the source file is missing from the repository.')
    case 'reshaped':
      // configfile's own copy is replaced without a backup; changed here, it is a conflict.
      if (!state.changed) return { action: 'refresh', was: 'copy' }
      if (choice === 'ask') return { action: 'conflict', paths: [''] }
      if (choice === 'skip') {
        return { action: 'update', plan: keptAsConflict, replace: 'none', adopted: false }
      }
      return { action: 'replace', what: 'copy', backup: nextBackupPath(file.target) }
    case 'copy': {
      const { conflicts } = summarize(state.plan)
      if (conflicts.length > 0 && choice === 'ask') {
        return { action: 'conflict', paths: conflicts, plan: state.plan }
      }
      const replace: Replace =
        choice === 'all' ? 'all' : choice === 'conflicts' ? 'conflicts' : 'none'
      return { action: 'update', plan: state.plan, replace, adopted: state.adopted }
    }
  }
}

/** What undeploying `file` would do. Runs every check a real undeployment runs. */
export async function planUndeploy(
  file: UndeployableFile,
  { record, guard, view }: DeployContext,
): Promise<UndeployDecision> {
  // configfile's copy, whatever the entry says now: removed when nothing changed it.
  const existing = await lstatOrNull(file.target)
  const known = (await record.find(file.target))?.deployed
  if (
    existing != null &&
    !existing.isSymbolicLink() &&
    known?.copy != null &&
    isRecordFor(known, file)
  ) {
    const plan = await planCopyUndeploy(file, known.copy, view)
    // Removing some files of a copied folder leaves it in place: it may be the current folder.
    await guard.check(file, { inPlace: plan.action === 'keep' })
    if (plan.action === 'remove') {
      return {
        action: 'remove',
        backup: await checkLatestBackup(file.target, record),
        copy: plan.files,
      }
    }
    const { changed: paths, others, removable } = plan
    return { action: 'keep', state: { kind: 'changed', paths, others, removed: removable.length } }
  }

  await guard.check(file)
  // Not a copy of configfile's: a link, or a local file.
  const asDeployed: InspectedFile = file.strategy === 'global' ? { ...file, method: 'link' } : file
  const state = await inspectFile(asDeployed, record, view)
  switch (state.kind) {
    case 'missing':
      return { action: 'not-deployed' }
    case 'deployed':
    case 'stale':
      return { action: 'remove', backup: await checkLatestBackup(file.target, record) }
    case 'copied':
    case 'linked':
    case 'copied-not-linked':
      // Copies are handled above: only possible if the target changed meanwhile.
      throw new CliError('the target changed while configfile was reading it. Try again.')
    case 'source-missing':
      return state.ours && file.strategy === 'global'
        ? { action: 'remove', backup: await checkLatestBackup(file.target, record) }
        : { action: 'keep', state }
    case 'replaced-link':
      // Not configfile's link any more: whatever replaced it stays.
      return {
        action: 'keep',
        state: { kind: 'foreign', what: existing?.isDirectory() ? 'folder' : 'file' },
      }
    case 'modified':
    case 'identical':
    case 'foreign':
      return { action: 'keep', state }
  }
}

// ---------------------------------------------------------------------------
// Deploying and undeploying (callers hold the lock, see `withLock`)

/**
 * Deploys a file: global files are copied (or symlinked, with
 * `"method": "link"`), local files are copied. Copies follow links, so they
 * never point into the repository.
 *
 * Anything in the way that configfile did not put there is moved aside to
 * `<target>.old` (or `.old.1`, …) and recorded before it is moved, so that
 * `undeployFile` can restore it. For local files this only happens with
 * `force`; otherwise a `conflict` is returned. A global copy follows the
 * repository where nothing changed on this machine (see `copy.ts`); what
 * changed on both sides is a `conflict`, handled as `copies` says.
 */
export async function deployFile(
  file: ModuleFile,
  context: DeployContext & { force?: boolean; copies?: CopyChoice },
): Promise<DeployResult> {
  const { record, view } = context
  const decision = await planDeploy(file, { ...context, force: context.force ?? false })

  if (decision.action === 'conflict') {
    const { paths, plan, replacedLink } = decision
    return {
      status: 'conflict',
      ...(paths != null && { paths }),
      ...(plan != null && { plan }),
      ...(replacedLink && { replacedLink }),
    }
  }
  if (decision.action === 'update') {
    const outcome = await applyCopy(file, decision.plan, {
      replace: decision.replace,
      record,
      always: decision.adopted,
    })
    return outcome.files.length === 0 ? { status: 'up-to-date' } : { status: 'updated', outcome }
  }
  if (decision.action === 'convert') {
    await convertLink(file, view, record)
    return { status: 'converted' }
  }
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

  // configfile's own outdated link, or its own unchanged copy.
  const replacesCopy = decision.action === 'refresh' && decision.was === 'copy'
  if (decision.action === 'refresh') {
    if (replacesCopy) {
      // Checked again: something may have written to the copy since it was planned.
      if (!(await isUnchangedCopy(file, context))) return { status: 'conflict' }
      await removeWholeCopy(file.target)
    } else {
      await rm(file.target)
    }
  }

  let backup: string | null = null
  if (decision.action === 'replace') {
    backup = decision.backup
    await moveAside(file.target, backup, record, decision.deployed)
  }

  try {
    if (isGlobalCopy(file)) {
      await createCopy(file, view, record)
    } else if (file.strategy === 'global') {
      await symlink(file.source, file.target)
    } else {
      await copyInto(file.source, file.target)
    }
  } catch (error) {
    throw await putBackAfterFailure(file.target, backup, record, error)
  }

  if (!isGlobalCopy(file)) await recordDeployed(file, record)
  // A copy replaced by a link; or by a new copy, when the repository made a folder of the file.
  if (replacesCopy) return isGlobalCopy(file) ? { status: 'deployed' } : { status: 'converted' }
  return backup == null ? { status: 'deployed' } : { status: 'backed-up', backup }
}

/**
 * Removes what configfile deployed (its link, or its copy when unmodified),
 * then puts back the most recent backup it made, if that backup is unchanged.
 * In a copied folder where some files changed, only the others are removed,
 * and the folder stays. Nothing configfile did not create is ever removed.
 */
export async function undeployFile(
  file: UndeployableFile,
  context: DeployContext,
): Promise<UndeployResult> {
  const { record } = context
  const decision = await planUndeploy(file, context)

  if (decision.action === 'not-deployed') return { status: 'not-deployed' }
  if (decision.action === 'keep') {
    const { state } = decision
    if (state.kind !== 'changed' || state.removed === 0) return { status: 'kept', state }
    // Some files of a copied folder stay: the others go.
    const known = (await record.find(file.target))?.deployed
    if (known?.copy == null) return { status: 'kept', state: { ...state, removed: 0 } }
    const plan = await planCopyUndeploy(file, known.copy, context.view)
    if (plan.action !== 'keep') return { status: 'kept', state: { ...state, removed: 0 } }
    const { removed } = await removeCopiedFiles(file, plan, known.copy, record)
    return { status: 'kept', state: { ...state, removed: removed.length } }
  }

  // A copy written to since it was planned is kept.
  if (decision.copy != null && !(await unchangedFiles(file.target, decision.copy))) {
    return { status: 'kept', state: { kind: 'changed', paths: [''], others: [], removed: 0 } }
  }

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

  // A copy configfile made for another entry is its copy again.
  await record.setDeployed(file.target, backup?.status === 'ok' ? (backup.deployed ?? null) : null)
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

// ---------------------------------------------------------------------------
// Safety checks

/**
 * The source must exist and really be inside its module folder, links
 * included: a repository must not be able to deploy files from elsewhere
 * (for example `~/.ssh`). Links inside a copied folder are checked too, since
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
  // Everything but a global link is a copy, which follows links: checked whatever the method says.
  const linked = file.strategy === 'global' && file.method === 'link'
  if (!linked && stats.isDirectory()) {
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

  /**
   * `inPlace`: only files inside the target change (a copied folder kept up
   * to date), so the target may be the current folder or contain it.
   */
  async check(
    file: UndeployableFile,
    { inPlace = false }: { inPlace?: boolean } = {},
  ): Promise<void> {
    const own = configfilePaths(this.#home)
    const stats = await lstatOrNull(file.target)

    if (stats != null && !stats.isSymbolicLink()) {
      const replaced = [
        [this.#home, 'the home folder'],
        ...(inPlace ? [] : [[this.#cwd, 'the current folder'] as const]),
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
