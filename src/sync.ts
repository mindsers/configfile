import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.ts'
import { writeFileAtomic } from './fsutil.ts'
import { git, gitOutput } from './process.ts'

export interface SyncResult {
  /** The remote branch the mirror follows, such as `origin/main`. */
  readonly upstream: string
  /** Commit of the mirror before and after syncing (`null`: none yet). */
  readonly before: string | null
  readonly after: string
  /** Patch of the local changes found in the mirror, saved before syncing. */
  readonly saved: string | null
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
 * `savedFolder`, so that nothing is lost, then the mirror is reset. Syncing
 * never stops on conflicts.
 */
export async function syncMirror(
  folder: string,
  savedFolder: string,
  { onSaved }: { onSaved?: (file: string) => void } = {},
): Promise<SyncResult> {
  const cwd = folder
  await git(['fetch', '--prune', '--quiet'], { cwd }, 'git fetch')

  const upstream = await upstreamOf(folder)
  const before = await revision('HEAD', folder)

  let saved: string | null = null
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
    onSaved?.(saved)
  }

  await gitOutput(['reset', '--hard', '--quiet', upstream], { cwd })
  const after = await revision('HEAD', folder)
  if (after == null) throw new CliError(`Cannot read the commit of ${folder} after syncing.`)

  return { upstream, before, after, saved }
}

/** The remote branch followed by the mirror: its upstream, or the remote's default branch. */
async function upstreamOf(folder: string): Promise<string> {
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

/** Writes the commits of the mirror that are not on `upstream` as a `git am` patch. */
async function savePatch(folder: string, upstream: string, savedFolder: string): Promise<string> {
  const cwd = folder
  const base = (
    await gitOutput(['merge-base', upstream, 'HEAD'], { cwd, allowFailure: true })
  )?.trim()
  const range = base == null || base === '' ? ['--root', 'HEAD'] : [`${base}..HEAD`]
  const patch = (await gitOutput(['format-patch', '--stdout', ...range], { cwd })) ?? ''

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(savedFolder, `${stamp}.patch`)
  await mkdir(savedFolder, { recursive: true, mode: 0o700 })
  await writeFileAtomic(file, patch, { mode: 0o600 })
  return file
}
