import type { Dirent } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { CliError } from './errors.ts'
import {
  type ContentHash,
  errnoCode,
  hashContent,
  hashFile,
  lstatOrNull,
  messageOf,
  statOrNull,
} from './fsutil.ts'
import { gitBuffer, gitOutput, gitResult } from './process.ts'

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

/** Relative to `parent`, with `/` separators: `''` for `parent` itself. */
export function posixRelative(parent: string, child: string): string {
  return path.relative(parent, child).split(path.sep).join('/')
}

/**
 * The repository's version of the files of the mirror: what is committed. A
 * file changed in the mirror (through a link, by a tool) has its committed
 * content. A file git doesn't track (untracked, or excluded by `.gitignore`)
 * is not one of the repository's files: `filesUnder` leaves it out.
 *
 * Paths are given to git as git knows them: through the symbolic links of
 * the mirror, to their real place. Files git cannot tell about (outside the
 * mirror, as in a module folder linked from elsewhere, or inside a
 * submodule) are taken as they are on disk; so is a whole mirror without
 * `.git`. When git fails in a mirror that has one, nothing is guessed:
 * comparing fails, with git's reason.
 *
 * Copies are written from the files on disk, and recorded with the
 * repository's version: whatever differs in the mirror then shows as changed
 * on this machine, never as a change of the repository. A view is read once:
 * it lasts as long as the mirror does not change (one locked operation).
 */
export class RepositoryView {
  readonly repository: string
  #changes: Promise<Changes | null> | null = null
  #root: Promise<string> | null = null
  #submodules: Promise<string[]> | null = null

  constructor(repository: string) {
    this.repository = repository
  }

  /** The repository's version of `file` (absolute, inside the mirror), or `null` when it has none. */
  async versionOf(file: string): Promise<ContentHash | null> {
    const changes = await this.#changed()
    const tracked = changes == null ? null : await this.#gitPath(file)
    const kind = tracked == null ? undefined : changes?.kindOf(tracked)
    if (tracked == null || kind == null || kind === 'new' || (await this.#inSubmodule(tracked))) {
      // Nothing there, or a file where a folder is expected: no version.
      const stats = await statOrNull(file).catch((error: unknown) => {
        if (errnoCode(error) === 'ENOTDIR') return null
        throw error
      })
      return stats?.isFile() ? hashFile(file, { follow: true }) : null
    }
    // Changed in the mirror, so committed: not being able to read it is an
    // error, never a file the repository doesn't have.
    const content = await gitBuffer(['cat-file', '--filters', `HEAD:${tracked}`], {
      cwd: this.repository,
    }).catch((error: unknown) => {
      throw new CliError(
        `Cannot read the repository's version of ${tracked}: ${messageOf(error)}`,
        { cause: error },
      )
    })
    return hashContent(content)
  }

  /**
   * The files the repository has in the folder `source` (links followed, as
   * copies follow them), relative to it with `/` separators: the files on
   * disk that git tracks, and those deleted from the mirror but still
   * committed.
   */
  async filesUnder(source: string): Promise<string[]> {
    const changes = await this.#changed()
    const files = new Set<string>()
    const asked: { file: string; tracked: string }[] = []
    for (const file of await walkFiles(source)) {
      const full = path.join(source, file)
      const tracked = changes == null ? null : await this.#gitPath(full)
      if (tracked == null) {
        files.add(file)
        continue
      }
      // Untracked, or in a folder git doesn't track (a repository a tool cloned there).
      if (changes?.kindOf(tracked) === 'new') continue
      if (await this.#inSubmodule(tracked)) files.add(file)
      else asked.push({ file, tracked })
    }
    // Files the repository ignores (a tool's cache or lockfile) are not its files either.
    const ignored = await this.#ignored(asked.map(item => item.tracked))
    for (const { file, tracked } of asked) if (!ignored.has(tracked)) files.add(file)

    const prefix = changes == null ? null : await this.#gitPath(source)
    for (const deleted of changes?.deleted ?? []) {
      if (prefix != null && deleted.startsWith(`${prefix}/`)) {
        files.add(deleted.slice(prefix.length + 1))
      }
    }
    return [...files].sort()
  }

  /** Those of `tracked` (as git knows them) that the repository's .gitignore files exclude. */
  async #ignored(tracked: readonly string[]): Promise<Set<string>> {
    if (tracked.length === 0) return new Set()
    const { code, stdout, stderr } = await gitResult(['check-ignore', '--stdin', '-z'], {
      cwd: this.repository,
      input: `${tracked.join('\0')}\0`,
    })
    // 1: none of them is ignored.
    if (code === 1) return new Set()
    if (code !== 0) {
      throw new CliError(
        `Cannot tell which files the repository ignores: git check-ignore failed: ${stderr.trim() || `exit code ${code}`}`,
      )
    }
    return new Set(stdout.split('\0').filter(file => file !== ''))
  }

  /**
   * `file` as git knows it: relative to the repository, at its real place
   * (through the mirror's symbolic links), with `/` separators. `null` when
   * it is outside the repository.
   */
  async #gitPath(file: string): Promise<string | null> {
    this.#root ??= realFolder(this.repository)
    const root = await this.#root
    const real = path.join(await realFolder(path.dirname(file)), path.basename(file))
    const relative = path.relative(root, real)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
    return relative.split(path.sep).join('/')
  }

