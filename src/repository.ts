import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  type Condition,
  combine,
  type Machine,
  profilesOf,
  readWhen,
  whyNotFor,
} from './conditions.ts'
import { ConfigStore } from './config.ts'
import type { Context } from './context.ts'
import { CliError } from './errors.ts'
import { describeJsonError } from './fsutil.ts'
import { configfilePaths, contains, resolveUserPath, slugify } from './paths.ts'
import { version } from './version.ts'

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
  /** The entry of the file in its module's settings, recorded when it is deployed. */
  readonly entry?: Entry
  /** The machines it is for: its entry's `"when"` with its module's; everywhere when missing. */
  readonly condition?: Condition
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
  /** The name of its settings file (`module_settings` of the repository). */
  readonly settingsFile: string
}

export type Module = ModuleBase &
  (
    | {
        readonly error: null
        /**
         * Files to deploy on this machine. `"deploy": "none"`, invalid and
         * undecided entries, and those for other machines are left out.
         */
        readonly files: readonly ModuleFile[]
        /** The module's own `"when"`, or `null`. */
        readonly when: Condition | null
        /** Why the module is not for this machine (its own `"when"`), or `null`. */
        readonly notHere: string | null
        /** Valid entries for other machines, and why: every entry when the module is not for this one. */
        readonly elsewhere: readonly { readonly file: ModuleFile; readonly reason: string }[]
        /** `source_path` of entries that define no deployment strategy (not deployed). */
        readonly undecided: readonly string[]
        /** Why some entries of the module's settings are ignored. */
        readonly invalidEntries: readonly string[]
        /** The names of the scripts run before and after the module is deployed or undeployed. */
        readonly hooks: Readonly<Partial<Record<Hook, string>>>
        /** Why some of these settings cannot be used (not a string, or empty). */
        readonly hookProblems: Readonly<Partial<Record<Hook, string>>>
      }
    | {
        /** Why the module's settings could not be used. Such a module has no files. */
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

type Environment = Pick<Context, 'home' | 'cwd'> & {
  warn(message: string): void
  /** What `"when"` is checked against; without it, entries with a condition are for no machine. */
  machine?: Machine
  /**
   * Told about each folder of `files/` left out with a warning, and the
   * warning: for callers that say why a given folder is not a module.
   */
  skipped?(folder: string, warning: string): void
}

/**
 * The modules, the folder of the repository they come from, and the machine
 * their conditions were checked against: this one, or what `preview` gives
 * instead (`--os`, `--profile`), for that run only.
 */
export async function loadRepository(
  ctx: Context,
  preview: Partial<Machine> = {},
): Promise<{ repository: string; modules: Module[]; machine: Machine }> {
  const { folderPath, profiles } = await new ConfigStore(ctx.home, {
    warn: message => ctx.output.warn(message),
  }).read()
  const machine: Machine = {
    os: preview.os ?? systemName(ctx.platform),
    profiles: preview.profiles ?? profiles,
  }
  const modules = await listModules(folderPath, {
    home: ctx.home,
    cwd: ctx.cwd,
    warn: message => ctx.output.warn(message),
    machine,
  })
  return { repository: folderPath, modules, machine }
}

/** The profiles the conditions of the repository name, sorted. */
export function knownProfiles(modules: readonly Module[]): string[] {
  const names = new Set<string>()
  for (const module of modules) {
    if (module.error != null) continue
    for (const name of profilesOf(module.when)) names.add(name)
    for (const file of [...module.files, ...module.elsewhere.map(item => item.file)]) {
      for (const name of profilesOf(file.condition ?? null)) names.add(name)
    }
  }
  return [...names].sort()
}

/** The scripts, and the folder of the repository they come from. */
export async function loadScripts(ctx: Context): Promise<{
  repository: string
  scripts: Script[]
  otherSystems: string[]
  /** This machine's profiles, given to the scripts. */
  profiles: readonly string[]
}> {
  const warn = (message: string) => ctx.output.warn(message)
  const config = await new ConfigStore(ctx.home, { warn }).read()
  const listed = await listScripts(config.folderPath, config.scriptExtensions, ctx.platform, {
    warn,
  })
  return { repository: config.folderPath, ...listed, profiles: config.profiles }
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
  profiles: readonly string[],
): Record<string, string> {
  return {
    CONFIGFILE_REPO: repository,
    CONFIGFILE_SCRIPT: script.name,
    CONFIGFILE_OS: systemName(platform),
    CONFIGFILE_PROFILES: profiles.join(','),
  }
}

/** The settings of the repository itself, at its root: the same on every machine. */
export const REPOSITORY_SETTINGS = 'configfile.repository.json'

/** The settings file of each module, unless the repository names another. */
export const DEFAULT_MODULE_SETTINGS = 'configfile.module.json'

/** The settings file of each module in configfile 1.x. */
const LEGACY_MODULE_SETTINGS = 'settings.json'

/** Every name configfile knows for the settings of a module: the default, and configfile 1.x's. */
export const KNOWN_MODULE_SETTINGS: readonly string[] = [
  DEFAULT_MODULE_SETTINGS,
  LEGACY_MODULE_SETTINGS,
]

export interface RepositorySettings {
  /** The name of the settings file of each module (`module_settings`). */
  readonly moduleSettings: string
}

/** The settings of a repository without `configfile.repository.json`. */
export const DEFAULT_REPOSITORY_SETTINGS: RepositorySettings = {
  moduleSettings: DEFAULT_MODULE_SETTINGS,
}

const REPOSITORY_KEYS = ['$schema', 'module_settings']

/**
 * Reads `configfile.repository.json`, at the root of the repository, or
 * gives the defaults when it is missing (a broken symbolic link is an
 * error). Fails on a key configfile doesn't know:
 * ignoring it could read the repository the wrong way.
 */
export async function readRepositorySettings(folder: string): Promise<RepositorySettings> {
  const file = path.join(folder, REPOSITORY_SETTINGS)
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    // A repository that is missing, or not a folder, is said so when its modules are read.
    if (['ENOENT', 'ENOTDIR'].includes(errorCode(error))) {
      // A symbolic link to nothing is a mistake: the defaults could misread the repository.
      if (await isBrokenLink(file)) {
        throw new CliError(`${file} is a broken symbolic link.`)
      }
      return DEFAULT_REPOSITORY_SETTINGS
    }
    throw new CliError(`Cannot read ${file}: ${(error as Error).message}`, { cause: error })
  }
  return parseRepositorySettings(content, file)
}

/**
 * Reads the content of `configfile.repository.json` (`file` names it in
 * messages). Fails on what configfile cannot use.
 */
export function parseRepositorySettings(content: string, file: string): RepositorySettings {
  let settings: unknown
  try {
    settings = JSON.parse(content)
  } catch (error) {
    throw new CliError(`${file} is not valid JSON (${describeJsonError(error)}).`)
  }
  if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new CliError(`${file} is not a JSON object.`)
  }
  const fields = settings as Record<string, unknown>
  const unknown = Object.keys(fields).filter(key => !REPOSITORY_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new CliError(
      `${file} has ${unknown.map(key => `"${key}"`).join(', ')}, which configfile ${version} ` +
        "doesn't know: this repository may need a newer configfile.",
    )
  }

  if (fields.$schema !== undefined && typeof fields.$schema !== 'string') {
    throw new CliError(`"$schema" in ${file} must be the address of a JSON Schema.`)
  }
  const moduleSettings =
    fields.module_settings === undefined ? DEFAULT_MODULE_SETTINGS : fields.module_settings
  if (
    typeof moduleSettings !== 'string' ||
    !/^[^/\\]+\.json$/.test(moduleSettings) ||
    moduleSettings === REPOSITORY_SETTINGS
  ) {
    throw new CliError(
      `"module_settings" in ${file} must be the name of a JSON file in each module folder, ` +
        `such as "${DEFAULT_MODULE_SETTINGS}".`,
    )
  }
  return { moduleSettings }
}

