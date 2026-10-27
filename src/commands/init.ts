import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Command } from 'commander'

import { isProfileName } from '../conditions.ts'
import { ConfigStore } from '../config.ts'
import type { Context } from '../context.ts'
import { CliError } from '../errors.ts'
import { inspectFolder, messageOf } from '../fsutil.ts'
import { checkRepositoryUrl } from '../git-url.ts'
import { withCommandLock } from '../lock.ts'
import { plural, redactUrl, sentence } from '../output.ts'
import { configfilePaths, contains, resolveUserPath } from '../paths.ts'
import { ensureGit, gitClone, gitOutput } from '../process.ts'
import { knownProfiles, listModules, readRepositorySettings } from '../repository.ts'
import { failedHook, runRepositoryHook } from '../repository-hooks.ts'
import { undeployAllModules, undeployRecorded } from './modules.ts'
import {
  type EmptyRemote,
  findEmptyRemote,
  offerNewRepository,
  setUpCommand,
} from './new-repository.ts'
import { deletedBySetUp, deleteSetUp, isSetUp, markClone, ownClone } from './set-up-again.ts'

interface InitOptions {
  force?: boolean
  repo?: string
  folder?: string
  workingCopy?: string
  profile?: string[]
  /**
   * Run the post_init script without asking (`true`), never (`false`), or
   * ask in a terminal and skip it without one (unset). When configfile is set
   * up again, `false` also undeploys without the scripts of the modules.
   */
  hooks?: boolean
  /**
   * Set up an empty repository without asking first (`true`), never
   * (`false`), or ask in a terminal and only say it is empty without one
   * (unset).
   */
  newRepository?: boolean
}

export function registerInitCommand(program: Command, ctx: Context): void {
  program
    .command('init')
    .alias('i')
    .description('clone your dotfiles repository, which configfile then keeps in sync')
    .option(
      '-f, --force',
      'when configfile is already set up, set it up again without asking: undeploy its files, ' +
        'delete its configuration, its folder and the clone it made, then clone again',
    )
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
    .option('--hooks', 'run the post_init script of the repository without asking')
    .option(
      '--no-hooks',
      'do not run the post_init script of the repository, nor, when setting configfile up ' +
        'again, the undeploy scripts of the modules',
    )
    .option(
      '--new-repository',
      'when the repository is empty, set it up in your working copy without asking first ' +
        '(in a terminal, the folder is still asked, unless --working-copy): commit starter ' +
        'files, and push them',
    )
    .option('--no-new-repository', 'when the repository is empty, do not offer to set it up')
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
  const own = configfilePaths(ctx.home)
  const again = isSetUp(store, ctx.home)

  if (!prompts.interactive) {
    const missing = [
      again &&
        options.force !== true &&
        '--force (configfile is already set up, and --force sets it up again)',
      options.repo == null && '--repo <url>',
    ].filter(Boolean)
    if (missing.length > 0) {
      throw new CliError(
        `Not running in an interactive terminal. Also pass: ${missing.join(', ')}.`,
      )
    }
  }

  // configfile's copy is a mirror it keeps in sync, not a working copy: by
  // default it lives in configfile's own folder.
  const folderPath =
    options.folder != null ? resolveUserPath(options.folder.trim(), ctx) : own.dotfiles
  const workingCopy =
    options.workingCopy == null ? undefined : resolveUserPath(options.workingCopy.trim(), ctx)
  // Setting up again deletes the clone configfile made, never a folder it cannot tell it cloned.
  const previousFolder = previous.folderPath ?? own.dotfiles
  const clone = again ? await ownClone(previousFolder, ctx.home) : null
  const deleted = (folder: string) => again && deletedBySetUp(folder, { home: ctx.home, clone })
  // Checked before the questions, and before anything is undeployed.
  await checkTarget(folderPath, deleted(folderPath))
  for (const folder of new Set([previous.workingCopy, workingCopy])) {
    if (folder != null && deleted(folder)) {
      throw new CliError(
        `Your working copy, ${folder}, is inside ${clone != null && contains(clone, folder) ? clone : own.dir}, ` +
          'which setting configfile up again deletes. Move it somewhere else first, then run ' +
          '"configfile init" again with --working-copy.',
      )
    }
  }
  // Before the URL question: a missing git is found before the URL is typed.
  await ensureGit()

  if (again && options.force !== true) {
    const reset = await prompts.confirm({
      message:
        'configfile is already set up. Set it up again? It undeploys the files it deployed ' +
        `(your previous files come back), then deletes ${describeSetUp(store, clone, own.dir)}, ` +
        'and clones the repository again.',
      default: false,
    })
    if (!reset) {
      output.info('Nothing changed.')
      return
    }
  }

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

  const hooks = options.hooks !== false
  let repository: string | null = null
  if (again) {
    const source = localPath(repoUrl)
    if (source != null && deleted(source)) {
      throw new CliError(
        `${source} is deleted when configfile is set up again, before the repository is ` +
          'cloned: give the URL of the repository, or copy that folder somewhere else first.',
      )
    }
    // A repository that cannot be reached stops here, before anything changes.
    await checkReachable(repoUrl, ctx)
    repository = await usableRepository(store, hooks, ctx)
  }

  if (contains(own.dir, folderPath)) {
    await mkdir(own.dir, { recursive: true, mode: 0o700 })
  }
  /** How far setting configfile up again went, for its errors. */
  let stage: keyof typeof AFTER_FAILURE = 'undeploy'
  try {
    const kept =
      again && hooks && repository != null ? await undeployAllModules(ctx) : new Set<string>()
    // After the questions: the folder and the configuration that deployments
    // and syncs read change here. The record is read with the lock held: a
    // file deployed meanwhile is undeployed too.
    await withCommandLock(ctx, async () => {
      if (again) {
        const left = await undeployRecorded({ repository, kept }, ctx)
        stage = 'delete'
        sayWhatStays(left, { previousFolder, clone }, ctx)
        const gone = await deleteSetUp({ store, clone }, ctx)
        stage = 'clone'
        output.info(`Deleted the previous setup: ${describeDeleted(gone, own.dir)}.`)
      }
      await setUp({ folderPath, repoUrl, force: options.force === true }, store, ctx)
    })
  } catch (error) {
    if (!again || !(error instanceof CliError)) throw error
    throw new CliError(`${sentence(messageOf(error))} ${AFTER_FAILURE[stage]}`, {
      cause: error,
      // A script interrupted by a signal ends init with the signal's exit code.
      ...(stage === 'undeploy' && { exitCode: error.exitCode }),
    })
  }
  const profiles = await chooseProfiles(options.profile, folderPath, store, ctx)
  if (profiles != null) await store.setProfiles(profiles)
  // A new repository's setup saves the working copy, once it knows the folder can be used.
  const setUpNew = await setUpIfEmpty(options, { repoUrl, workingCopy }, folderPath, store, ctx)
  if (!setUpNew && workingCopy != null) await store.setWorkingCopy(workingCopy)
  // After the lock: the script may run configfile itself.
  await runPostInit(options.hooks, folderPath, store, ctx)
  output.success(`configfile is ready. Configuration saved to ${store.path}.`)
}

