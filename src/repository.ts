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
  /** `global`: deployed into the home folder by a regular deploy. `local`: copied by `deploy --local`. */
  readonly strategy: 'global' | 'local'
  /** How it is deployed: global files are copied unless `"method": "link"`; local files are always copied. */
  readonly method: 'link' | 'copy'
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
        /** The names of the scripts run before and after the module is deployed or undeployed. */
        readonly hooks: Readonly<Partial<Record<Hook, string>>>
        /** Why some of these settings cannot be used (not a string, or empty). */
        readonly hookProblems: Readonly<Partial<Record<Hook, string>>>
      }
    | {
        /** Why settings.json could not be used. Such a module has no files. */
        readonly error: string
      }
  )

/** The settings that name a script run when the module is deployed or undeployed. */
export const HOOKS = ['pre_deploy', 'post_deploy', 'pre_undeploy', 'post_undeploy'] as const
export type Hook = (typeof HOOKS)[number]

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
  const { folderPath } = await new ConfigStore(ctx.home, {
    warn: message => ctx.output.warn(message),
  }).read()
  const modules = await listModules(folderPath, {
    home: ctx.home,
    cwd: ctx.cwd,
    warn: message => ctx.output.warn(message),
  })
  return { repository: folderPath, modules }
}

/** The scripts, and the folder of the repository they come from. */
export async function loadScripts(
  ctx: Context,
): Promise<{ repository: string; scripts: Script[]; otherSystems: string[] }> {
  const warn = (message: string) => ctx.output.warn(message)
  const config = await new ConfigStore(ctx.home, { warn }).read()
  const listed = await listScripts(config.folderPath, config.scriptExtensions, ctx.platform, {
    warn,
  })
  return { repository: config.folderPath, ...listed }
}

/**
 * The variables every script gets. Scripts run in the current folder, and a
 * folder script is one level deeper: this gives them the repository's path,
 * and the system whose versions run. Documented in
 * docs/src/content/docs/reference/scripts.md.
 */