  /**
   * Whether `tracked` is inside a submodule: a repository the mirror's
   * repository records (a gitlink), whose files git doesn't list. Another
   * repository a tool cloned there is not one: git ignores it or lists it as
   * untracked.
   */
  async #inSubmodule(tracked: string): Promise<boolean> {
    this.#submodules ??= gitOutput(['ls-files', '--stage', '-z'], { cwd: this.repository }).then(
      output =>
        (output ?? '')
          .split('\0')
          .filter(line => line.startsWith('160000 '))
          .map(line => line.slice(line.indexOf('\t') + 1)),
    )
    const submodules = await this.#submodules
    return submodules.some(submodule => tracked.startsWith(`${submodule}/`))
  }

  #changed(): Promise<Changes | null> {
    this.#changes ??= readMirrorChanges(this.repository).then(changes => {
      if (changes.status === 'read') return new Changes(changes.changes)
      if (changes.status === 'not-a-repository') return null
      throw new CliError(`Cannot compare copies with the repository: ${changes.reason}`)
    })
    return this.#changes
  }
}

/**
 * The real path of `folder` when it exists, or of its closest existing
 * parent folder followed by the rest (a file where a folder is expected
 * counts as missing).
 */
async function realFolder(folder: string): Promise<string> {
  try {
    return await realpath(folder)
  } catch (error) {
    const parent = path.dirname(folder)
    const code = errnoCode(error)
    if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === folder) throw error
    return path.join(await realFolder(parent), path.basename(folder))
  }
}

/** The changes of the mirror, by path; folders git doesn't track end with `/`. */
class Changes {
  readonly #kinds: ReadonlyMap<string, MirrorChange['kind']>
  readonly #folders: readonly string[]
  readonly deleted: readonly string[]

  constructor(changes: readonly MirrorChange[]) {
    this.#kinds = new Map(changes.map(change => [change.path, change.kind]))
    this.#folders = changes.filter(change => change.path.endsWith('/')).map(change => change.path)
    this.deleted = changes.filter(change => change.kind === 'deleted').map(change => change.path)
  }

  /** How git sees `file`: `undefined` when it is committed and unchanged. */
  kindOf(file: string): MirrorChange['kind'] | undefined {
    return (
      this.#kinds.get(file) ??
      (this.#folders.some(folder => file.startsWith(folder)) ? 'new' : undefined)
    )
  }
}

/**
 * The files of `folder` (links followed), relative to it with `/` separators.
 * `.git` (another repository's) is never one of them. A source folder that
 * is gone is an error; a subfolder gone meanwhile has no files. A link to a
 * folder containing it would never end: it is refused.
 */
async function walkFiles(
  folder: string,
  prefix = '',
  above: readonly string[] = [],
): Promise<string[]> {
  const real = await realpath(folder).catch(() => folder)
  if (above.includes(real)) {
    throw new CliError(`${folder} leads to a folder containing it, which makes a loop.`)
  }
  let entries: Dirent[]
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    if (prefix !== '' && (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ENOTDIR')) {
      return []
    }
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git') continue
    const full = path.join(folder, entry.name)
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const stats = entry.isSymbolicLink() ? await statOrNull(full) : entry
    if (stats?.isDirectory()) files.push(...(await walkFiles(full, relative, [...above, real])))
    else if (stats?.isFile()) files.push(relative)
  }
  return files
}
