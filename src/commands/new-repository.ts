import type { Stats } from 'node:fs'
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ConfigStore } from '../config.ts'
import type { Context } from '../context.ts'
import { CliError } from '../errors.ts'
import { errnoCode, inspectFolder, lstatOrNull, messageOf, realpathOfExisting } from '../fsutil.ts'
import { redactUrl, sentence, shellQuote } from '../output.ts'
import { contains, resolveUserPath } from '../paths.ts'
import { git, gitClone, gitOutput, gitResult } from '../process.ts'
import { type StarterFile, starterFiles } from '../starter.ts'
import { hasCommit } from '../sync.ts'
import { repositoryKey } from '../working-copy.ts'
import { syncAndRefresh } from './update.ts'

/** A repository with no commit yet, which configfile's copy was cloned from. */
export interface EmptyRemote {
  /** As configured, without the rewrites of `url.<base>.insteadOf`, which may hold a token. */
  readonly url: string
  /** The branch configfile's copy will follow: the one to push. */
  readonly branch: string
}

/** The working copy's folder when `--working-copy` does not give it. */
const DEFAULT_WORKING_COPY = '~/dotfiles'

const COMMIT_MESSAGE = 'Start a dotfiles repository'

/**
 * The repository configfile's copy in `folder` was cloned from, when neither
 * has a commit yet (the remote: no branch at all), or `null` when either has
 * one. The remote is asked too: a copy cloned while the remote was empty has
 * no commit until it is synced, even after a push. Fails when it cannot tell.
 */
export async function findEmptyRemote(folder: string): Promise<EmptyRemote | null> {
  const cwd = folder
  const head = await gitResult(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, input: '' })
  if (head.code === 0) return null
  // 1: HEAD names a branch with no commit yet. Anything else: git cannot read the repository.
  if (head.code !== 1) {
    throw new CliError(
      `Cannot read the commit of ${folder}: ${head.stderr.trim() || `exit code ${head.code}`}`,
    )
  }
  // The remote's default branch, which git (2.31+, with protocol v2) takes when
  // it clones an empty repository; otherwise init.defaultBranch.
  const branch = ((await gitOutput(['symbolic-ref', '--short', 'HEAD'], { cwd })) ?? '').trim()
  const config = async (key: string) =>
    (await gitOutput(['config', '--get', key], { cwd, allowFailure: true }))?.trim() || null
  const remote = (await config(`branch.${branch}.remote`)) ?? 'origin'
  const url = await config(`remote.${remote}.url`)
  if (url == null) throw new CliError(`${folder} has no remote "${remote}" to push to.`)
  const heads = await gitOutput(['ls-remote', '--heads', remote], { cwd })
  if ((heads ?? '').trim() !== '') return null
  return { url, branch }
}

/**
 * The command that sets the repository up, for messages: the URL is left out
 * when it holds credentials.
 */
export function setUpCommand(url: string, workingCopy?: string): string {
  const repo = redactUrl(url) === url ? shellQuote(url) : '<url>'
  const folder = workingCopy == null ? '' : ` --working-copy ${shellQuote(workingCopy)}`
  return `configfile init --force --repo ${repo} --new-repository${folder}`
}

