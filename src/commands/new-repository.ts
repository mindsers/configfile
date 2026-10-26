import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ConfigStore } from '../config.ts'
import type { Context } from '../context.ts'
import { CliError } from '../errors.ts'
import { inspectFolder, lstatOrNull, messageOf } from '../fsutil.ts'
import { redactUrl } from '../output.ts'
import { contains, resolveUserPath } from '../paths.ts'
import { git, gitClone, gitOutput } from '../process.ts'
import { starterFiles } from '../starter.ts'
import { repositoryKey, type WorkingCopy } from '../working-copy.ts'
import { syncAndRefresh } from './update.ts'

/** The remote of a mirror that has no commit yet, and the branch the mirror will follow. */
export interface EmptyRemote {
  readonly remote: string
  readonly url: string
  readonly branch: string
}

/** Where the working copy goes when no one says. */
const DEFAULT_WORKING_COPY = '~/dotfiles'

const COMMIT_MESSAGE = 'Start a dotfiles repository'

/**
 * The remote of the mirror in `folder` when it has no branch at all, or
 * `null`. Both the mirror and the remote are checked: a mirror cloned while
 * the remote was empty stays without commits until it is synced.
 */
export async function findEmptyRemote(folder: string): Promise<EmptyRemote | null> {
  const cwd = folder
  const read = async (args: string[]) =>
    (await gitOutput(args, { cwd, allowFailure: true }))?.trim() || null
  if ((await read(['rev-parse', '--verify', '--quiet', 'HEAD'])) != null) return null
  // The branch git took from the remote's default, when it cloned it.
  const branch = await read(['symbolic-ref', '--short', 'HEAD'])
  if (branch == null) return null
  const remote = (await read(['config', `branch.${branch}.remote`])) ?? 'origin'
  const url = await read(['remote', 'get-url', remote])
  if (url == null) return null
  const heads = await gitOutput(['ls-remote', '--heads', remote], { cwd })
  if ((heads ?? '').trim() !== '') return null
  return { remote, url, branch }
}

/**
 * Says the repository is empty, and offers to set it up: in the user's
 * working copy, which it clones when needed, it writes the starter files,
 * commits them as the user, pushes them, then syncs the mirror. Asked first
 * in a terminal (with the folder, unless `--working-copy` gives it); done
 * without one only with `--new-repository`. `done` says what is already done,
 * for errors.
 */
