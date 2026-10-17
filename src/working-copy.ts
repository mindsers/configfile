import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.ts'
import { errnoCode, messageOf } from './fsutil.ts'
import { redactUrl } from './output.ts'
import { git, gitOutput, gitResult } from './process.ts'
import { upstreamOf } from './sync.ts'

/**
 * The user's own clone of the dotfiles repository, where `modules adopt`
 * commits and from which `update` pushes. It must clone the repository the
 * mirror follows; `remote` is its name for it, `branch` the branch the mirror
 * follows.
 */
export interface WorkingCopy {
  readonly folder: string
  readonly remote: string
  readonly branch: string
}

/** An entry of a settings.json: its module folder (`files/zsh`) and `source_path`, normalized. */
export interface EntryKey {
  readonly module: string
  readonly source: string
}

/**
 * Checks that `folder` is a clone of the repository the mirror follows, and
 * finds which of its remotes that is.
 */
export async function openWorkingCopy(folder: string, mirror: string): Promise<WorkingCopy> {
  try {
    await lstat(path.join(folder, '.git'))
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      throw new CliError(`${folder} is not a git repository: give your working copy's folder.`)
    }
    throw new CliError(`Cannot read ${folder}: ${messageOf(error)}`, { cause: error })
  }
  const real = (target: string) => realpath(target).catch(() => path.resolve(target))
  if ((await real(folder)) === (await real(mirror))) {
    throw new CliError(
      `${folder} is configfile's copy of your dotfiles repository, which update resets: ` +
        'give your own working copy.',
    )
  }

  const upstream = await upstreamOf(mirror)
  const slash = upstream.indexOf('/')
  const mirrorRemote = upstream.slice(0, slash)
  const branch = upstream.slice(slash + 1)
  const url = (await gitOutput(['remote', 'get-url', mirrorRemote], { cwd: mirror }))?.trim()
  if (url == null || url === '') {
    throw new CliError(`Cannot read the URL of ${mirror}'s remote "${mirrorRemote}".`)
  }
  const wanted = await repositoryKey(url, mirror)

  const remotes = ((await gitOutput(['remote'], { cwd: folder })) ?? '')
    .split('\n')
    .map(name => name.trim())
    .filter(name => name !== '')
  for (const remote of remotes) {
    const other = await gitOutput(['remote', 'get-url', remote], {
      cwd: folder,
      allowFailure: true,
    })
    if (other != null && (await repositoryKey(other.trim(), folder)) === wanted) {
      return { folder, remote, branch }
    }
  }
  throw new CliError(
    `${folder} is not a clone of your dotfiles repository: none of its remotes is ${redactUrl(url)}.`,
  )
}

/**
 * What tells two URLs of a repository apart, whatever the protocol and user
 * used to reach it: the host and path (`github.com/me/dotfiles`) without a
 * trailing `.git`, or the real path of a local repository.
 */
export async function repositoryKey(url: string, cwd: string): Promise<string> {
  const trim = (value: string) => value.replace(/\/+$/, '').replace(/\.git$/, '')
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase()
  if (scheme === 'file') return localKey(decodeURIComponent(new URL(url).pathname), cwd)
  if (scheme != null) {
    try {
      const parsed = new URL(url)
      return `${parsed.hostname.toLowerCase()}/${trim(parsed.pathname.replace(/^\/+/, ''))}`
    } catch {
      return url
    }
  }
  if (/^[A-Za-z0-9][A-Za-z0-9+.-]*::./.test(url)) return url
  const colon = url.indexOf(':')
  const slash = url.indexOf('/')
  if (colon > 0 && (slash === -1 || colon < slash)) {
    const host = url.slice(0, colon).replace(/^[^@]*@/, '')
    return `${host.toLowerCase()}/${trim(url.slice(colon + 1).replace(/^\/+/, ''))}`
  }
  return localKey(url, cwd)
}

async function localKey(folder: string, cwd: string): Promise<string> {
  const resolved = path.resolve(cwd, folder)
  const real = await realpath(resolved).catch(() => resolved)
  return `file:${real.replace(/\/+$/, '')}`
}

/** Files of the working copy that are not committed, untracked ones included. */
export async function uncommittedFiles(copy: WorkingCopy): Promise<string[]> {
  const output = await gitOutput(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: copy.folder,
  })
  const files: string[] = []
  const fields = (output ?? '').split('\0')
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? ''
    if (field.length < 4) continue
    files.push(field.slice(3))
    // A rename names the original file in the next field.
    if (field[0] === 'R' || field[0] === 'C') index++
  }
  return files
}

/** The branch checked out, or `null` when none is (a detached HEAD). */
export async function currentBranch(copy: WorkingCopy): Promise<string | null> {
  const output = await gitOutput(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: copy.folder,
    allowFailure: true,
  })
  return output == null || output.trim() === '' ? null : output.trim()
}

/**
 * Brings the checked-out branch up to date with the remote: fetches, then
 * fast-forwards it when it is behind. Fails when it has diverged. Returns how
 * many commits it moved forward.
 */
