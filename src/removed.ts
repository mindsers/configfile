import { realpath } from 'node:fs/promises'
import path from 'node:path'

import { lstatOrNull } from './fsutil.js'
import { contains, resolveUserPath } from './paths.js'
import type { Entry, Module, ModuleFile } from './repository.js'
import type { DeploymentRecord, TargetRecord } from './state.js'

/**
 * A file configfile deployed for an entry the repository no longer deploys,
 * rebuilt from the deployment record. It can be undeployed, never deployed.
 */
export interface RecordedFile {
  readonly source: string
  readonly target: string
  readonly strategy: ModuleFile['strategy']
  /** The current repository, which undeploy must never touch. */
  readonly repository: string
  /** The module folder it came from, or `null` when that folder is gone. */
  readonly module: string | null
  /** Local copies: the folder it was copied into, where undeploy --local finds it. */
  readonly folder?: string
}

/** A deployed file configfile cannot tell about, and why. */
export interface HeldBack {
  readonly target: string
  readonly reason: string
}

/**
 * Files configfile deployed that the repository no longer deploys: their
 * entry was removed or set to `"deploy": "none"`, its target changed, or its
 * module was deleted.
 *
 * A file is still deployed when a current entry of the same strategy resolves
 * to its target: global entries from the home folder, local entries from the
 * folder the copy was made in (recorded with it). Targets are compared as
 * written and through the record, which finds a target written differently.
 *
 * Anything that cannot be proven gone is held back instead, because
 * undeploying it by mistake would change the user's files: files of a module
 * that cannot be used, has invalid entries or is in the repository but was
 * not loaded (a broken symbolic link, a name used twice), entries without a
 * deployment strategy, and records that do not say which entry they come
 * from. Targets deleted by hand are left out: there is nothing to undeploy
 * (a `.old` backup, if any, stays where it is).
 */
export async function findRemovedFiles(
  record: DeploymentRecord,
  modules: readonly Module[],
  {
    repository,
    home,
    strategy,
    folder,
  }: {
    /** Absolute path of the dotfiles repository. */
    repository: string
    home: string
    strategy: ModuleFile['strategy']
    /** Local copies: only those made in this folder (all folders when omitted). */
    folder?: string
  },
): Promise<{ removed: RecordedFile[]; heldBack: HeldBack[] }> {
  const loaded = new Map(modules.map(module => [path.relative(repository, module.path), module]))
  const current = modules.flatMap(module =>
    module.error == null ? module.files.filter(file => file.strategy === strategy) : [],
  )

  const removed: RecordedFile[] = []
  const heldBack: HeldBack[] = []
  for (const targetRecord of record.targets()) {
    const deployed = targetRecord.deployed
    if (deployed == null || deployed.strategy !== strategy) continue
    const { target } = targetRecord

    // Local copies made before their folder was recorded (development builds
    // of 1.0) are never guessed.
    if (strategy === 'local') {
      if (deployed.entry == null) continue
      if (folder != null && !(await isSameFolder(deployed.entry.folder, folder))) continue
    }

    if (await isStillDeployed(targetRecord, current, record, home)) continue
    // Nothing left to undeploy. An unreadable target is listed: undeploy says why it fails.
    if ((await lstatOrNull(target).catch(() => true)) == null) continue

    const entry = deployed.entry ?? entryOf(deployed.source, repository)
    const reason = await uncertainty(entry, loaded, repository)
    if (reason != null) {
      heldBack.push({ target, reason })
      continue
    }

    const module = entry == null ? null : loaded.get(entry.module)
    removed.push({
      source: deployed.source,
      target,
      strategy,
      repository,
      module: module?.path ?? null,
      ...(strategy === 'local' && deployed.entry != null && { folder: deployed.entry.folder }),
    })
  }

  const byTarget = (a: { target: string }, b: { target: string }) =>
    a.target.localeCompare(b.target)
  return { removed: removed.sort(byTarget), heldBack: heldBack.sort(byTarget) }
}

/** Whether a current entry of the repository resolves to the recorded target. */
async function isStillDeployed(
  targetRecord: TargetRecord,
  current: readonly ModuleFile[],
  record: DeploymentRecord,
  home: string,
): Promise<boolean> {
  const { target, deployed } = targetRecord
  for (const file of current) {
    // Local entries resolve from the folder the copy was made in.
    const candidate =
      file.strategy === 'local' && deployed?.entry != null && file.entry != null
        ? resolveUserPath(file.entry.target, { home, cwd: deployed.entry.folder })
        : file.target
    if (candidate === target) return true
    // Found through the record, which compares paths the way it stores them.
    // A target that cannot be checked is not proven gone.
    const found = await record.find(candidate).catch(() => targetRecord)
    if (found?.target === target) return true
  }
  return false
}

/** Why the record of an entry cannot be trusted to be gone, or `null`. */
async function uncertainty(
  entry: Pick<Entry, 'module' | 'source'> | null,
  loaded: ReadonlyMap<string, Module>,
  repository: string,
): Promise<string | null> {
  if (entry == null) return 'configfile does not know which entry of the repository it comes from'

  const module = loaded.get(entry.module)
  if (module == null) {
    // Gone means gone: anything still at its place (a broken link, a folder
    // whose module name another folder uses) may come back.
    const there = await lstatOrNull(path.join(repository, entry.module)).catch(() => true)
    return there == null ? null : `${entry.module} is in the repository but is not a usable module`
  }
  if (module.error != null) return `module "${module.name}" cannot be used: ${module.error}`
  if (module.invalidEntries.length > 0) return `module "${module.name}" has invalid entries`
  const undecided = module.undecided.map(source => path.normalize(source))
  if (undecided.includes(path.normalize(entry.source))) {
    return `its entry in module "${module.name}" has no deployment strategy`
  }
  return null
}

/** The entry of a source in this repository, for records made before entries were kept. */
function entryOf(source: string, repository: string): Pick<Entry, 'module' | 'source'> | null {
  const files = path.join(repository, 'files')
  if (!contains(files, source)) return null
  const [module, ...rest] = path.relative(files, source).split(path.sep)
  if (module == null || module === '' || rest.length === 0) return null
  return { module: path.join('files', module), source: path.join(...rest) }
}

async function isSameFolder(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true
  const [realA, realB] = await Promise.all([
    realpath(a).catch(() => null),
    realpath(b).catch(() => null),
  ])
  return realA != null && realA === realB
}