/**
 * Reads the modules of a dotfiles repository: every folder of `files/`
 * (symlinks to folders included) that contains the settings file its
 * repository names (`configfile.module.json` by default). Those whose
 * settings are under another known name are unusable modules, with how to
 * rename them; any other file under those names is skipped with a warning.
 * A folder whose name does not start with `.` is never left out without a
 * word when it has one of these files.
 */
export async function listModules(
  folderPath: string,
  env: Environment,
  /** The repository's settings, when the caller has read them already. */
  settings?: RepositorySettings,
): Promise<Module[]> {
  const { moduleSettings } = settings ?? (await readRepositorySettings(folderPath))
  const filesDir = path.join(folderPath, 'files')
  const modules: Module[] = []

  for (const entry of await readDirOrFail(filesDir)) {
    if (entry.name.startsWith('.')) continue

    const modulePath = path.join(filesDir, entry.name)
    const skip = (warning: string) => {
      env.warn(warning)
      env.skipped?.(modulePath, warning)
    }
    const stats = await statEntry(entry, modulePath, { warn: skip })
    if (!stats?.isDirectory()) continue

    const settingsPath = path.join(modulePath, moduleSettings)
    let settingsStats = await stat(settingsPath).catch(errorCode)
    // A link to nothing is not a missing file: it is said, as for other files.
    if (settingsStats === 'ENOENT' && (await isBrokenLink(settingsPath))) {
      settingsStats = 'a broken symbolic link'
    }
    // Settings under another name: those of configfile 1.x, or the default
    // one when the repository names another. Said, never skipped without a word.
    const misplaced =
      settingsStats === 'ENOENT' ? await findMisplacedSettings(modulePath, moduleSettings) : null
    if (settingsStats === 'ENOENT' && misplaced?.kind !== 'module') {
      if (misplaced != null) {
        skip(
          `${path.join(modulePath, misplaced.file)} is not read: this repository's modules are ` +
            `described by ${moduleSettings}. If it holds the settings of a module, fix it ` +
            `(${misplaced.problem}), then rename it to ${moduleSettings}.`,
        )
      }
      continue
    }

    const name = slugify(entry.name)
    if (!isUsableName(name, entry.name, modules, 'module', env)) continue
    const base = { name, path: modulePath, settingsFile: moduleSettings }

    if (misplaced?.kind === 'module') {
      const folder = path.join('files', entry.name)
      // git cannot rename a file through a link: it is renamed where the link points.
      const rename = entry.isSymbolicLink()
        ? `rename it to ${moduleSettings} where ${folder} links to`
        : `rename it ("git mv ${shellQuote(path.join(folder, misplaced.file))} ` +
          `${shellQuote(path.join(folder, moduleSettings))}" in your working copy)`
      modules.push({
        ...base,
        error:
          `it has ${misplaced.file}, but this repository's modules are described by ` +
          `${moduleSettings}: ${rename}, or set "module_settings": "${misplaced.file}" in ` +
          REPOSITORY_SETTINGS,
      })
      continue
    }
    if (typeof settingsStats === 'string') {
      modules.push({ ...base, error: `${moduleSettings} cannot be read (${settingsStats})` })
      continue
    }

    modules.push({
      ...base,
      ...(await readModuleFiles(modulePath, moduleSettings, folderPath, env)),
    })
  }

  return modules
}

