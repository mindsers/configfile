import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import { isProfileName } from '../conditions.ts'
import { ConfigStore } from '../config.ts'
import type { Context } from '../context.ts'
import { CliError } from '../errors.ts'
import { messageOf } from '../fsutil.ts'
import { checkRepositoryUrl } from '../git-url.ts'
import { withCommandLock } from '../lock.ts'
import { redactUrl } from '../output.ts'
import { configfilePaths, resolveUserPath } from '../paths.ts'
import { ensureGit, gitClone } from '../process.ts'
import { knownProfiles, listModules } from '../repository.ts'

interface InitOptions {
  force?: boolean
  repo?: string
  folder?: string
  workingCopy?: string
  profile?: string[]
}

export function registerInitCommand(program: Command, ctx: Context): void {
  program
    .command('init')
    .alias('i')
    .description('clone your dotfiles repository, which configfile then keeps in sync')
    .option('-f, --force', 'overwrite the existing configuration without asking')
    .option('--repo <url>', 'dotfiles repository URL (skips the question)')
    .option('--folder <path>', 'where to clone the repository (default: ~/.configfile/dotfiles)')
    .option(
      '--working-copy <path>',
      'your own clone of the repository, where "modules adopt" commits and from which "update" pushes',
    )
    .option(
      '--profile <name>',
      'a profile of this machine, which "when" conditions of the modules name (repeatable; skips the question)',
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .action((options: InitOptions) => init(options, ctx))
}

async function init(options: InitOptions, ctx: Context): Promise<void> {
  const { output, prompts } = ctx
  const invalid = (options.profile ?? []).find(name => !isProfileName(name))
  if (invalid != null) {
    throw new CliError(`"${invalid}" is not a profile name: use letters, digits, ".", "_" and "-".`)
  }
  const store = new ConfigStore(ctx.home, { warn: message => output.warn(message) })
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
  // A clone needs git: checked before asking for the URL, so a missing git is
  // found before the URL is typed and before the folder to clone into is created.
  if (needsClone(await inspectFolder(folderPath))) await ensureGit()
  const configured = store.exists()

  const validate = (value: string) => {
    const checked = checkRepositoryUrl(value, ctx)
    return 'error' in checked ? checked.error : true
  }
  const answer =
    options.repo ??
    (await prompts.input({
      message: 'Dotfiles repository URL:',
      required: true,
      ...(previous.repoUrl != null && { default: previous.repoUrl }),
      validate,
    }))
  const checked = checkRepositoryUrl(answer, ctx)
  if ('error' in checked) throw new CliError(checked.error)
  const repoUrl = checked.url
  if (redactUrl(repoUrl) !== repoUrl) {
    output.warn(
      'The repository URL contains credentials: they are saved in the configuration and in ' +
        "git's settings. Prefer an SSH key or a git credential helper.",
    )
  }

  if (folderPath === own.dotfiles) {
    await mkdir(own.dir, { recursive: true, mode: 0o700 })
  }

  // After the questions: the folder and the configuration that deployments
  // and syncs read change here.
  await withCommandLock(ctx, () =>
    setUp({ folderPath, repoUrl, configured, force: options.force === true }, store, ctx),
  )
  if (options.workingCopy != null) {
    await store.setWorkingCopy(resolveUserPath(options.workingCopy.trim(), ctx))
  }
  const profiles = await chooseProfiles(options.profile, folderPath, store, ctx)
  if (profiles != null) await store.setProfiles(profiles)
  output.success(`configfile is ready. Configuration saved to ${store.path}.`)
}

/**
 * This machine's profiles: those given with `--profile` (with a warning for
 * those no module names), or the answer to a question when the repository's
 * modules name some. `null` keeps the saved ones.
 */
async function chooseProfiles(
  given: readonly string[] | undefined,
  folderPath: string,
  store: ConfigStore,
  ctx: Context,
): Promise<string[] | null> {
  // Warnings say why a module, and the profiles it names, cannot be read.
  const modules = await listModules(folderPath, {
    home: ctx.home,
    cwd: ctx.cwd,
    warn: message => ctx.output.warn(message),
  }).catch(error => {
    // The repository is cloned and configured: --profile is still saved.
    if (!(error instanceof CliError)) throw error
    ctx.output.warn(`The modules cannot be read, to check the profiles: ${messageOf(error)}`)
    return []
  })
  const known = knownProfiles(modules)
  const listed = known.map(name => `"${name}"`).join(', ')
  if (given != null) {
    for (const name of given.filter(profile => !known.includes(profile))) {
      ctx.output.warn(
        `No module is for profile "${name}" yet: ` +
          (known.length === 0
            ? 'the repository uses no profiles.'
            : `the repository uses ${listed}.`),
      )
    }
    return [...new Set(given)]
  }
  if (known.length === 0) return null
  // A saved value that cannot be used is replaced by the answer.
  const saved = await store.read().then(
    config => config.profiles,
    () => [],
  )
  if (!ctx.prompts.interactive) {
    if (saved.length === 0) {
      ctx.output.info(
        `Some modules are only for machines with the profiles ${listed}: give this machine's ` +
          `with --profile, or add them to "profiles" in ${store.path}.`,
      )
    }
    return null
  }

  const parse = (answer: string) =>
    answer
      .split(',')
      .map(name => name.trim())
      .filter(name => name !== '')
  const answer = await ctx.prompts.input({
    message: `Profiles of this machine (${known.join(', ')}; separate them with commas, or leave empty):`,
    ...(saved.length > 0 && { default: saved.join(', ') }),
    validate: value => {
      const unknown = parse(value).find(name => !known.includes(name))
      return unknown == null
        ? true
        : `No module is for profile "${unknown}": the repository uses ${listed}.`
    },
  })
  return [...new Set(parse(answer))]
}

function needsClone(folder: Awaited<ReturnType<typeof inspectFolder>>): boolean {
  return folder === 'missing' || folder === 'empty'
}

/**
 * Clones the repository or reuses the folder, then saves the configuration.
 * Runs with the lock held: what was seen before waiting for it is checked
 * again, as another configfile may have cloned or configured meanwhile.
 * `configured`: a configuration existed when the user answered.
 */
async function setUp(
  {
    folderPath,
    repoUrl,
    configured,
    force,
  }: { folderPath: string; repoUrl: string; configured: boolean; force: boolean },
  store: ConfigStore,
  ctx: Context,
): Promise<void> {
  const { output } = ctx
  if (!configured && !force && store.exists()) {
    throw new CliError(
      `Another configfile saved a configuration to ${store.path} meanwhile. ` +
        'Run "configfile init" again to replace it.',
    )
  }
  const folder = await inspectFolder(folderPath)
  if (needsClone(folder)) await ensureGit()
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
