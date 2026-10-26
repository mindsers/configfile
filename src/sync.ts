import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.ts'
import { writeFileAtomic } from './fsutil.ts'
import { git, gitBuffer, gitOutput } from './process.ts'

export interface SyncResult {
  /** The remote branch the mirror follows, such as `origin/main`. */
  readonly upstream: string
  /** Commit of the mirror before and after syncing (`null`: none yet). */
  readonly before: string | null
  readonly after: string
  /** Patch of the local changes found in the mirror, saved before syncing. */
  readonly saved: string | null
  /** The files of the repository whose changes were saved (relative, with `/`). */
  readonly savedPaths: readonly string[]
}

/** Identity and settings for the commit that saves local changes. */
const SAVE_COMMIT = [
  '-c',
  'user.name=configfile',
  '-c',
  'user.email=configfile@localhost',
  '-c',
  'commit.gpgsign=false',
]

/**
 * Makes the mirror of the dotfiles repository identical to the remote. The
 * mirror is not a working copy: local changes and unpushed commits (for
 * example edits made through deployed links) are saved as a patch in
 * `savedFolder`, so that nothing is lost, then the mirror is reset. Changes
 * the remote already has (pushed from a working copy) need no saving. Syncing
 * never stops on conflicts.
 */
export async function syncMirror(
  folder: string,
  savedFolder: string,
  { onSaved }: { onSaved?: (file: string, paths: readonly string[]) => void } = {},
): Promise<SyncResult> {
  const cwd = folder
  await git(['fetch', '--prune', '--quiet'], { cwd }, 'git fetch')

  const upstream = await upstreamOf(folder)
  const before = await revision('HEAD', folder)

  let saved: { file: string; paths: readonly string[] } | null = null
  const dirty =
    ((await gitOutput(['status', '--porcelain', '--untracked-files=all'], { cwd })) ?? '') !== ''
  const ahead =
    before == null
      ? 0
      : Number((await gitOutput(['rev-list', '--count', `${upstream}..HEAD`], { cwd }))?.trim())

  if (dirty || ahead > 0) {
    if (dirty) {
      await gitOutput(['add', '--all'], { cwd })
      await gitOutput(
        [
          ...SAVE_COMMIT,
          'commit',
          '--quiet',
          '--no-verify',
          '--message',
          'Local changes saved by configfile before syncing',
        ],
        { cwd },
      )
    }
    saved = await savePatch(folder, upstream, savedFolder)
    // Reported before resetting, so the patch is never lost if the reset fails.
    if (saved != null) onSaved?.(saved.file, saved.paths)
  }

  await gitOutput(['reset', '--hard', '--quiet', upstream], { cwd })
  const after = await revision('HEAD', folder)
  if (after == null) throw new CliError(`Cannot read the commit of ${folder} after syncing.`)

  return { upstream, before, after, saved: saved?.file ?? null, savedPaths: saved?.paths ?? [] }
}

/** The remote branch followed by the mirror: its upstream, or the remote's default branch. */
export async function upstreamOf(folder: string): Promise<string> {
  const cwd = folder
  const tracked = await gitOutput(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { cwd, allowFailure: true },
  )
  if (tracked != null && tracked.trim() !== '') return tracked.trim()

  const remoteDefault = await gitOutput(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd,
    allowFailure: true,
  })
  if (remoteDefault != null && remoteDefault.trim() !== '') return remoteDefault.trim()

  // Cloning it again would not help: the remote has no branch to follow yet.
  const branches = await gitOutput(['for-each-ref', '--count=1', 'refs/remotes'], { cwd })
  if ((await revision('HEAD', folder)) == null && (branches ?? '').trim() === '') {
    throw new CliError(
      'Your dotfiles repository is empty. Push a first commit to it from your own clone, or ' +
        'set it up with "configfile init --force --new-repository", then try again.',
    )
  }
  throw new CliError(
    `${folder} follows no remote branch. Run "configfile init --force" to clone the repository again.`,
  )
}

async function revision(name: string, folder: string): Promise<string | null> {
  const output = await gitOutput(['rev-parse', '--verify', '--quiet', name], {
    cwd: folder,
    allowFailure: true,
  })
  return output == null || output.trim() === '' ? null : output.trim()
}

/** Above this many files, the patch holds the whole commits: their names would not fit on git's command line. */
const MAX_LISTED_PATHS = 1000

/**
 * Writes the commits of the mirror that are not on `upstream` as a patch that
 * `git apply` and `git am` take, limited to the files they change whose
 * content differs from `upstream`. Returns `null`, saving nothing, when there
 * are none. The patch is written as git gives it, byte for byte.
 */
async function savePatch(
  folder: string,
  upstream: string,
  savedFolder: string,
): Promise<{ file: string; paths: readonly string[] } | null> {
  const cwd = folder
  // Every commit of the mirror that the remote doesn't have, even when the
  // remote's history no longer shares any commit with the mirror's.
  const range = `${upstream}..HEAD`
  const touched = await pathList(folder, [
    'log',
    '--format=',
    '--name-only',
    '--no-renames',
    '-z',
    range,
  ])
  const differing = new Set(
    await pathList(folder, ['diff', '--name-only', '--no-renames', '-z', upstream, 'HEAD']),
  )
  const paths = [...new Set(touched)].filter(file => differing.has(file)).sort()
  if (paths.length === 0) return null

  const formatPatch = ['format-patch', '--no-renames', '--stdout', range]
  // A name git gave in another encoding than UTF-8 cannot be passed back to it.
  const limited = paths.length <= MAX_LISTED_PATHS && !paths.some(file => file.includes('\uFFFD'))
  let patch = limited
    ? await gitBuffer(['--literal-pathspecs', ...formatPatch, '--', ...paths], { cwd })
    : Buffer.alloc(0)
  if (patch.length === 0) patch = await gitBuffer(formatPatch, { cwd })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(savedFolder, `${stamp}.patch`)
  await mkdir(savedFolder, { recursive: true, mode: 0o700 })
  await writeFileAtomic(file, patch, { mode: 0o600 })
  return { file, paths }
}

/** The file names a git command lists, separated by NUL (`-z`). */
async function pathList(folder: string, args: string[]): Promise<string[]> {
  const output = await gitOutput(args, { cwd: folder })
  return (output ?? '').split('\0').filter(file => file !== '')
}