/**
 * A file under another known name than the repository's for the settings of
 * a module: `module` when it is a module's settings (a JSON object with a
 * `"files"` list, or the list of configfile 0.3), `other` with why it is not
 * one (an app's own `settings.json`, or a file that cannot be read).
 */
type MisplacedSettings =
  | { readonly file: string; readonly kind: 'module' }
  | { readonly file: string; readonly kind: 'other'; readonly problem: string }

/**
 * The file under another known name, a module's settings or not, or `null`
 * when the folder has none (a broken symbolic link counts as one). A
 * module's settings win over a file that is not one.
 */
async function findMisplacedSettings(
  folder: string,
  moduleSettings: string,
): Promise<MisplacedSettings | null> {
  let other: MisplacedSettings | null = null
  for (const file of KNOWN_MODULE_SETTINGS.filter(name => name !== moduleSettings)) {
    let content: unknown
    try {
      content = JSON.parse(await readFile(path.join(folder, file), 'utf8'))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        if (await isBrokenLink(path.join(folder, file))) {
          other ??= { file, kind: 'other', problem: 'it is a broken symbolic link' }
        }
        continue
      }
      other ??= {
        file,
        kind: 'other',
        problem:
          error instanceof SyntaxError
            ? `not valid JSON: ${describeJsonError(error)}`
            : `cannot be read: ${errorCode(error)}`,
      }
      continue
    }
    if (Array.isArray(content) || Array.isArray((content as { files?: unknown } | null)?.files)) {
      return { file, kind: 'module' }
    }
    other ??= { file, kind: 'other', problem: 'it has no "files" list' }
  }
  return other
}

