import { cp, mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import { type Machine, readWhen, whyNotFor } from '../conditions.ts'
import { ConfigStore } from '../config.ts'
import type { Context } from '../context.ts'
import { CliError } from '../errors.ts'
import { describeJsonError, errnoCode, lstatOrNull, messageOf } from '../fsutil.ts'
import { plural } from '../output.ts'
import { contains, resolveUserPath, slugify } from '../paths.ts'
import { ensureGit, git, gitOutput } from '../process.ts'
import { listModules, readRepositorySettings, systemName, unsafeTarget } from '../repository.ts'
import { DeploymentRecord } from '../state.ts'
import {
  catchUp,
  currentBranch,
  openWorkingCopy,
  push,
  uncommittedFiles,
  type WorkingCopy,
} from '../working-copy.ts'
import { listPaths, syncAndRefresh } from './update.ts'

/** Command-line options, as commander gives them. */
interface AdoptOptions {
  module: string
  into?: string
  as?: string
  message?: string
  push: boolean
  dryRun?: boolean
  os?: string
  profile?: string[]
}

/** The `"when"` adopt writes, as in a module's settings. */
type When = { os?: string; profiles?: string | string[] }

/** The schema the settings of a module point to, for editors. */
const SCHEMA = 'https://docs.configfile.sh/schemas/module.json'

export function registerAdoptCommand(modules: Command, ctx: Context): void {
  modules
    .command('adopt')
    .argument('<paths...>', 'files or folders of this machine to add to the module')
    .description(
      'add files of this machine to a module, through your working copy of the repository: ' +
        'commit, push, then sync',
    )
    .requiredOption('-m, --module <name>', 'the module to add them to (created when missing)')
    .option('--into <folder>', 'your working copy of the dotfiles repository (remembered)')
    .option('--as <name>', 'the name of the file in the module (one path only)')
    .option('--message <text>', 'the commit message')
    .option('--no-push', 'commit without pushing ("configfile update" pushes it later)')
    .option(
      '--os <system>',
      'the files are only for this system (macos or linux): written as "when" in the module\'s settings',
    )
    .option(
      '--profile <name>',
      'the files are only for machines with this profile (repeatable): written as "when"',
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .option('-n, --dry-run', 'show what would be done, without changing anything')
    .action((paths: string[], options: AdoptOptions) => adopt(paths, options, ctx))
}

/** A file or folder to adopt, and where it goes in the working copy. */
interface Adoption {
  /** Absolute path on this machine, which becomes the entry's target. */
  readonly target: string
  /** `target_path`, as written in the module's settings (`~/.zshrc`). */
  readonly targetPath: string
  /** `source_path`: its name in the module folder. */
  readonly name: string
  readonly folder: boolean
}

/** The module the files are added to, in the working copy. */
interface ModuleFolder {
  /** Relative to the working copy, with `/` (`files/zsh`). */
  readonly relative: string
  readonly path: string
  /** The name of its settings file (`module_settings` of the repository). */
  readonly settingsFile: string
  /** The content of its settings file, or `null` when the module is created. */
  readonly settings: string | null
}

async function adopt(paths: string[], options: AdoptOptions, ctx: Context): Promise<void> {
  const { output } = ctx
  const store = new ConfigStore(ctx.home, { warn: message => output.warn(message) })
  const config = await store.read()
  const machine: Machine = { os: systemName(ctx.platform), profiles: config.profiles }
  const when = whenOf(options, machine)
  const into = options.into ?? config.workingCopy
  if (into == null) {
    throw new CliError(
      'Give your working copy of the dotfiles repository with --into <folder>: configfile ' +
        'commits there, never in its own copy. It is remembered as "working_copy" in ' +
        `${store.path}.`,
    )
  }
  if (options.as != null && paths.length > 1) {
    throw new CliError('--as names one file: adopt the others in another run.')
  }
  const folder = resolveUserPath(into, ctx)

  await ensureGit()
  const copy = await openWorkingCopy(folder, config.folderPath)
  await checkClean(copy)
  const branch = await currentBranch(copy)
  if (branch !== copy.branch) {
    throw new CliError(
      `${folder} is on ${branch == null ? 'no branch' : `branch ${branch}`}, and configfile ` +
        `follows ${copy.branch}: run "git -C ${folder} switch ${copy.branch}", then try again.`,
    )
  }

  const record = await DeploymentRecord.load(ctx.home)
  const targets: string[] = []
  for (const given of paths) {
    targets.push(
      await checkTarget(resolveUserPath(given, ctx), copy, config.folderPath, record, ctx),
    )
  }

  if (options.dryRun !== true) {
    const behind = await catchUp(copy)
    if (behind > 0) output.info(`Brought ${folder} up to date (${plural(behind, 'commit')}).`)
  }
  const module = await findModule(copy, options.module, machine)
  const adoptions = await nameAdoptions(targets, module, options.as, copy, ctx)

  if (options.dryRun === true) {
    output.print(`Would add to module ${options.module}, in ${folder}:`)
    for (const adoption of adoptions) {
      output.print(`- ${adoption.target} (as ${module.relative}/${adoption.name})`)
    }
    output.info(
      options.push
        ? "Would commit, push, sync, and keep these files as configfile's copies."
        : 'Would commit them, without pushing.',
    )
    return
  }

  await commit(copy, module, adoptions, when, options.message ?? describeCommit(adoptions, ctx))
  for (const adoption of adoptions) {
    ctx.history.record({
      kind: 'adopted',
      target: adoption.target,
      source: `${module.relative}/${adoption.name}`,
      folder,
    })
  }
  if (config.workingCopy == null) {
    try {
      await store.setWorkingCopy(folder)
      output.info('Your working copy is remembered: next time, --into can be left out.')
    } catch (error) {
      // The commit is made: going on, so that it is pushed and kept.
      output.warn(`Cannot remember your working copy: ${messageOf(error)} Give --into next time.`)
    }
  }

  const committed = `Committed ${listPaths(adoptions.map(item => item.target))} into ${module.relative} in ${folder}.`
  if (!options.push) {
    output.success(
      `${committed} Push it, or run "configfile update", which pushes it, syncs, and keeps ` +
        "these files as configfile's copies.",
    )
    return
  }

  try {
    const pushed = await push(copy)
    if (pushed != null) {
      ctx.history.record({ kind: 'pushed', folder, branch: copy.branch, ...pushed })
    }
  } catch (error) {
    throw new CliError(
      `${committed} It was not pushed: ${messageOf(error)} Push it, then run "configfile update".`,
      { cause: error },
    )
  }
  output.info(committed)

  // Says which files it could not keep as configfile's copies, and why.
  await syncAndRefresh(ctx, config.folderPath, { workingCopy: copy, deployHint: false })
}

/** Fails, listing them, when the working copy has changes that are not committed. */
async function checkClean(copy: WorkingCopy): Promise<void> {
  const files = await uncommittedFiles(copy)
  if (files.length === 0) return
  const shown = files.slice(0, 10).join(', ')
  const more = files.length > 10 ? ` and ${files.length - 10} more` : ''
  throw new CliError(
    `${copy.folder} has changes that are not committed (${shown}${more}): commit, stash or ` +
      'remove them, then try again. configfile commits only what it adopts.',
  )
}

/** Fails when the path cannot be adopted; returns it. */
async function checkTarget(
  target: string,
  copy: WorkingCopy,
  mirror: string,
  record: DeploymentRecord,
  ctx: Context,
): Promise<string> {
  const stats = await lstatOrNull(target)
  if (stats == null) throw new CliError(`${target} does not exist.`)
  if (stats.isSymbolicLink()) {
    throw new CliError(`${target} is a symbolic link: adopt the file or folder it points to.`)
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new CliError(`${target} is neither a file nor a folder.`)
  }
  if ((await record.find(target))?.deployed != null) {
    throw new CliError(`${target} is already deployed by configfile.`)
  }
  for (const known of record.targets()) {
    if (known.deployed == null) continue
    if (contains(known.target, target)) {
      throw new CliError(`${target} is inside ${known.target}, which configfile deploys.`)
    }
    if (contains(target, known.target)) {
      throw new CliError(`${target} holds ${known.target}, which configfile deploys.`)
    }
  }
  for (const [folder, label] of [
    [copy.folder, 'your working copy'],
    [mirror, "configfile's copy of the repository"],
  ] as const) {
    if (contains(folder, target)) throw new CliError(`${target} is inside ${label}.`)
    if (contains(target, folder)) throw new CliError(`${target} holds ${label} (${folder}).`)
  }
  const problem = unsafeTarget(target, {
    home: ctx.home,
    cwd: null,
    repository: mirror,
    module: mirror,
  })
  if (problem != null) throw new CliError(`${target} cannot be adopted: it ${problem}.`)
  if (stats.isDirectory() && (await holdsRepository(target))) {
    throw new CliError(
      `${target} holds a git repository (.git): git cannot commit it into your dotfiles.`,
    )
  }
  return target
}

async function holdsRepository(folder: string): Promise<boolean> {
  const names = await readdir(folder, { recursive: true })
  return names.some(name => path.basename(name) === '.git')
}

/** The module named `name` in the working copy, or where to create it. */
/**
 * The `"when"` that `--os` and `--profile` ask for, or `null`. The files come
 * from this machine: it must be one they are for.
 */
function whenOf(options: Pick<AdoptOptions, 'os' | 'profile'>, machine: Machine): When | null {
  if (options.os == null && options.profile == null) return null
  const profiles = options.profile == null ? null : [...new Set(options.profile)]
  const when: When = {
    ...(options.os != null && { os: options.os }),
    ...(profiles != null && { profiles: profiles.length === 1 ? profiles[0] : profiles }),
  }
  const condition = readWhen(when)
  if ('invalid' in condition) {
    throw new CliError(
      condition.invalid
        .replace('"when.os"', '--os')
        .replace('"when.profiles"', '--profile')
        .replace(', or a list of them', ''),
    )
  }
  const reason = whyNotFor(condition, machine)
  if (reason != null) {
    throw new CliError(
      `The files come from this machine, which --os and --profile leave out (${reason}): ` +
        'they would never be deployed here.',
    )
  }
  return when
}

async function findModule(
  copy: WorkingCopy,
  name: string,
  machine: Machine,
): Promise<ModuleFolder> {
  const modules = await listModules(copy.folder, {
    home: copy.folder,
    cwd: copy.folder,
    // Shown once, when the targets are checked (see `nameAdoptions`).
    warn: () => {},
  })
  const found = modules.find(module => module.name === name)
  if (found != null) {
    if (found.error != null) {
      throw new CliError(`Module "${name}" cannot be used: ${found.error}.`)
    }
    const away = whyNotFor(found.when, machine)
    if (away != null) {
      throw new CliError(
        `Module "${name}" is not for this machine (${away}): files adopted into it would not ` +
          'be deployed here.',
      )
    }
    const settings = await readFile(path.join(found.path, found.settingsFile), 'utf8')
    return {
      relative: path.relative(copy.folder, found.path).split(path.sep).join('/'),
      path: found.path,
      settingsFile: found.settingsFile,
      settings,
    }
  }
  if (slugify(name) !== name || name === '') {
    throw new CliError(
      `"${name}" cannot name a new module: use lowercase letters, digits, "_" or "-".`,
    )
  }
  const relative = `files/${name}`
  const modulePath = path.join(copy.folder, 'files', name)
  const { moduleSettings } = await readRepositorySettings(copy.folder)
  if ((await lstatOrNull(modulePath)) != null) {
    throw new CliError(`${modulePath} exists and is not a module (it has no ${moduleSettings}).`)
  }
  return { relative, path: modulePath, settingsFile: moduleSettings, settings: null }
}

/**
 * The name of each file in the module: its own, without a leading dot
 * (`~/.zshrc` → `zshrc`), or `--as`. Fails when two would collide, or when
 * the module already has it or deploys the same target.
 */
async function nameAdoptions(
  targets: readonly string[],
  module: ModuleFolder,
  as: string | undefined,
  copy: WorkingCopy,
  ctx: Context,
): Promise<Adoption[]> {
  const existing = new Set(
    entriesOf(module).flatMap(entry =>
      typeof entry.source_path === 'string' ? [path.normalize(entry.source_path)] : [],
    ),
  )
  const modules = await listModules(copy.folder, {
    home: ctx.home,
    cwd: ctx.cwd,
    warn: message => ctx.output.warn(message),
  })
  const broken = modules.find(other => other.error != null)
  if (broken?.error != null) {
    throw new CliError(
      `Module "${broken.name}" cannot be used (${broken.error}), so configfile cannot check ` +
        'that it does not deploy these files already: fix it first.',
    )
  }
  const deployed = new Map(
    modules.flatMap(other =>
      // Every entry, whatever machine it is for: they would clash on that machine.
      other.error == null
        ? [...other.files, ...other.elsewhere.map(item => item.file)].map(
            file => [file.target, other.name] as const,
          )
        : [],
    ),
  )

  const adoptions: Adoption[] = []
  for (const target of targets) {
    const name = as ?? (path.basename(target).replace(/^\.+/, '') || path.basename(target))
    if (name.includes('/') || name.includes(path.sep) || name === '.' || name === '..') {
      throw new CliError(`"${name}" cannot name a file of the module.`)
    }
    if (name === module.settingsFile) {
      throw new CliError(
        `${target} would be named ${name}, the module's own settings file: choose another name with --as.`,
      )
    }
    if (adoptions.some(other => other.name === name)) {
      throw new CliError(`Two files would be named ${name}: adopt one of them with --as <name>.`)
    }
    if (existing.has(name) || (await lstatOrNull(path.join(module.path, name))) != null) {
      throw new CliError(
        `Module ${module.relative} already has ${name}: choose another name with --as.`,
      )
    }
    for (const [other, owner] of deployed) {
      if (other === target) throw new CliError(`Module ${owner} already deploys ${target}.`)
      if (contains(other, target) || contains(target, other)) {
        throw new CliError(`${target} overlaps ${other}, which module ${owner} deploys.`)
      }
    }
    const stats = await lstatOrNull(target)
    const relative = path.relative(ctx.home, target)
    const targetPath = contains(ctx.home, target)
      ? `~/${relative.split(path.sep).join('/')}`
      : target
    adoptions.push({ target, targetPath, name, folder: stats?.isDirectory() === true })
  }
  return adoptions
}

function entriesOf(module: ModuleFolder): Record<string, unknown>[] {
  if (module.settings == null) return []
  const files = (JSON.parse(module.settings) as { files: unknown[] }).files
  return files.filter(
    (entry): entry is Record<string, unknown> =>
      entry != null && typeof entry === 'object' && !Array.isArray(entry),
  )
}

/** `Adopt ~/.zshrc and ~/.config/nvim`. */
function describeCommit(adoptions: readonly Adoption[], ctx: Context): string {
  const names = adoptions.map(item =>
    item.targetPath.startsWith('~/') ? item.targetPath : path.relative(ctx.home, item.target),
  )
  return `Adopt ${listPaths(names)}`
}

/**
 * Copies the files into the module, adds their entries to its settings file,
 * and commits. When anything fails, what was written is removed.
 */
async function commit(
  copy: WorkingCopy,
  module: ModuleFolder,
  adoptions: readonly Adoption[],
  when: When | null,
  message: string,
): Promise<void> {
  const cwd = copy.folder
  const settingsPath = path.join(module.path, module.settingsFile)
  const written: string[] = []
  try {
    await mkdir(module.path, { recursive: true })
    for (const adoption of adoptions) {
      const source = path.join(module.path, adoption.name)
      written.push(source)
      await cp(adoption.target, source, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      })
    }
    await writeFile(settingsPath, withEntries(module, adoptions, when))
    await gitOutput(['add', '--', module.relative], { cwd })
    // git add skips what a .gitignore excludes: the entry would point to nothing.
    for (const adoption of adoptions) {
      const source = `${module.relative}/${adoption.name}`
      const staged = await gitOutput(['ls-files', '--cached', '--', source], { cwd })
      if ((staged ?? '').trim() === '') {
        throw new CliError(
          `git ignores ${source} in ${copy.folder} (see "git -C ${copy.folder} check-ignore -v ` +
            `${source}"): name it otherwise with --as, or change the ignore rule.`,
        )
      }
    }
    // Shown: hooks, and a key to sign with, may ask for something.
    await git(
      ['commit', '--quiet', '--message', message, '--', module.relative],
      { cwd },
      'git commit',
    )
  } catch (error) {
    const left = await undo(copy, module, written)
    const cause = messageOf(error)
    if (left.length > 0) {
      throw new CliError(
        `Nothing was adopted: ${cause} These could not be undone: ${left.join('; ')}. Check ` +
          `"git -C ${cwd} status".`,
        { cause: error },
      )
    }
    throw new CliError(`Nothing was adopted: ${cause}`, { cause: error })
  }
}

/** Removes what `commit` wrote. Returns what it could not undo, and why. */
async function undo(
  copy: WorkingCopy,
  module: ModuleFolder,
  written: readonly string[],
): Promise<string[]> {
  const left: string[] = []
  const attempt = async (what: string, step: () => Promise<unknown>) => {
    try {
      await step()
    } catch (error) {
      left.push(`${what} (${messageOf(error)})`)
    }
  }
  const settingsPath = path.join(module.path, module.settingsFile)
  await attempt(`unstaging ${module.relative}`, () =>
    gitOutput(['reset', '--quiet', '--', module.relative], { cwd: copy.folder }),
  )
  for (const file of written) {
    await attempt(`removing ${file}`, () => rm(file, { recursive: true, force: true }))
  }
  if (module.settings == null) {
    await attempt(`removing ${settingsPath}`, () => rm(settingsPath, { force: true }))
    await attempt(`removing ${module.path}`, async () => {
      try {
        await rmdir(module.path)
      } catch (error) {
        // Already gone, or created before (git keeps no empty folder): nothing to undo.
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errnoCode(error) ?? '')) throw error
      }
    })
  } else {
    const original = module.settings
    await attempt(`restoring ${settingsPath}`, () => writeFile(settingsPath, original))
  }
  return left
}

/**
 * The module's settings with the new entries at the end of its "files" list,
 * keeping its keys in order and its indentation.
 */
function withEntries(
  { settings, settingsFile }: Pick<ModuleFolder, 'settings' | 'settingsFile'>,
  adoptions: readonly Adoption[],
  when: When | null,
): string {
  // A new module is for these machines as a whole; in an existing one, only the new entries.
  const onEntries = settings != null && when != null
  const entries = adoptions.map(item => ({
    source_path: item.name,
    target_path: item.targetPath,
    deploy: 'global',
    ...(onEntries && { when }),
  }))
  if (settings == null) {
    const created = { $schema: SCHEMA, ...(when != null && { when }), files: entries }
    return `${JSON.stringify(created, null, 2)}\n`
  }

  let parsed: { files: unknown[] }
  try {
    parsed = JSON.parse(settings) as { files: unknown[] }
  } catch (error) {
    throw new CliError(`${settingsFile} is not valid JSON (${describeJsonError(error)}).`)
  }
  parsed.files.push(...entries)
  const indent = /^[ \t]+(?=")/m.exec(settings)?.[0] ?? '  '
  return `${JSON.stringify(parsed, null, indent)}${settings.endsWith('\n') ? '\n' : ''}`
}
