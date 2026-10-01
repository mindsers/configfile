import type { Dirent, Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { ConfigStore } from './config.ts'
import type { Context } from './context.ts'
import { CliError } from './errors.ts'
import { describeJsonError } from './fsutil.ts'
import { configfilePaths, contains, resolveUserPath, slugify } from './paths.ts'

export interface ModuleFile {
  /** Absolute path of the file inside its module folder. */
  readonly source: string
  /** Absolute path where the file is deployed. Never inside the repository. */
  readonly target: string
  /** `global`: symlinked by a regular deploy. `local`: copied by `deploy --local`. */
  readonly strategy: 'global' | 'local'
  /** Absolute path of the dotfiles repository the file comes from. */
  readonly repository: string
  /** Absolute path of the module folder (it may be a symbolic link to elsewhere). */
  readonly module: string
  /** The settings.json entry of the file, recorded when it is deployed. */
  readonly entry?: Entry
}

/**
 * Where a deployed file comes from, recorded with it: this is how configfile
 * later tells whether the repository still deploys it.
 */
export interface Entry {
  /** The module folder, relative to the repository (`files/zsh`). */
  readonly module: string
  /** `source_path`, relative to the module folder. */
  readonly source: string
  /** `target_path`, as written. */
  readonly target: string
  /** The folder `target` is resolved from: the home folder (global) or the current folder (local). */
  readonly folder: string
}

interface ModuleBase {
  readonly name: string
  readonly path: string
}

export type Module = ModuleBase &
  (
    | {
        readonly error: null
        /** Files to deploy. `"deploy": "none"`, invalid and undecided entries are left out. */
        readonly files: readonly ModuleFile[]
        /** `source_path` of entries that define no deployment strategy (not deployed). */
        readonly undecided: readonly string[]
        /** Why some entries of settings.json are ignored. */
        readonly invalidEntries: readonly string[]
        /** Deprecated settings used by the module. */
        readonly deprecations: readonly string[]
      }
    | {
        /** Why settings.json could not be used. Such a module has no files. */
        readonly error: string
      }
  )

export interface Script {
  readonly name: string
  /** Path relative to the `scripts/` folder. */
  readonly file: string
  readonly path: string
}

type Environment = Pick<Context, 'home' | 'cwd'> & { warn(message: string): void }

/** The modules, and the folder of the repository they come from. */
export async function loadRepository(
  ctx: Context,
): Promise<{ repository: string; modules: Module[] }> {
  const { folderPath } = await new ConfigStore(ctx.home).read()
  const modules = await listModules(folderPath, {
    home: ctx.home,
    cwd: ctx.cwd,
    warn: message => ctx.output.warn(message),
  })
  return { repository: folderPath, modules }
}

/**
 * Reads the modules of a dotfiles repository: every folder of `files/`
 * (symlinks to folders included) that contains a `settings.json`.
 */
export async function listModules(folderPath: string, env: Environment): Promise<Module[]> {
  const filesDir = path.join(folderPath, 'files')
  const modules: Module[] = []

  for (const entry of await readDirOrFail(filesDir)) {
    if (entry.name.startsWith('.')) continue

    const modulePath = path.join(filesDir, entry.name)
    const stats = await statEntry(entry, modulePath, env)
    if (!stats?.isDirectory()) continue

    const settingsPath = path.join(modulePath, 'settings.json')
    const settingsStats = await stat(settingsPath).catch(errorCode)
    if (settingsStats === 'ENOENT') continue

    const name = slugify(entry.name)
    if (!isUsableName(name, entry.name, modules, 'module', env)) continue

    if (typeof settingsStats === 'string') {
      modules.push({
        name,
        path: modulePath,
        error: `settings.json cannot be read (${settingsStats})`,
      })
      continue
    }

    modules.push({
      name,
      path: modulePath,
      ...(await readModuleFiles(modulePath, settingsPath, folderPath, env)),
    })
  }

  return modules
}

const DEPLOY_STRATEGIES = ['global', 'local', 'none'] as const
type DeployStrategy = (typeof DEPLOY_STRATEGIES)[number]

/**
 * Reads `"deploy": "global" | "local" | "none"`, or its older spelling
 * `"global": true | false`.
 */
function readStrategy(entry: Record<string, unknown>): DeployStrategy | 'unset' | 'invalid' {
  const { deploy, global } = entry

  if (deploy !== undefined) {
    if (global !== undefined) return 'invalid'
    return DEPLOY_STRATEGIES.find(strategy => strategy === deploy) ?? 'invalid'
  }
  if (global === undefined) return 'unset'
  if (typeof global !== 'boolean') return 'invalid'
  return global ? 'global' : 'local'
}

type ModuleContent = Exclude<Module, { error: string }>

async function readModuleFiles(
  modulePath: string,
  settingsPath: string,
  repository: string,
  env: Environment,
): Promise<Omit<ModuleContent, keyof ModuleBase> | { error: string }> {
  let settings: unknown
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  } catch (error) {
    return { error: `settings.json is not valid JSON (${describeJsonError(error)})` }
  }

  // configfile 0.3.1 wrote the list of files at the top level of settings.json.
  const legacyList = Array.isArray(settings)
  const entries: unknown = legacyList ? settings : (settings as { files?: unknown } | null)?.files
  if (!Array.isArray(entries)) {
    return { error: 'settings.json has no "files" list' }
  }

  const files: ModuleFile[] = []
  const undecided: string[] = []
  const invalidEntries: string[] = []
  let usesLegacyKey = false

  for (const [index, entry] of (entries as unknown[]).entries()) {
    const invalid = (reason: string) =>
      invalidEntries.push(`entry #${index + 1} is ignored: ${reason}`)

    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid('it is not an object')
      continue
    }

    const fields = entry as Record<string, unknown>
    const { source_path: source, target_path: target } = fields
    const strategy = readStrategy(fields)
    if (typeof fields.global === 'boolean' && fields.deploy === undefined) usesLegacyKey = true

    if (strategy === 'none') continue
    if (typeof source !== 'string' || source.trim() === '') {
      invalid('"source_path" is missing')
      continue
    }
    const resolvedSource = path.resolve(modulePath, source)
    if (
      path.isAbsolute(source) ||
      resolvedSource === modulePath ||
      !contains(modulePath, resolvedSource)
    ) {
      invalid(`"source_path" (${source}) must name a file or folder inside the module folder`)
      continue
    }

    switch (strategy) {
      case 'invalid':
        invalid('use "deploy": "global", "local" or "none" (or "global": true or false, not both)')
        continue
      case 'unset':
        undecided.push(source)
        continue
    }

    if (typeof target !== 'string' || target.trim() === '') {
      invalid('"target_path" is missing')
      continue
    }

    // Global files belong to the user's home; local files to the current folder.
    const resolvedTarget = resolveUserPath(target.trim(), {
      home: env.home,
      cwd: strategy === 'global' ? env.home : env.cwd,
    })

    const problem = unsafeTarget(resolvedTarget, { ...env, repository, module: modulePath })
    if (problem != null) {
      invalid(`"target_path" (${target}) ${problem}`)
      continue
    }

    files.push({
      source: resolvedSource,
      target: resolvedTarget,
      strategy,
      repository,
      module: modulePath,
      entry: {
        module: path.relative(repository, modulePath),
        source: path.relative(modulePath, resolvedSource),
        target: target.trim(),
        folder: strategy === 'global' ? env.home : env.cwd,
      },
    })
  }

  const deprecations: string[] = []
  if (legacyList) {
    deprecations.push(
      'settings.json is a list (configfile 0.3 format), which is deprecated and will stop ' +
        'working in 2.0. Put the list in a "files" key: { "files": [ ... ] }',
    )
  }
  if (usesLegacyKey) {
    deprecations.push(
      '"global": true | false is deprecated and will stop working in 2.0. ' +
        'Use "deploy": "global" | "local" instead',
    )
  }

  return { error: null, files, undecided, invalidEntries, deprecations }
}