export async function offerNewRepository(
  {
    wanted,
    workingCopy,
    mirror,
    empty,
    done,
  }: {
    wanted: boolean | undefined
    workingCopy: string | undefined
    mirror: string
    empty: EmptyRemote
    done: string
  },
  store: ConfigStore,
  ctx: Context,
): Promise<void> {
  const { output, prompts } = ctx
  const shown = redactUrl(empty.url)
  const later = 'push a first commit to it from your own clone, then run "configfile update"'
  if (wanted === false) {
    output.info(`${shown} is empty: ${later}.`)
    return
  }
  if (wanted !== true) {
    if (!prompts.interactive) {
      // On stderr: a bootstrap script sees what it did not do.
      output.warn(
        `${shown} is empty: ${later}, or set it up with "configfile init --force --new-repository".`,
      )
      return
    }
    const create = await prompts.confirm({
      message: `${shown} is empty. Set up a new dotfiles repository in it?`,
      default: true,
    })
    if (!create) {
      output.info(`Nothing was set up: ${later}.`)
      return
    }
  }

  let target: Target
  try {
    target =
      workingCopy != null || !prompts.interactive
        ? await openTarget(resolveUserPath((workingCopy ?? DEFAULT_WORKING_COPY).trim(), ctx))
        : await askTarget()
    await checkIdentity(target.kind === 'clone' ? ctx.home : target.folder)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    throw new CliError(`${done}, but ${error.message}`, { cause: error })
  }

  const { folder } = target
  const copy: WorkingCopy = {
    folder,
    remote: target.kind === 'clone' ? 'origin' : target.remote,
    branch: empty.branch,
  }
  if (target.kind === 'clone') {
    await mkdir(folder, { recursive: true }).catch(error => {
      throw new CliError(`${done}, but ${folder} cannot be created: ${messageOf(error)}`, {
        cause: error,
      })
    })
    output.info(`Cloning ${shown} into ${folder}…`)
    try {
      await gitClone(empty.url, folder, ctx)
    } catch (error) {
      throw new CliError(`${done}, but ${messageOf(error)}`, { cause: error })
    }
    ctx.history.record({ kind: 'cloned', repository: shown, folder })
  }
  try {
    await store.setWorkingCopy(folder)
  } catch (error) {
    // Going on: the repository is set up all the same, and adopt can be told where it is.
    output.warn(`Cannot remember your working copy: ${messageOf(error)}`)
  }

  const files = starterFiles(empty.url)
  const paths = files.map(file => file.path)
  try {
    // The branch the mirror follows, whatever this clone was started on.
    await gitOutput(['symbolic-ref', 'HEAD', `refs/heads/${copy.branch}`], { cwd: folder })
    for (const file of files) {
      const destination = path.join(folder, ...file.path.split('/'))
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, file.content, {
        flag: 'wx',
        mode: file.executable ? 0o755 : 0o644,
      })
    }
    // Only these files: an existing clone may hold others, left as they are.
    await gitOutput(['add', '--', ...paths], { cwd: folder })
    // Shown: hooks, and a key to sign with, may ask for something.
    await git(
      ['commit', '--quiet', '--message', COMMIT_MESSAGE, '--', ...paths],
      { cwd: folder },
      'git commit',
    )
  } catch (error) {
    throw new CliError(
      `${done}, but the new repository is not committed: ${messageOf(error)} Its files are in ` +
        `${folder}: commit and push them, then run "configfile update".`,
      { cause: error },
    )
  }
  const to = (await gitOutput(['rev-parse', 'HEAD'], { cwd: folder }))?.trim() ?? ''

  try {
    await git(
      ['push', '--quiet', '--set-upstream', copy.remote, `refs/heads/${copy.branch}`],
      { cwd: folder },
      'git push',
    )
  } catch (error) {
    throw new CliError(
      `${done}, and the new repository is committed in ${folder}, but it was not pushed: ` +
        `${messageOf(error)} Push it (git -C ${folder} push --set-upstream ${copy.remote} ` +
        `${copy.branch}), then run "configfile update".`,
      { cause: error },
    )
  }
  ctx.history.record({ kind: 'pushed', folder, branch: copy.branch, from: null, to })
  output.info(`Set up a new dotfiles repository in ${folder}, and pushed it to ${shown}.`)

  await syncAndRefresh(ctx, mirror, { workingCopy: copy, deployHint: false })
  output.info(
    `Edit your dotfiles in ${folder}, push, then run "configfile update" on each machine; ` +
      'or add files of this machine with "configfile modules adopt".',
  )

  /** Asks where the working copy goes until the answer can be used. */
  async function askTarget(): Promise<Target> {
    for (;;) {
      const answer = await prompts.input({
        message: 'Your working copy (the clone where you edit your dotfiles):',
        default: DEFAULT_WORKING_COPY,
        required: true,
      })
      try {
        return await openTarget(resolveUserPath(answer.trim(), ctx))
      } catch (error) {
        if (!(error instanceof CliError)) throw error
        output.warn(error.message)
      }
    }
  }

  /** Checks that `folder` can be the working copy of the new repository. */
  async function openTarget(folder: string): Promise<Target> {
    const real = (target: string) => realpath(target).catch(() => path.resolve(target))
    const [realFolder, realMirror] = await Promise.all([real(folder), real(mirror)])
    if (contains(realFolder, realMirror) || contains(realMirror, realFolder)) {
      throw new CliError(
        `${folder} is configfile's copy of your dotfiles repository, which update resets: ` +
          'choose another folder for your working copy.',
      )
    }
    switch (await inspectFolder(folder)) {
      case 'missing':
      case 'empty':
        return { kind: 'clone', folder }
      case 'not-a-directory':
        throw new CliError(`${folder} exists and is not a folder: choose another one.`)
      case 'not-empty':
        throw new CliError(
          `${folder} is not empty and is not a git repository: choose another folder.`,
        )
      case 'git-repository':
        return { kind: 'existing', folder, remote: await cloneRemote(folder) }
    }
  }

  /** The remote of the existing clone in `folder` that is the empty repository. */
  async function cloneRemote(folder: string): Promise<string> {
    const cwd = folder
    const wanted = await repositoryKey(empty.url, mirror)
    let remote: string | undefined
    const names = ((await gitOutput(['remote'], { cwd })) ?? '').split('\n')
    for (const name of names.map(line => line.trim()).filter(line => line !== '')) {
      const url = await gitOutput(['remote', 'get-url', name], { cwd, allowFailure: true })
      if (url != null && (await repositoryKey(url.trim(), folder)) === wanted) {
        remote = name
        break
      }
    }
    if (remote == null) {
      throw new CliError(`${folder} is not a clone of ${shown}: choose another folder.`)
    }
    const head = await gitOutput(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd,
      allowFailure: true,
    })
    if (head != null && head.trim() !== '') {
      throw new CliError(
        `${folder} already has commits: push them, then run "configfile update" (or choose ` +
          'another folder).',
      )
    }
    for (const file of starterFiles(empty.url)) {
      if ((await lstatOrNull(path.join(folder, ...file.path.split('/')))) != null) {
        throw new CliError(`${folder} already has ${file.path}: choose another folder.`)
      }
    }
    return remote
  }
}

/** The working copy to set up: a folder to clone into, or a clone that has no commit yet. */
type Target =
  | { readonly kind: 'clone'; readonly folder: string }
  | { readonly kind: 'existing'; readonly folder: string; readonly remote: string }

/**
 * Fails when git cannot tell who commits, before anything is written. `cwd`
 * is the clone, when it exists: its own settings count.
 */
async function checkIdentity(cwd: string): Promise<void> {
  for (const ident of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const known = await gitOutput(['var', ident], { cwd, allowFailure: true })
    if (known == null || known.trim() === '') {
      throw new CliError(
        'git does not know who you are, to commit the new repository. Set your name and ' +
          'email (git config --global user.name "Your Name", git config --global user.email ' +
          'you@example.com), then run "configfile init --force --new-repository".',
      )
    }
  }
}
