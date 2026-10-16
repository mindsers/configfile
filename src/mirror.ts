import path from 'node:path'

import { errnoCode, lstatOrNull, messageOf } from './fsutil.ts'
import { gitOutput } from './process.ts'

/** A change found in the mirror: made through a deployed link, by a tool or by hand. */
export interface MirrorChange {
  /**
   * Relative to the repository, with `/` separators, as git writes it. A path
   * ending with `/` is a whole folder git doesn't track, such as another git
   * repository a tool cloned there.
   */
  readonly path: string
  /** `new`: not in the repository's last commit (untracked, or only added to the index). */
  readonly kind: 'modified' | 'new' | 'deleted'
}

export type MirrorChanges =
  | { readonly status: 'read'; readonly changes: readonly MirrorChange[] }
  /** The mirror has no `.git` of its own: there are no changes to tell. */
  | { readonly status: 'not-a-repository' }
  /** Why git cannot tell (missing, broken…). */
  | { readonly status: 'unavailable'; readonly reason: string }

/**
 * The uncommitted changes of the mirror, files that are not in the repository
 * included (ignored files excepted, as `update` leaves them alone). Never
 * fails: when git cannot tell, says why.
 */
export async function readMirrorChanges(repository: string): Promise<MirrorChanges> {
  // A folder without its own .git would show the changes of a repository
  // containing it (a home folder kept in git, for example).
  const dotGit = await lstatOrNull(path.join(repository, '.git')).catch((error: unknown) => error)
  if (dotGit instanceof Error) {
    const reason = `${repository} cannot be read (${errnoCode(dotGit) ?? messageOf(dotGit)})`
    return { status: 'unavailable', reason }
  }
  if (dotGit == null) return { status: 'not-a-repository' }

  try {
    const output = await gitOutput(
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: repository },
    )
    return { status: 'read', changes: parseStatus(output ?? '') }
  } catch (error) {
    // git's own message: a broken index, a folder git refuses as unsafe…
    return { status: 'unavailable', reason: messageOf(error) }
  }
}

/**
 * Parses `git status --porcelain=v1 -z`: `XY path`, then the original path
 * for renames and copies. Paths are relative to the repository. `X` is the
 * index, compared with the last commit; `Y` the working tree.
 */
export function parseStatus(output: string): MirrorChange[] {
  const fields = output.split('\0')
  const changes: MirrorChange[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const status = field.slice(0, 2)
    const [index, tree] = status
    const file = field.slice(3)

    const moved = status.includes('R') || status.includes('C')
    // Added to the index (or as a rename or copy) means not in the last commit, even if deleted since.
    if (status === '??' || index === 'A' || index === 'R' || index === 'C') {
      changes.push({ path: file, kind: 'new' })
    } else if (index === 'D' || tree === 'D') {
      changes.push({ path: file, kind: 'deleted' })
    } else {
      changes.push({ path: file, kind: 'modified' })
    }
    if (moved) {
      const original = fields[++i]
      // A renamed file is no longer at its original path; a copied one still is.
      if (status.includes('R') && original != null && original !== '') {
        changes.push({ path: original, kind: 'deleted' })
      }
    }
  }
  // git lists untracked files last: sorted by path, each folder reads in order.
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The changes to a source of the repository: the file itself, or anything
 * inside the folder. `source` is relative to the repository.
 */
export function changesUnder(
  changes: readonly MirrorChange[],
  source: string,
): readonly MirrorChange[] {
  const prefix = source.split(path.sep).join('/')
  return changes.filter(
    change =>
      change.path === prefix ||
      change.path.startsWith(`${prefix}/`) ||
      // A whole untracked folder containing the source.
      (change.path.endsWith('/') && prefix.startsWith(change.path)),
  )
}
