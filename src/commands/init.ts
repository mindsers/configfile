import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import { ConfigStore } from '../config.js'
import type { Context } from '../context.js'
import { CliError } from '../errors.js'
import { configfilePaths, resolveUserPath } from '../paths.js'
import { gitClone } from '../process.js'

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
    .option('--folder <path>', 'where to clone the repository (default: ~/.configfile/repository)')
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

  // configfile's copy is a mirror it keeps in sync, not a working copy: by
  // default it lives in configfile's own folder. An existing one is kept.
  const own = configfilePaths(ctx.home)
  const folderPath =
    options.folder != null
      ? resolveUserPath(options.folder.trim(), ctx)
      : (previous.folderPath ?? own.repository)
  if (folderPath === own.repository) {
    await mkdir(own.dir, { recursive: true, mode: 0o700 })
  }

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
      output.info(`Cloning ${redactUrl(repoUrl)} into ${folderPath}…`)
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

/** The URL with its password or token (`https://user:token@host/…`) hidden. */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url // Not a URL (for example git@host:repo.git or a local path).
  }
  if (parsed.password === '' && (parsed.username === '' || parsed.protocol === 'ssh:')) return url
  parsed.username = parsed.username === '' ? '' : '***'
  parsed.password = parsed.password === '' ? '' : '***'
  return parsed.toString()
}