/**
 * Says the repository is empty, and offers to set it up: in the user's
 * working copy, which it clones when needed and remembers as `working_copy`
 * (even when a later step fails), it writes the starter files, commits them
 * as the user, pushes them, then syncs the mirror. Without `--new-repository`
 * (`wanted`) it asks first in a terminal, and only says the repository is
 * empty without one. The folder is `--working-copy`; otherwise it is asked in
 * a terminal (~/dotfiles by default), and is ~/dotfiles without one. `done`
 * says what is already done, for errors. Returns whether it set it up.
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
): Promise<boolean> {
  const { output, prompts } = ctx
  const shown = redactUrl(empty.url)
  const later = 'push a first commit to it from your own clone, then run "configfile update"'
  if (wanted === false) {
    output.info(`${shown} is empty: ${later}.`)
    return false
  }
  if (wanted !== true) {
    if (!prompts.interactive) {
      // On stderr: a bootstrap script sees what it did not do.
      output.warn(
        `${shown} is empty: ${later}, or set it up with "${setUpCommand(empty.url, workingCopy)}".`,
      )
      return false
    }
    const create = await prompts.confirm({
      message: `${shown} is empty. Set up a new dotfiles repository in it?`,
      default: true,
    })
    if (!create) {
      output.info(`Nothing was set up: ${later}.`)
      return false
    }
  }

  const files = starterFiles(empty.url)
  let target: Target
  if (workingCopy != null || !prompts.interactive) {
    const folder = workingCopy ?? resolveUserPath(DEFAULT_WORKING_COPY, ctx)
    try {
      target = await openTarget(folder)
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      throw new CliError(
        `${done}, but ${sentence(error.message)} Choose another folder: ` +
          `${setUpCommand(empty.url)} --working-copy <folder>`,
        { cause: error },
      )
    }
  } else {
    target = await askTarget()
  }
  const { folder } = target

  if (target.kind === 'clone') {
    try {
      await mkdir(folder, { recursive: true })
    } catch (error) {
      throw new CliError(`${done}, but ${folder} cannot be created: ${messageOf(error)}`, {
        cause: error,
      })
    }
    output.info(`Cloning ${shown} into ${folder}…`)
    try {
      await gitClone(empty.url, folder, ctx)
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      throw new CliError(
        `${done}, but ${sentence(error.message)} Once fixed, run "${setUpCommand(empty.url, folder)}".`,
        { cause: error },
      )
    }
    ctx.history.record({ kind: 'cloned', repository: shown, folder })
  }
  const remote = target.kind === 'existing' ? target.remote : await remoteOf(folder)
  if (remote == null) {
    throw new CliError(`${done}, but ${folder} has no remote for ${shown}.`)
  }
  try {
    await store.setWorkingCopy(folder)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    // Not fatal: the repository can be set up all the same, and adopt be given it.
    output.warn(`Cannot remember your working copy: ${messageOf(error)} Give --into to adopt.`)
  }

  // After the clone, inside it: its settings (includeIf) may give the identity.
  const unknown = await identityProblem(folder)
  if (unknown != null) {
    throw new CliError(
      `${done}, but git has no name and email of yours to commit with (${unknown}). configfile ` +
        "never commits with one git guesses: set yours (git config --global user.name 'Your " +
        "Name', git config --global user.email you@example.com), then run " +
        `"${setUpCommand(empty.url, folder)}".`,
    )
  }

  const { branch } = empty
  const { to, switchedFrom } = await commitStarter(folder, branch, files, {
    done,
    retry: setUpCommand(empty.url, folder),
  })
  if (switchedFrom != null) {
    output.info(
      `${folder} is now on ${branch}, the branch configfile follows (it was on ${switchedFrom}).`,
    )
  }

  try {
    await git(
      ['push', '--quiet', '--set-upstream', remote, `refs/heads/${branch}`],
      { cwd: folder },
      'git push',
    )
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    throw new CliError(
      `${done}, and the new repository is committed in ${folder}, but it was not pushed: ` +
        `${sentence(error.message)} Push it (git -C ${shellQuote(folder)} push --set-upstream ` +
        `${remote} ${branch}), then run "configfile update".`,
      { cause: error },
    )
  }
  ctx.history.record({ kind: 'pushed', folder, branch, from: null, to })
  output.info(`Set up a new dotfiles repository in ${folder}, and pushed it to ${shown}.`)

  try {
    // No working copy to look at: the mirror had no commit, so no file of this
    // machine can already be the repository's version.
    await syncAndRefresh(ctx, mirror, { workingCopy: null, deployHint: false })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    throw new CliError(
      `${done}, and the new repository is pushed from ${folder}, but configfile's copy of it ` +
        `could not be synced: ${sentence(error.message)} Run "configfile update".`,
      { cause: error },
    )
  }
  output.info(
    `Edit your dotfiles in ${folder}, push, then run "configfile update" on each machine; ` +
      'or add files of this machine with "configfile modules adopt".',
  )
  return true

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
        output.warn(`${sentence(error.message)} Choose another folder.`)
      }
    }
  }

  /** Checks that `folder` can be the working copy of the new repository. */
  async function openTarget(folder: string): Promise<Target> {
    let real: string
    let realMirror: string
    try {
      // Through the closest existing parent: a symbolic link there counts too.
      ;[real, realMirror] = await Promise.all([
        realpathOfExisting(folder),
        realpathOfExisting(mirror),
      ])
    } catch (error) {
      throw new CliError(`Cannot use ${folder}: ${messageOf(error)}`, { cause: error })
    }
    const copy = "configfile's copy of your dotfiles repository"
    if (real === realMirror) throw new CliError(`${folder} is ${copy}, which update resets.`)
    if (contains(realMirror, real)) {
      throw new CliError(`${folder} is inside ${copy} (${mirror}), which update resets.`)
    }
    if (contains(real, realMirror)) throw new CliError(`${folder} holds ${copy} (${mirror}).`)

    switch (await inspectFolder(folder)) {
      case 'missing':
      case 'empty':
        return { kind: 'clone', folder }
      case 'not-a-directory':
        throw new CliError(`${folder} exists and is not a folder.`)
      case 'not-empty':
        throw new CliError(`${folder} is not empty and is not a git repository.`)
      case 'git-repository':
        return { kind: 'existing', folder, remote: await checkClone(folder) }
    }
  }

  /**
   * The remote of the existing clone in `folder` that is the empty
   * repository. Fails when there is none, when the clone has commits, or
   * when the first commit would overwrite one of its files.
   */
  async function checkClone(folder: string): Promise<string> {
    const remote = await remoteOf(folder)
    if (remote == null) throw new CliError(`${folder} is not a clone of ${shown}.`)
    if (await hasCommit(folder)) {
      throw new CliError(
        `${folder} already has commits: if they are your dotfiles, push them, then run ` +
          '"configfile update".',
      )
    }
    for (const file of files) {
      let found: Stats | null
      try {
        found = await lstatOrNull(pathOf(folder, file))
      } catch (error) {
        throw new CliError(
          `${folder} has something in the way of ${file.path} (${messageOf(error)}).`,
          { cause: error },
        )
      }
      if (found != null) throw new CliError(`${folder} already has ${file.path}.`)
    }
    return remote
  }

  /**
   * The remote of the clone in `folder` that is the empty repository, or
   * `null`. Each URL is read as configured, and a relative one resolved from
   * its own repository.
   */
  async function remoteOf(folder: string): Promise<string | null> {
    const cwd = folder
    const key = await repositoryKey(empty.url, mirror)
    const names = ((await gitOutput(['remote'], { cwd })) ?? '').split('\n')
    for (const name of names.map(line => line.trim()).filter(line => line !== '')) {
      const url = await gitOutput(['config', '--get', `remote.${name}.url`], {
        cwd,
        allowFailure: true,
      })
      if (url != null && (await repositoryKey(url.trim(), folder)) === key) return name
    }
    return null
  }
}