/** What a failure setting configfile up again leaves, by how far it went. */
const AFTER_FAILURE = {
  undeploy:
    'configfile was not set up again: nothing was deleted, but the files undeployed so far ' +
    'stay undeployed ("configfile modules deploy --all" deploys them again). Once fixed, run ' +
    '"configfile init" again (with --no-hooks, it undeploys from its record, without the ' +
    'scripts of the modules).',
  delete:
    'Every file configfile deployed is undeployed, and its configuration is kept: once fixed, ' +
    'run "configfile init" again to finish.',
  clone:
    'The previous setup was deleted first: once fixed, run "configfile init" again, which sets ' +
    'configfile up as on a first install.',
}

/** Says what setting configfile up again leaves where it is, and no longer tracks. */
function sayWhatStays(
  { local, kept }: { local: number; kept: number },
  { previousFolder, clone }: { previousFolder: string; clone: string | null },
  ctx: Context,
): void {
  const stays = (count: number, what: string) =>
    ctx.output.info(
      `${what} ${count === 1 ? 'stays' : 'stay'}: configfile no longer tracks ` +
        `${count === 1 ? 'it' : 'them'}.`,
    )
  if (local > 0) {
    stays(local, `${plural(local, 'local copy', 'local copies')} made in project folders`)
  }
  if (kept > 0) stays(kept, `${plural(kept, 'file')} changed on this machine`)
  if (clone == null && existsSync(previousFolder)) {
    ctx.output.info(
      `${previousFolder} is kept: configfile cannot tell it cloned it. Delete it if you no longer need it.`,
    )
  }
}

/** What setting configfile up again deletes, for the question. */
function describeSetUp(store: ConfigStore, clone: string | null, dir: string): string {
  const parts = [
    `what ${dir} holds (its copy of the repository, its history and the changes it saved)`,
  ]
  if (clone != null && !contains(dir, clone)) parts.push(clone)
  if (store.exists()) parts.push(`${store.path} (its configuration)`)
  return list(parts)
}

