import { lstatSync } from 'node:fs'
import { cp, link, open, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.ts'
import {
  errnoCode,
  identityOf,
  kindOf,
  lstatOrNull,
  messageOf,
  removeTree,
  sameIdentity,
  siblingName,
  statOrNull,
} from './fsutil.ts'
import { type Backup, type Deployed, type DeploymentRecord, isBackupPathOf } from './state.ts'

/**
 * File operations shared by links and copies: backups made before replacing
 * a file, copies made through a temporary sibling, and the checks that decide
 * whether a backup can be put back.
 */

/**
 * The backup undeploy would put back, and whether it can. `deployed`: it is
 * configfile's copy for another entry (see `moveAside`).
 */
export type BackupCheck = {
  path: string
  status: 'ok' | 'missing' | 'changed'
  deployed?: Deployed
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

/**
 * Records the backup first, so that a crash never leaves an unknown `.old`
 * file. `deployed`: what is moved aside is configfile's copy for another
 * entry, which it is again once put back. Returns `false` when nothing was
 * there to move.
 */
export async function moveAside(
  target: string,
  backup: string,
  record: DeploymentRecord,
  deployed?: Deployed,
): Promise<boolean> {
  const stats = await lstatOrNull(target)
  if (stats == null) return false
  await record.addBackup(target, {
    path: backup,
    identity: identityOf(stats),
    kind: kindOf(stats),
    modified: stats.mtimeMs,
    ...(deployed != null && { deployed }),
  })
  try {
    await rename(target, backup)
  } catch (error) {
    await record.removeBackup(target, backup)
    throw error
  }
  return true
}

/**
 * Copies through a temporary sibling, so an interrupted copy never sits at
 * the target, and never replaces something that appeared there meanwhile.
 */
export async function copyInto(source: string, target: string): Promise<void> {
  const temporary = siblingName(target, 'copy')
  try {
    await cp(source, temporary, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    })
    if ((await lstatOrNull(temporary))?.isDirectory()) {
      // Fails when a folder with files, or a file, is at the target.
      await rename(temporary, target)
    } else {
      // A hard link fails when something is there; rename only replaces.
      try {
        await link(temporary, target)
      } catch (error) {
        if (errnoCode(error) === 'EEXIST') {
          throw new CliError('something appeared at the target while configfile copied it.')
        }
        if ((await lstatOrNull(target)) != null) throw error
        await rename(temporary, target)
      }
      await rm(temporary, { force: true })
    }
  } catch (error) {
    await removeTree(temporary).catch(() => {})
    throw error
  }
}

/** After a failed deployment, puts the backup back and explains where things are. */
export async function putBackAfterFailure(
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
export async function checkLatestBackup(
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
  return {
    path: backup.path,
    status: 'ok',
    ...(backup.deployed != null && { deployed: backup.deployed }),
  }
}

/**
 * Whether the local copy `target` has the content of `source`. Links in the
 * source are followed (copies follow them); a link at the target never matches.
 */
export async function sameContent(source: string, target: string): Promise<boolean> {
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