/**
 * Why deploying to `target` could destroy something important, or `null`.
 * Deploying moves whatever is at the target aside, so the target must not be
 * the home folder, the current folder, the repository, one of their parents,
 * anything inside the repository or the module, or configfile's own files.
 *
 * Paths are compared as written; deploying checks them again by identity.
 */
export function unsafeTarget(
  target: string,
  {
    home,
    cwd,
    repository,
    module,
  }: { home: string; cwd: string; repository: string; module: string },
): string | null {
  const own = configfilePaths(home)

  for (const [folder, label] of [
    [home, 'the home folder'],
    [cwd, 'the current folder'],
    [repository, 'the dotfiles repository'],
    [module, 'the module folder'],
    [own.rc, "configfile's configuration"],
    [own.dir, "configfile's working folder"],
  ] as const) {
    if (contains(target, folder)) return `would replace ${label} (${folder})`
  }
  for (const [folder, label] of [
    [repository, 'the dotfiles repository'],
    [module, 'the module folder'],
    [own.dir, "configfile's working folder"],
  ] as const) {
    if (contains(folder, target)) return `is inside ${label} (${folder})`
  }
  return null
}

/**
 * Reads the scripts of a dotfiles repository: every file of `scripts/`, and
 * every folder of `scripts/` (symlinks included) containing an `index` file.
 * Hidden files are ignored. When `extensions` is set, only files with one of
 * these extensions count (`''` means "no extension").
 *
 * A script is named after its file name up to the first dot: `setup.macos.sh`
 * is the `setup` script.
 */
