import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'

import type { ConfigStore } from '../config.ts'
import type { Context } from '../context.ts'
import { CliError } from '../errors.ts'
import { errnoCode, messageOf } from '../fsutil.ts'
import { configfilePaths, contains } from '../paths.ts'
import { gitOutput } from '../process.ts'

/**
 * Set in the clones configfile makes, to tell them from the user's own: outside
 * configfile's folder, setting it up again only deletes a marked clone.
 */
const CLONE_KEY = 'configfile.clone'

/**
 * Whether configfile is set up on this machine: its configuration, its
 * deployment record or its clone exists. A history alone, left by a first
 * `init` that failed, does not count.
 */
export function isSetUp(store: ConfigStore, home: string): boolean {
  const { dir, dotfiles } = configfilePaths(home)
  return store.exists() || existsSync(path.join(dir, 'state.json')) || existsSync(dotfiles)
}

/** Marks a folder configfile cloned, so that setting configfile up again deletes it. */
export async function markClone(folder: string): Promise<void> {
  await gitOutput(['config', '--local', CLONE_KEY, 'true'], { cwd: folder })
}

/**
 * `folder` when setting configfile up again deletes it: it is inside
 * configfile's folder, or a clone marked as configfile's. `null` for a folder
 * configfile cannot tell it cloned, such as the user's own clone named by a
 * 0.3 configuration, which is kept.
 */
export async function ownClone(folder: string, home: string): Promise<string | null> {
  if (contains(configfilePaths(home).dir, folder)) return folder
  // Not a repository of its own: git would read the settings of a repository around it.
  if (!existsSync(path.join(folder, '.git'))) return null
  // Only the clone's own settings: a global one would mark every repository.
  const marked = await gitOutput(['config', '--local', '--type=bool', '--get', CLONE_KEY], {
    cwd: folder,
    allowFailure: true,
  }).catch(() => null)
  return marked?.trim() === 'true' ? folder : null
}

/**
 * Whether setting configfile up again deletes `folder`: it is inside `clone`,
 * or inside configfile's folder, which itself stays, with its lock.
 */
export function deletedBySetUp(
  folder: string,
  { home, clone }: { home: string; clone: string | null },
): boolean {
  if (clone != null && contains(clone, folder)) return true
  const { dir } = configfilePaths(home)
  const [entry = ''] = path.relative(dir, folder).split(path.sep)
  return contains(dir, folder) && entry !== '' && !isLock(entry)
}

/**
 * Deletes `clone`, a clone of configfile's elsewhere, what configfile's folder
 * holds (deployment record, history, saved changes, clone), then its
 * configuration: until then, running `init` again finds the setup, and the
 * clone it names. The lock stays: the caller holds it. Run once every
 * deployed file is undeployed. Returns what it deleted.
 */
export async function deleteSetUp(
  { store, clone }: { store: ConfigStore; clone: string | null },
  ctx: Context,
): Promise<string[]> {
  const { dir } = configfilePaths(ctx.home)
  const deleted: string[] = []
  const remove = async (target: string) => {
    try {
      await rm(target, { recursive: true, force: true })
    } catch (error) {
      throw new CliError(`Cannot delete ${target}: ${messageOf(error)}`, { cause: error })
    }
    ctx.history.record({ kind: 'deleted', path: target })
    deleted.push(target)
  }
  if (clone != null && !contains(dir, clone)) {
    // Its mark last: until then, running init again finds it, and finishes the deletion.
    for (const entry of await entriesOf(clone, entry => entry !== '.git')) {
      await rm(path.join(clone, entry), { recursive: true, force: true }).catch(error => {
        throw new CliError(`Cannot delete ${clone}: ${messageOf(error)}`, { cause: error })
      })
    }
    await remove(clone)
  }
  for (const entry of await entriesOf(dir, entry => !isLock(entry))) {
    await remove(path.join(dir, entry))
  }
  if (store.exists()) await remove(store.path)
  return deleted
}

/** The lock, and its drafts. */
function isLock(entry: string): boolean {
  return entry.startsWith('lock')
}

/** The entries of `dir` that `keep` keeps: none when it is missing. */
async function entriesOf(dir: string, keep: (entry: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(keep)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return []
    throw new CliError(`Cannot read ${dir}: ${messageOf(error)}`, { cause: error })
  }
}