/** The working copy to set up: a folder to clone into, or a clone that has no commit yet. */
type Target =
  | { readonly kind: 'clone'; readonly folder: string }
  | { readonly kind: 'existing'; readonly folder: string; readonly remote: string }

/**
 * Writes the starter files into the working copy in `folder`, on `branch`,
 * and commits them. When anything fails, what it wrote is removed and the
 * branch put back, so that running init again (`retry`) finds the clone as
 * it was. Returns the commit, and the branch the clone was on when it changed.
 */
async function commitStarter(
  folder: string,
  branch: string,
  files: readonly StarterFile[],
  { done, retry }: { done: string; retry: string },
): Promise<{ to: string; switchedFrom: string | null }> {
  const cwd = folder
  const paths = files.map(file => file.path)
  const written: string[] = []
  const created: string[] = []
  const wanted = `refs/heads/${branch}`
  let previous: string | null = null
  try {
    previous = ((await gitOutput(['symbolic-ref', 'HEAD'], { cwd })) ?? '').trim()
    // The branch the mirror follows, whatever this clone was started on.
    if (previous !== wanted) await gitOutput(['symbolic-ref', 'HEAD', wanted], { cwd })
    for (const file of files) {
      const destination = pathOf(folder, file)
      const first = await mkdir(path.dirname(destination), { recursive: true })
      if (first != null) created.push(...foldersFrom(first, path.dirname(destination)))
      await writeFile(destination, file.content, {
        flag: 'wx',
        mode: file.executable ? 0o755 : 0o644,
      })
      written.push(destination)
    }
    // Only these files: an existing clone may hold others, left as they are.
    await gitOutput(['add', '--', ...paths], { cwd })
    // Shown: hooks, and a key to sign with, may ask for something.
    // Never with an identity git guesses (see `identityProblem`).
    const commit = ['-c', 'user.useConfigOnly=true', 'commit', '--quiet']
    await git([...commit, '--message', COMMIT_MESSAGE, '--', ...paths], { cwd }, 'git commit')
    const to = ((await gitOutput(['rev-parse', 'HEAD'], { cwd })) ?? '').trim()
    const switchedFrom = previous === wanted ? null : previous.replace(/^refs\/heads\//, '')
    return { to, switchedFrom }
  } catch (error) {
    if (!(error instanceof CliError) && errnoCode(error) == null) throw error
    const left = await undo()
    const failed = `${done}, but the new repository could not be committed: ${sentence(messageOf(error))}`
    if (left.length > 0) {
      throw new CliError(
        `${failed} These could not be undone: ${left.join('; ')}. Check ` +
          `"git -C ${shellQuote(folder)} status".`,
        { cause: error },
      )
    }
    throw new CliError(`${failed} ${folder} is as it was: once fixed, run "${retry}".`, {
      cause: error,
    })
  }

  /** Removes what was written, and puts the branch back. Returns what it could not undo. */
  async function undo(): Promise<string[]> {
    const left: string[] = []
    const attempt = async (what: string, step: () => Promise<unknown>) => {
      try {
        await step()
      } catch (error) {
        left.push(`${what} (${messageOf(error)})`)
      }
    }
    await attempt('unstaging the starter files', () =>
      gitOutput(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...paths], { cwd }),
    )
    // Written with "wx": configfile created each of them.
    for (const file of written) await attempt(`removing ${file}`, () => rm(file, { force: true }))
    for (const createdFolder of created.toReversed()) {
      await attempt(`removing ${createdFolder}`, async () => {
        try {
          await rmdir(createdFolder)
        } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errnoCode(error) ?? '')) throw error
        }
      })
    }
    if (previous != null && previous !== '' && previous !== wanted) {
      const back = previous
      await attempt(`putting ${folder} back on ${back}`, () =>
        gitOutput(['symbolic-ref', 'HEAD', back], { cwd }),
      )
    }
    return left
  }
}

/** `first` and the folders between it and `last`, which `mkdir` created. */
function foldersFrom(first: string, last: string): string[] {
  const folders = [first]
  let folder = first
  for (const part of path.relative(first, last).split(path.sep).filter(Boolean)) {
    folder = path.join(folder, part)
    folders.push(folder)
  }
  return folders
}

/** Where `file` goes in the working copy in `folder`. */
function pathOf(folder: string, file: StarterFile): string {
  return path.join(folder, ...file.path.split('/'))
}

/**
 * Why git cannot tell who commits in `cwd` without guessing (from the
 * account and host names), or `null` when it can: the name and email come
 * from git's settings or from GIT_AUTHOR_* and GIT_COMMITTER_*.
 */
async function identityProblem(cwd: string): Promise<string | null> {
  for (const ident of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const result = await gitResult(['-c', 'user.useConfigOnly=true', 'var', ident], {
      cwd,
      input: '',
    })
    if (result.code === 0) continue
    const lines = result.stderr.split('\n').filter(line => line.trim() !== '')
    return lines.at(-1)?.trim() ?? `exit code ${result.code}`
  }
  return null
}