export async function listScripts(
  folderPath: string,
  extensions: readonly string[] | null,
  env: Pick<Environment, 'warn'>,
): Promise<Script[]> {
  const scriptsDir = path.join(folderPath, 'scripts')
  const scripts: Script[] = []
  const allowed = (name: string) => extensions == null || extensions.includes(path.extname(name))

  for (const entry of await readDirOrFail(scriptsDir)) {
    if (entry.name.startsWith('.')) continue

    const stats = await statEntry(entry, path.join(scriptsDir, entry.name), env)
    if (stats == null) continue

    let file: string | undefined
    if (stats.isDirectory()) {
      file = await findIndex(scriptsDir, entry.name, allowed, env)
    } else if (stats.isFile() && allowed(entry.name)) {
      file = entry.name
    }
    if (file == null) continue

    const [baseName = ''] = entry.name.split('.')
    const name = slugify(baseName)
    if (!isUsableName(name, file, scripts, 'script', env)) continue

    scripts.push({ name, file, path: path.join(scriptsDir, file) })
  }

  return scripts
}

/** The `index` file of a script folder (`index`, `index.sh`, …), relative to `scriptsDir`. */
async function findIndex(
  scriptsDir: string,
  folder: string,
  allowed: (name: string) => boolean,
  env: Pick<Environment, 'warn'>,
): Promise<string | undefined> {
  let names: string[]
  try {
    names = await readdir(path.join(scriptsDir, folder))
  } catch (error) {
    env.warn(`Script folder ${path.join(scriptsDir, folder)} cannot be read (${errorCode(error)}).`)
    return undefined
  }

  for (const name of names.sort()) {
    if (name !== 'index' && !name.startsWith('index.')) continue
    if (!allowed(name)) continue
    if ((await stat(path.join(scriptsDir, folder, name)).catch(() => null))?.isFile()) {
      return path.join(folder, name)
    }
  }
  return undefined
}

/** Follows symlinks. Returns `null` (with a warning) when the link cannot be followed. */
async function statEntry(entry: Dirent, fullPath: string, env: Pick<Environment, 'warn'>) {
  if (!entry.isSymbolicLink()) {
    return { isDirectory: () => entry.isDirectory(), isFile: () => entry.isFile() }
  }

  const stats: Stats | string = await stat(fullPath).catch(errorCode)
  if (typeof stats === 'string') {
    const reason = stats === 'ENOENT' ? 'is a broken symbolic link' : `cannot be read (${stats})`
    env.warn(`${fullPath} ${reason}. It is ignored.`)
    return null
  }
  return stats
}

/** Rejects empty names and names already taken, with a warning. */
function isUsableName(
  name: string,
  source: string,
  existing: readonly { name: string }[],
  kind: 'module' | 'script',
  env: Pick<Environment, 'warn'>,
): boolean {
  if (name === '') {
    env.warn(
      `"${source}" has no usable ${kind} name (ASCII letters, digits, "_" or "-"). It is ignored.`,
    )
    return false
  }
  if (existing.some(other => other.name === name)) {
    env.warn(`"${source}" is ignored: another ${kind} is already named "${name}".`)
    return false
  }
  return true
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? (error as Error).message
}

/** Sorted entries of `dir`. A missing subfolder means "nothing there"; a missing repository is an error. */
async function readDirOrFail(dir: string): Promise<Dirent[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const repository = path.dirname(dir)

    if (code === 'ENOENT') {
      const repositoryStats = await stat(repository).catch(() => null)
      if (repositoryStats == null) {
        throw new CliError(`Dotfiles folder ${repository} does not exist. Run "configfile init".`)
      }
      if (!repositoryStats.isDirectory()) {
        throw new CliError(`Dotfiles folder ${repository} is not a folder. Run "configfile init".`)
      }
      return []
    }
    if (code === 'ENOTDIR') {
      throw new CliError(`${dir} is not a folder.`)
    }
    throw new CliError(`Cannot read ${dir}: ${(error as Error).message}`, { cause: error })
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}
