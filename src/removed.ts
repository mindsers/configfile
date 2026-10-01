import path from 'node:path'

import { lstatOrNull } from './fsutil.js'
import { contains } from './paths.js'
import type { Module, ModuleFile } from './repository.js'
import type { DeploymentRecord } from './state.js'

/**
 * Files configfile deployed that the repository no longer deploys: their
 * entry was removed or set to `"deploy": "none"`, their target changed, or
 * their module was deleted. They are found in the deployment record, so that
 * undeploy can remove them and restore their backups.
 *
 * Anything that cannot be proven gone is left out, because undeploying it by
 * mistake would change the user's files: files of a module whose
 * `settings.json` is broken or has invalid entries, of a module folder that
 * was not loaded (its name is used twice, for example), and entries without
 * a deployment strategy. Links deployed before 1.0 were never recorded, so they
 * cannot be found.
 *
 * Global files are matched by target. Local copies are matched by their
 * source's path inside the repository (`files/<module>/<source>`), since
 * their target depends on the folder they were copied into; this also keeps
 * them matched when the repository has moved.
 */
export async function findRemovedFiles(
  record: DeploymentRecord,
  modules: readonly Module[],
  {
    repository,
    strategy,
    within,
  }: {
    /** Absolute path of the dotfiles repository. */
    repository: string
    strategy: ModuleFile['strategy']
    /** Only files whose target is inside this folder (local copies of the current folder). */
    within?: string
  },
): Promise<ModuleFile[]> {
  const deployed = new Set<string>()
  const sources: string[] = []
  const uncertain: string[] = []
  const loaded = new Set(modules.map(module => module.path))

  for (const module of modules) {
    const moduleFolder = path.relative(repository, module.path)
    if (module.error != null || module.invalidEntries.length > 0) {
      uncertain.push(moduleFolder)
      continue
    }
    for (const source of module.undecided) {
      sources.push(path.relative(repository, path.resolve(module.path, source)))
    }
    for (const file of module.files) {
      if (file.strategy !== strategy) continue
      if (strategy === 'global') {
        // Found through the record, which compares paths the way it stores them.
        // A target that cannot be checked counts as found: it is not proven gone.
        const found = await record.find(file.target).catch(() => ({ target: file.target }))
        if (found != null) deployed.add(found.target)
      } else {
        sources.push(path.relative(repository, file.source))
      }
    }
  }

  const removed: ModuleFile[] = []
  for (const { target, deployed: what } of record.targets()) {
    if (what == null || what.strategy !== strategy) continue
    if (within != null && !contains(within, target)) continue
    if (deployed.has(target)) continue
    if (sources.some(source => isSource(what.source, source, repository))) continue
    if (uncertain.some(folder => isInside(what.source, folder, repository))) continue
    const module = moduleFolderOf(what.source, repository)
    // A module that is still there but was not loaded (its name is used twice, for example).
    if (
      !loaded.has(module) &&
      (await lstatOrNull(path.join(module, 'settings.json')).catch(() => true)) != null
    )
      continue
    // Nothing left to undeploy (removed by hand). An unreadable target is listed:
    // undeploy reports why it cannot be checked.
    if ((await lstatOrNull(target).catch(() => true)) == null) continue

    removed.push({
      source: what.source,
      target,
      strategy,
      repository,
      module,
    })
  }
  return removed.sort((a, b) => a.target.localeCompare(b.target))
}

/** Whether `source` is `relative` (`files/<module>/…`), in this repository or a previous location of it. */
function isSource(source: string, relative: string, repository: string): boolean {
  return source === path.join(repository, relative) || source.endsWith(`${path.sep}${relative}`)
}

/** Whether `source` is inside `folder` (`files/<module>`), in this repository or a previous location of it. */
function isInside(source: string, folder: string, repository: string): boolean {
  return (
    contains(path.join(repository, folder), source) ||
    source.includes(`${path.sep}${folder}${path.sep}`)
  )
}

/** The module folder a recorded source came from, for the safety checks of undeploy. */
function moduleFolderOf(source: string, repository: string): string {
  const [files, module] = path.relative(repository, source).split(path.sep)
  if (contains(repository, source) && files === 'files' && module != null) {
    return path.join(repository, files, module)
  }
  return path.dirname(source)
}