/** What `deleteSetUp` deleted: what configfile's folder held is not listed file by file. */
function describeDeleted(deleted: readonly string[], dir: string): string {
  const outside = deleted.filter(folder => !contains(dir, folder))
  return list(deleted.length > outside.length ? [`what ${dir} held`, ...outside] : outside)
}

/** "a", "a and b", "a, b and c". */
function list(parts: readonly string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** The folder of a local repository URL (a path, or a file:// URL). */
function localPath(url: string): string | null {
  if (url.startsWith('file:')) {
    try {
      return fileURLToPath(url)
    } catch {
      return null
    }
  }
  return path.isAbsolute(url) ? url : null
}

/**
 * Offers to set up the repository when it has no commit yet (see
 * `offerNewRepository`). Returns whether it did, which saves the working copy.
 */
async function setUpIfEmpty(
  options: InitOptions,
  { repoUrl, workingCopy }: { repoUrl: string; workingCopy: string | undefined },
  folderPath: string,
  store: ConfigStore,
  ctx: Context,
): Promise<boolean> {
  const done = `configfile is configured (${store.path})`
  let empty: EmptyRemote | null
  try {
    empty = await findEmptyRemote(folderPath)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    const why = `whether the repository is empty cannot be told: ${sentence(messageOf(error))}`
    if (options.newRepository === true) {
      throw new CliError(
        `${done}, but ${why} Once fixed, run "${setUpCommand(repoUrl, workingCopy)}".`,
        { cause: error },
      )
    }
    // Not fatal: the repository is cloned and configured.
    ctx.output.warn(`Setting up a new repository is not offered: ${why}`)
    return false
  }
  if (empty == null) {
    if (options.newRepository === true) {
      ctx.output.info('The repository is not empty: there is no new repository to set up.')
    }
    return false
  }
  return offerNewRepository(
    { wanted: options.newRepository, workingCopy, mirror: folderPath, empty, done },
    store,
    ctx,
  )
}

/**
 * Runs the post_init script the repository names. It is the repository's
 * code, maybe cloned for the first time: asked first in a terminal, and run
 * without one only with --hooks. Fails after saying so when the script does:
 * the configuration is saved.
 */
async function runPostInit(
  hooks: boolean | undefined,
  folderPath: string,
  store: ConfigStore,
  ctx: Context,
): Promise<void> {
  if (hooks === false) return
  const done = `configfile is configured (${store.path})`
  let name: string | undefined
  try {
    name = (await readRepositorySettings(folderPath)).hooks.post_init
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    throw new CliError(
      `${done}, but whether the repository names a post_init script cannot be told: ` +
        `${messageOf(error)} Once fixed, run that script with "configfile scripts run <name>".`,
      { cause: error },
    )
  }
  if (name == null) return

  const later = `run it with "configfile scripts run ${name}" when you want`
  const skip = (reason: string) =>
    ctx.history.record({ kind: 'script-skipped', name, hook: 'post_init', reason })
  if (hooks !== true) {
    if (!ctx.prompts.interactive) {
      // On stderr: a bootstrap script sees what it did not do.
      ctx.output.warn(
        `The repository names a post_init script, "${name}", not run without a terminal: ` +
          `${later}, or use "configfile init --hooks".`,
      )
      skip('no terminal to ask in')
      return
    }
    const run = await ctx.prompts.confirm({
      message: `Run "${name}", the post_init script of the repository?`,
      default: true,
    })
    if (!run) {
      ctx.output.info(`The post_init script was not run: ${later}.`)
      skip('declined')
      return
    }
  }
  const outcome = await runRepositoryHook('post_init', name, ctx)
  if (!outcome.ok) throw failedHook(outcome, { done, hook: 'post_init', name })
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
  let unreadable = false
  const modules = await listModules(folderPath, {
    home: ctx.home,
    cwd: ctx.cwd,
    warn: message => ctx.output.warn(message),
  }).catch(error => {
    // The repository is cloned and configured: --profile is still saved.
    if (!(error instanceof CliError)) throw error
    ctx.output.warn(`The modules cannot be read, to check the profiles: ${messageOf(error)}`)
    unreadable = true
    return []
  })
  const known = knownProfiles(modules)
  const listed = known.map(name => `"${name}"`).join(', ')
  if (given != null) {
    // Without the modules, which profiles they name is not known: nothing more to say.
    for (const name of unreadable ? [] : given.filter(profile => !known.includes(profile))) {
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

/**
 * Fails for a folder configfile cannot clone into: one that holds something,
 * unless setting configfile up again deletes it first (`deleted`).
 */
async function checkTarget(folderPath: string, deleted: boolean): Promise<void> {
  const folder = await inspectFolder(folderPath)
  if (folder === 'not-a-directory') throw new CliError(`${folderPath} exists and is not a folder.`)
  if (deleted || folder === 'missing' || folder === 'empty') return
  throw new CliError(
    `${folderPath} ${folder === 'git-repository' ? 'already holds a git repository' : 'is not empty'}: ` +
      'configfile only clones into an empty folder. Choose another folder with --folder, or delete it.',
  )
}

/** Fails when the repository cannot be reached: wrong URL, no network, no access. */
async function checkReachable(repoUrl: string, ctx: Context): Promise<void> {
  try {
    await gitOutput(['ls-remote', '--quiet', '--', repoUrl, 'HEAD'], { cwd: ctx.home })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    throw new CliError(
      `${redactUrl(repoUrl)} cannot be reached, so configfile was not set up again: ` +
        `nothing changed. ${sentence(messageOf(error))}`,
      { cause: error },
    )
  }
}

/**
 * The repository whose modules are undeployed with their scripts: `null`
 * when there is no configuration, it cannot be read, or its folder cannot be
 * used. The files are then undeployed from the record alone, without
 * scripts, which `hooks` says are due (`false`: no warning).
 */
async function usableRepository(
  store: ConfigStore,
  hooks: boolean,
  ctx: Context,
): Promise<string | null> {
  const unusable = (why: string): null => {
    if (hooks) {
      ctx.output.warn(
        `The scripts of the modules are not run: ${why} The files configfile deployed are ` +
          'undeployed from its record.',
      )
    }
    return null
  }
  // No configuration: no repository to take scripts from, nothing to warn about.
  if (!store.exists()) return null
  const folderPath = await store.read().then(
    config => config.folderPath,
    (error: unknown) => {
      if (!(error instanceof CliError)) throw error
      return unusable(sentence(messageOf(error)))
    },
  )
  if (folderPath == null) return null
  let folder: string
  try {
    folder = await inspectFolder(folderPath)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    return unusable(sentence(messageOf(error)))
  }
  if (folder === 'missing') return unusable(`${folderPath} is missing.`)
  if (folder === 'not-a-directory') return unusable(`${folderPath} is not a folder.`)
  return folderPath
}

/**
 * Clones the repository, then saves the configuration. Runs with the lock
 * held: what was seen before waiting for it is checked again, as another
 * configfile may have cloned or configured meanwhile.
 */
async function setUp(
  { folderPath, repoUrl, force }: { folderPath: string; repoUrl: string; force: boolean },
  store: ConfigStore,
  ctx: Context,
): Promise<void> {
  const { output } = ctx
  // Set up again, the configuration was just deleted.
  if (!force && store.exists()) {
    throw new CliError(
      `Another configfile saved a configuration to ${store.path} meanwhile. ` +
        'Run "configfile init" again to replace it.',
    )
  }
  const folder = await inspectFolder(folderPath)
  if (folder === 'not-a-directory') throw new CliError(`${folderPath} exists and is not a folder.`)
  if (folder !== 'missing' && folder !== 'empty') {
    throw new CliError(
      `${folderPath} is not empty: another configfile may have cloned into it meanwhile. ` +
        'Choose another folder with --folder, or delete it.',
    )
  }
  await mkdir(folderPath, { recursive: true }).catch(error => {
    throw new CliError(`Cannot create ${folderPath}: ${messageOf(error)}`, { cause: error })
  })
  output.info(`Cloning ${redactUrl(repoUrl)} into ${folderPath}…`)
  try {
    await gitClone(repoUrl, folderPath, ctx)
  } catch (error) {
    // The folder it created would count as a setup of configfile for the next init.
    if (folder === 'missing') await rm(folderPath, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  try {
    await markClone(folderPath)
    await store.write({ repoUrl, folderPath })
  } catch (error) {
    // Without its mark and a configuration, the clone would be in the way of the next init.
    const deleted = await rm(folderPath, { recursive: true, force: true }).then(
      () => 'The clone is deleted: fix the problem',
      () => `Delete ${folderPath}, fix the problem,`,
    )
    throw new CliError(
      `${sentence(messageOf(error))} ${deleted} and run "configfile init" again.`,
      {
        cause: error,
      },
    )
  }
  ctx.history.record({ kind: 'cloned', repository: redactUrl(repoUrl), folder: folderPath })
  ctx.history.record({ kind: 'configured', file: store.path })
}
