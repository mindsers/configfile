import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import { ConfigStore } from '../config.ts'
import type { Context } from '../context.ts'
import { CliError } from '../errors.ts'
import { redactUrl } from '../output.ts'
import { configfilePaths, resolveUserPath } from '../paths.ts'
import { ensureGit, gitClone } from '../process.ts'

interface InitOptions {
  force?: boolean
  repo?: string
  folder?: string
}

export function registerInitCommand(program: Command, ctx: Context): void {
  program
    .command('init')
    .alias('i')
    .description('clone your dotfiles repository, which configfile then keeps in sync')
    .option('-f, --force', 'overwrite the existing configuration without asking')
    .option('--repo <url>', 'dotfiles repository URL (skips the question)')
    .option('--folder <path>', 'where to clone the repository (default: ~/.configfile/dotfiles)')
    .action((options: InitOptions) => init(options, ctx))
}

async function init(options: InitOptions, ctx: Context): Promise<void> {
  const { output, prompts } = ctx
  const store = new ConfigStore(ctx.home)
  const previous = await store.readPartial()

  if (!prompts.interactive) {
    const missing = [
      store.exists() && options.force !== true && '--force (a configuration already exists)',
      options.repo == null && '--repo <url>',
    ].filter(Boolean)
    if (missing.length > 0) {
      throw new CliError(
        `Not running in an interactive terminal. Also pass: ${missing.join(', ')}.`,
      )
    }
  }

  if (store.exists() && options.force !== true) {
    const overwrite = await prompts.confirm({
      message: `A configuration already exists (${store.path}). Overwrite it?`,
      default: false,
    })
    if (!overwrite) {
      output.info('Nothing changed.')
      return
    }
  }

  // configfile's copy is a mirror it keeps in sync, not a working copy: by
  // default it lives in configfile's own folder. An existing one is kept.
  const own = configfilePaths(ctx.home)
  const folderPath =
    options.folder != null
      ? resolveUserPath(options.folder.trim(), ctx)
      : (previous.folderPath ?? own.dotfiles)
  const folder = await inspectFolder(folderPath)
  // A clone needs git: checked before asking for the URL, so a missing git is
  // found before the URL is typed and before the folder to clone into is created.
  if (folder === 'missing' || folder === 'empty') await ensureGit()

  const repoUrl = (
    options.repo ??
    (await prompts.input({
      message: 'Dotfiles repository URL:',
      required: true,
      ...(previous.repoUrl != null && { default: previous.repoUrl }),
    }))
  ).trim()
  if (repoUrl === '') throw new CliError('A repository URL is required.')
  if (redactUrl(repoUrl) !== repoUrl) {
    output.warn(
      'The repository URL contains credentials: they are saved in the configuration and in ' +
        "git's settings. Prefer an SSH key or a git credential helper.",
    )
  }

  if (folderPath === own.dotfiles) {
    await mkdir(own.dir, { recursive: true, mode: 0o700 })
  }

  switch (folder) {
    case 'not-a-directory':
      throw new CliError(`${folderPath} exists and is not a folder.`)
    case 'not-empty':
      throw new CliError(
        `${folderPath} is not empty and is not a git repository. Choose another folder.`,
      )
    case 'git-repository':
      output.info(`${folderPath} already contains a git repository. It is used as is.`)
      ctx.history.record({ kind: 'reused', repository: redactUrl(repoUrl), folder: folderPath })
      break
    case 'missing':
    case 'empty':
      await mkdir(folderPath, { recursive: true }).catch(error => {
        throw new CliError(`Cannot create ${folderPath}: ${(error as Error).message}`, {
          cause: error,
        })
      })
      output.info(`Cloning ${redactUrl(repoUrl)} into ${folderPath}…`)
      await gitClone(repoUrl, folderPath, ctx)
      ctx.history.record({ kind: 'cloned', repository: redactUrl(repoUrl), folder: folderPath })
      break
  }

  try {
    await store.write({ repoUrl, folderPath })
  } catch (error) {
    throw new CliError(
      `${(error as Error).message} The repository is in ${folderPath}: fix the problem and run ` +
        '"configfile init" again, it will reuse it.',
      { cause: error },
    )
  }
  ctx.history.record({ kind: 'configured', file: store.path })
  output.success(`configfile is ready. Configuration saved to ${store.path}.`)
}

async function inspectFolder(folderPath: string) {
  const fail = (error: unknown): never => {
    throw new CliError(`Cannot use ${folderPath}: ${(error as Error).message}`, { cause: error })
  }

  const link = await lstat(folderPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail(error)
  })
  if (link == null) return 'missing'

  const stats = await stat(folderPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`${folderPath} is a broken symbolic link.`)
    }
    return fail(error)
  })

  if (!stats.isDirectory()) return 'not-a-directory'
  if (existsSync(path.join(folderPath, '.git'))) return 'git-repository'
  if ((await readdir(folderPath).catch(fail)).length > 0) return 'not-empty'
  return 'empty'
}
