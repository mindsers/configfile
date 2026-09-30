import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import { ConfigStore } from '../config.js'
import type { Context } from '../context.js'
import { CliError } from '../errors.js'
import { resolveUserPath } from '../paths.js'
import { gitClone } from '../process.js'

const DEFAULT_FOLDER = '~/.dotfiles'

interface InitOptions {
  force?: boolean
  repo?: string
  folder?: string
}

export function registerInitCommand(program: Command, ctx: Context): void {
  program
    .command('init')
    .alias('i')
    .description('clone your dotfiles repository and save its location')
    .option('-f, --force', 'overwrite the existing configuration without asking')
    .option('--repo <url>', 'dotfiles repository URL (skips the question)')
    .option('--folder <path>', 'where to clone the repository (skips the question)')
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
      options.folder == null && '--folder <path>',
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

  const repoUrl = (
    options.repo ??
    (await prompts.input({
      message: 'Dotfiles repository URL:',
      required: true,
      ...(previous.repoUrl != null && { default: previous.repoUrl }),
    }))
  ).trim()
  if (repoUrl === '') throw new CliError('A repository URL is required.')

  const folderInput =
    options.folder ??
    (await prompts.input({
      message: 'Local folder for the repository:',
      required: true,
      default: previous.folderPath ?? DEFAULT_FOLDER,
    }))
  const folderPath = resolveUserPath(folderInput.trim(), ctx)

  switch (await inspectFolder(folderPath)) {
    case 'not-a-directory':
      throw new CliError(`${folderPath} exists and is not a folder.`)
    case 'not-empty':
      throw new CliError(
        `${folderPath} is not empty and is not a git repository. Choose another folder.`,
      )
    case 'git-repository':
      output.info(`${folderPath} already contains a git repository. It is used as is.`)
      break
    case 'missing':
    case 'empty':
      await mkdir(folderPath, { recursive: true }).catch(error => {
        throw new CliError(`Cannot create ${folderPath}: ${(error as Error).message}`)
      })
      output.info(`Cloning ${repoUrl} into ${folderPath}…`)
      await gitClone(repoUrl, folderPath, ctx)
      break
  }

  try {
    await store.write({ repoUrl, folderPath })
  } catch (error) {
    throw new CliError(
      `${(error as Error).message} The repository is in ${folderPath}: fix the problem and run ` +
        '"configfile init" again, it will reuse it.',
    )
  }
  output.success(`configfile is ready. Configuration saved to ${store.path}.`)
}

async function inspectFolder(folderPath: string) {
  const fail = (error: unknown): never => {
    throw new CliError(`Cannot use ${folderPath}: ${(error as Error).message}`)
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