export function scriptEnvironment(
  script: Script,
  repository: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  return {
    CONFIGFILE_REPO: repository,
    CONFIGFILE_SCRIPT: script.name,
    CONFIGFILE_OS: systemName(platform),
  }
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

const METHODS = ['link', 'copy'] as const

/**
 * Reads `"method": "link" | "copy"`: global files are copied unless they ask
 * for a link, local files are always copied. Returns why it cannot be used.
 */
function readMethod(
  entry: Record<string, unknown>,
  strategy: 'global' | 'local',
): 'link' | 'copy' | { invalid: string } {
  const { method } = entry
  if (method === undefined) return 'copy'
  const known = METHODS.find(value => value === method)
  if (known == null) return { invalid: 'use "method": "link" or "copy"' }
  if (known === 'link' && strategy === 'local') {
    return {
      invalid: '"method": "link" only applies to global files (local files are always copied)',
    }
  }
  return known
}

/** Reads `"deploy": "global" | "local" | "none"`. */
function readStrategy(entry: Record<string, unknown>): DeployStrategy | 'unset' | 'invalid' {
  const { deploy } = entry
  if (deploy === undefined) return 'unset'
  return DEPLOY_STRATEGIES.find(strategy => strategy === deploy) ?? 'invalid'
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

  // configfile 0.3 wrote the list of files at the top level of settings.json.
  if (Array.isArray(settings)) {
    return {
      error:
        'settings.json is a list, the format of configfile 0.3, which 2.0 no longer reads. ' +
        'Put the list in a "files" key: { "files": [ ... ] }',
    }
  }
  const entries: unknown = (settings as { files?: unknown } | null)?.files
  if (!Array.isArray(entries)) {
    return { error: 'settings.json has no "files" list' }
  }

  const files: ModuleFile[] = []
  const undecided: string[] = []
  const invalidEntries: string[] = []

  for (const [index, entry] of (entries as unknown[]).entries()) {
    const invalid = (reason: string) =>
      invalidEntries.push(`entry #${index + 1} is ignored: ${reason}`)

    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid('it is not an object')
      continue
    }

    const fields = entry as Record<string, unknown>
    const { source_path: source, target_path: target } = fields
    // Its older spelling, gone in 2.0: never guessed, so the entry is never deployed by mistake.
    if (fields.global !== undefined) {
      invalid('"global" is no longer read (configfile 2.0): use "deploy": "global" or "local"')
      continue
    }
    const strategy = readStrategy(fields)

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
        invalid('use "deploy": "global", "local" or "none"')
        continue
      case 'unset':
        undecided.push(source)
        continue
    }

    if (typeof target !== 'string' || target.trim() === '') {
      invalid('"target_path" is missing')
      continue
    }
    const method = readMethod(fields, strategy)
    if (typeof method !== 'string') {
      invalid(method.invalid)
      continue
    }

    // Global files belong to the user's home; local files to the current folder.
    const resolvedTarget = resolveUserPath(target.trim(), {
      home: env.home,
      cwd: strategy === 'global' ? env.home : env.cwd,
    })

    // A copy is kept up to date in place, so it may hold the current folder:
    // replacing or removing it whole is checked when it happens (see `Guard`).
    const copied = strategy === 'global' && method === 'copy'
    const problem = unsafeTarget(resolvedTarget, {
      ...env,
      cwd: copied ? null : env.cwd,
      repository,
      module: modulePath,
    })
    if (problem != null) {
      invalid(`"target_path" (${target}) ${problem}`)
      continue
    }

    files.push({
      source: resolvedSource,
      target: resolvedTarget,
      strategy,
      method,
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

  const hooks: Partial<Record<Hook, string>> = {}
  const hookProblems: Partial<Record<Hook, string>> = {}
  for (const hook of HOOKS) {
    const name = (settings as Record<string, unknown>)[hook]
    if (name === undefined) continue
    if (typeof name === 'string' && name.trim() !== '') hooks[hook] = name.trim()
    else
      hookProblems[hook] = `"${hook}" is ignored: it must be the name of a script of the repository`
  }

  return { error: null, files, undecided, invalidEntries, hooks, hookProblems }
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
  }: { home: string; cwd: string | null; repository: string; module: string },
): string | null {
  const own = configfilePaths(home)

  for (const [folder, label] of [
    [home, 'the home folder'],
    ...(cwd == null ? [] : [[cwd, 'the current folder'] as const]),
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
 * A script is named after its file name up to the first dot: `setup.sh` is the
 * `setup` script. A second part naming a system (`setup.macos.sh`,
 * `setup.linux/`) makes it that system's version: used instead of `setup.sh`
 * on that system, and ignored on the others.
 *
 * `otherSystems` names the scripts that only have versions for other systems:
 * they are not scripts here, but their name is not a mistake either.
 */
export async function listScripts(
  folderPath: string,
  extensions: readonly string[] | null,
  platform: NodeJS.Platform,
  env: Pick<Environment, 'warn'>,
): Promise<{ scripts: Script[]; otherSystems: string[] }> {
  const scriptsDir = path.join(folderPath, 'scripts')
  const scripts: Script[] = []
  /** Names of the scripts that are this system's version. */
  const forSystem = new Set<string>()
  const elsewhere = new Set<string>()
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

    const [baseName = '', tag] = entry.name.split('.')
    const system = tag == null ? undefined : SCRIPT_SYSTEMS.get(tag)
    const name = slugify(baseName)
    if (system != null && system !== platform) {
      elsewhere.add(name)
      continue
    }
    const script = { name, file, path: path.join(scriptsDir, file) }

    // This system's version replaces the generic one, whichever comes first.
    const current = scripts.findIndex(other => other.name === name)
    if (current !== -1 && forSystem.has(name) !== (system != null)) {
      if (system != null) {
        scripts[current] = script
        forSystem.add(name)
      }
      continue
    }
    if (!isUsableName(name, file, scripts, 'script', env)) continue

    scripts.push(script)
    if (system != null) forSystem.add(name)
  }

  const otherSystems = [...elsewhere].filter(name => !scripts.some(script => script.name === name))
  return { scripts, otherSystems }
}

/** The name of `platform` in script names (`macos`, `linux`), or the platform itself. */
export function systemName(platform: NodeJS.Platform): string {
  for (const [name, system] of SCRIPT_SYSTEMS) if (system === platform) return name
  return platform
}

/** The systems a script can be made for, by the second part of its name. */
const SCRIPT_SYSTEMS: ReadonlyMap<string, NodeJS.Platform> = new Map([
  ['macos', 'darwin'],
  ['linux', 'linux'],
])

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