export async function catchUp(copy: WorkingCopy): Promise<number> {
  const cwd = copy.folder
  const tracking = `refs/remotes/${copy.remote}/${copy.branch}`
  // Explicit: a clone of a single other branch has no such ref otherwise.
  await gitOutput(['fetch', '--quiet', copy.remote, `+refs/heads/${copy.branch}:${tracking}`], {
    cwd,
  })
  const counts = await gitOutput(['rev-list', '--left-right', '--count', `HEAD...${tracking}`], {
    cwd,
  })
  const [ahead = 0, behind = 0] = (counts ?? '').trim().split(/\s+/).map(Number)
  if (behind === 0) return 0
  if (ahead > 0) {
    throw new CliError(
      `${copy.folder} and ${copy.remote}/${copy.branch} have diverged: pull or rebase ` +
        `(git -C ${copy.folder} pull), then try again.`,
    )
  }
  await gitOutput(['merge', '--ff-only', '--quiet', tracking], { cwd })
  return behind
}

/** Commits a ref names, or `null` when it does not exist. */
async function revision(copy: WorkingCopy, name: string): Promise<string | null> {
  const output = await gitOutput(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], {
    cwd: copy.folder,
    allowFailure: true,
  })
  return output == null || output.trim() === '' ? null : output.trim()
}

/** What `push` sent: the remote's commit before (as last fetched) and after. */
export interface Pushed {
  readonly from: string | null
  readonly to: string
}

/**
 * Pushes the commits of the followed branch the remote lacks. Returns `null`
 * when there are none. Fails when the branch has diverged from the remote,
 * or when git push fails (its output is shown).
 */
export async function push(copy: WorkingCopy): Promise<Pushed | null> {
  const cwd = copy.folder
  const to = await revision(copy, `refs/heads/${copy.branch}`)
  if (to == null) throw new CliError(`${copy.folder} has no branch "${copy.branch}".`)
  const from = await revision(copy, `refs/remotes/${copy.remote}/${copy.branch}`)
  if (from === to) return null
  if (from != null) {
    // Only behind (fetched, not pulled yet): nothing to push.
    if (await isAncestor(cwd, to, from)) return null
    if (!(await isAncestor(cwd, from, to))) {
      throw new CliError(
        `${copy.branch} has diverged from ${copy.remote}/${copy.branch} in ${copy.folder}: ` +
          `pull or rebase (git -C ${copy.folder} pull), then push.`,
      )
    }
  }
  await git(['push', '--quiet', copy.remote, `refs/heads/${copy.branch}`], { cwd }, 'git push')
  return { from, to }
}

/**
 * The global entries copied (not linked) that the commits `from..to` of the
 * repository in `folder` add to the settings.json of the modules: those
 * whose target an identical file may already hold (see `modules adopt`).
 */
export async function addedCopyEntries(
  folder: string,
  { from, to }: { from: string; to: string },
): Promise<EntryKey[]> {
  const cwd = folder
  const changed = await gitOutput(
    ['diff', '--name-only', '--no-renames', '-z', from, to, '--', 'files'],
    {
      cwd,
    },
  )
  const settings = (changed ?? '')
    .split('\0')
    .filter(file => /^files\/[^/]+\/settings\.json$/.test(file))

  const added: EntryKey[] = []
  for (const file of settings) {
    const read = (commit: string) =>
      gitOutput(['show', `${commit}:${file}`], { cwd, allowFailure: true })
    const before = copiedEntries(await read(from))
    const module = path.posix.dirname(file)
    for (const entry of copiedEntries(await read(to))) {
      const known = before.some(old => old.source === entry.source && old.target === entry.target)
      if (!known) added.push({ module, source: entry.source })
    }
  }
  return added
}

/** Whether `commit` is on the working copy's followed branch (committed or pulled there). */
export async function isOnBranch(copy: WorkingCopy, commit: string): Promise<boolean> {
  // A commit the working copy has not fetched is not on its branch.
  if ((await revision(copy, commit)) == null) return false
  return isAncestor(copy.folder, commit, `refs/heads/${copy.branch}`)
}

/**
 * Whether `ancestor` is `commit` or one of its ancestors. Fails when git
 * cannot tell (an unknown commit), instead of answering no.
 */
async function isAncestor(cwd: string, ancestor: string, commit: string): Promise<boolean> {
  const result = await gitResult(['merge-base', '--is-ancestor', ancestor, commit], {
    cwd,
    input: '',
  })
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw new CliError(
    `git merge-base failed: ${result.stderr.trim() || `exit code ${result.code ?? 'unknown'}`}`,
  )
}

/** The global entries of a settings.json that are copied, or none when it cannot be read. */
function copiedEntries(content: string | null): { source: string; target: string }[] {
  if (content == null) return []
  let settings: unknown
  try {
    settings = JSON.parse(content)
  } catch {
    return []
  }
  const files = (settings as { files?: unknown } | null)?.files
  if (!Array.isArray(files)) return []
  return files.flatMap(entry => {
    const fields = entry as Record<string, unknown> | null
    if (
      fields == null ||
      fields.deploy !== 'global' ||
      fields.method === 'link' ||
      typeof fields.source_path !== 'string' ||
      typeof fields.target_path !== 'string'
    ) {
      return []
    }
    return [{ source: path.normalize(fields.source_path), target: fields.target_path.trim() }]
  })
}