/** Called after ENOENT: a symbolic link there points to nothing. */
async function isBrokenLink(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => null))?.isSymbolicLink() === true
}

/** A path as a shell reads it: quoted when it holds anything but plain characters. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
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
  fileName: string,
  repository: string,
  env: Environment,
): Promise<Omit<ModuleContent, keyof ModuleBase> | { error: string }> {
  let content: string
  try {
    content = await readFile(path.join(modulePath, fileName), 'utf8')
  } catch (error) {
    // It exists (see listModules): a folder of that name, or no permission.
    return { error: `${fileName} cannot be read (${errorCode(error)})` }
  }
  let settings: unknown
  try {
    settings = JSON.parse(content)
  } catch (error) {
    return { error: `${fileName} is not valid JSON (${describeJsonError(error)})` }
  }

  // configfile 0.3 wrote the list of files at the top level of the file.
  if (Array.isArray(settings)) {
    return {
      error:
        `${fileName} is a list, the format of configfile 0.3, which 2.0 no longer reads. ` +
        'Put the list in a "files" key: { "files": [ ... ] }',
    }
  }
  const entries: unknown = (settings as { files?: unknown } | null)?.files
  if (!Array.isArray(entries)) {
    return { error: `${fileName} has no "files" list` }
  }

  // A module whose condition cannot be read is for no machine: never deployed everywhere.
  const rawWhen = (settings as Record<string, unknown>).when
  const when = rawWhen === undefined ? null : readWhen(rawWhen)
  if (when != null && 'invalid' in when) return { error: when.invalid }
  const whyNotHere = (condition: Condition | null) =>
    env.machine == null
      ? condition == null
        ? null
        : 'no machine to check "when" against'
      : whyNotFor(condition, env.machine)
  const moduleReason = whyNotHere(when)

  const files: ModuleFile[] = []
  const elsewhere: { file: ModuleFile; reason: string }[] = []
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
    const entryWhen = fields.when === undefined ? null : readWhen(fields.when)
    if (entryWhen != null && 'invalid' in entryWhen) {
      invalid(entryWhen.invalid)
      continue
    }
    const condition = combine(when, entryWhen)

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

    const file: ModuleFile = {
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
      ...(condition != null && { condition }),
    }
    const reason = moduleReason ?? whyNotHere(condition)
    if (reason == null) files.push(file)
    else elsewhere.push({ file, reason })
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

  return {
    error: null,
    files,
    when,
    notHere: moduleReason,
    elsewhere,
    undecided,
    invalidEntries,
    hooks,
    hookProblems,
  }
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

/** The platform a system name stands for (`macos` is `darwin`), or the name itself. */
export function platformOf(system: string): NodeJS.Platform {
  return SCRIPT_SYSTEMS.get(system) ?? (system as NodeJS.Platform)
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
