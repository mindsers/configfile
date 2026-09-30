import type { Dirent, Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import type { Context } from './context.js'
import { CliError } from './errors.js'
import { resolveUserPath, slugify } from './paths.js'

export interface ModuleFile {
  /** Absolute path of the file inside the dotfiles repository. */
  readonly source: string
  /** Absolute path where the file is deployed. */
  readonly target: string
  /** `global`: symlinked by a regular deploy. `local`: copied by `deploy --local`. */
  readonly strategy: 'global' | 'local'
}

export interface Module {
  readonly name: string
  readonly path: string
  /** Files to deploy. `"deploy": "none"`, invalid and undecided entries are left out. */
  readonly files: readonly ModuleFile[]
  /** `source_path` of entries that define no deployment strategy (not deployed). */
  readonly undecided: readonly string[]
  /** Why settings.json could not be used, or `null`. Such a module has no files. */
  readonly error: string | null
}

export interface Script {
  readonly name: string
  /** Path relative to the `scripts/` folder. */
  readonly file: string
  readonly path: string
}

type Environment = Pick<Context, 'home' | 'cwd'> & { warn(message: string): void }

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

    const content =
      typeof settingsStats === 'string'
        ? { files: [], undecided: [], error: `settings.json cannot be read (${settingsStats})` }
        : await readModuleFiles(name, modulePath, settingsPath, env)

    modules.push({ name, path: modulePath, ...content })
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

async function readModuleFiles(
  name: string,
  modulePath: string,
  settingsPath: string,
  env: Environment,
): Promise<Pick<Module, 'files' | 'undecided' | 'error'>> {
  const failed = (error: string) => ({ files: [], undecided: [], error })

  let settings: unknown
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  } catch (error) {
    return failed(`settings.json is not valid JSON (${(error as Error).message})`)
  }

  const entries: unknown = (settings as { files?: unknown } | null)?.files
  if (!Array.isArray(entries)) {
    return failed('settings.json has no "files" list')
  }

  const files: ModuleFile[] = []
  const undecided: string[] = []
  let usesLegacyKey = false

  for (const [index, entry] of (entries as unknown[]).entries()) {
    const invalid = (reason: string) =>
      env.warn(`Entry #${index + 1} of the "${name}" module settings is ignored: ${reason}.`)

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
    const unsafe = [env.home, env.cwd].find(folder => isSameOrAncestor(resolvedTarget, folder))
    if (unsafe != null) {
      invalid(`"target_path" (${target}) would replace ${unsafe}`)
      continue
    }

    files.push({ source: path.resolve(modulePath, source), target: resolvedTarget, strategy })
  }

  if (usesLegacyKey) {
    env.warn(
      `Module "${name}": "global": true | false is deprecated and will stop working in 2.0. ` +
        'Use "deploy": "global" | "local" instead.',
    )
  }

  return { files, undecided, error: null }
}

/**
 * Reads the scripts of a dotfiles repository. A script is either a file of
 * `scripts/` with an allowed extension, or a folder of `scripts/` (symlinks
 * included) containing an `index` file with an allowed extension. Hidden files
 * are ignored.
 */
export async function listScripts(
  folderPath: string,
  extensions: readonly string[],
  env: Pick<Environment, 'warn'>,
): Promise<Script[]> {
  const scriptsDir = path.join(folderPath, 'scripts')
  const scripts: Script[] = []

  for (const entry of await readDirOrFail(scriptsDir)) {
    if (entry.name.startsWith('.')) continue

    const stats = await statEntry(entry, path.join(scriptsDir, entry.name), env)
    if (stats == null) continue

    let file: string | undefined
    let baseName: string

    if (stats.isDirectory()) {
      baseName = entry.name
      file = undefined
      for (const ext of extensions) {
        const candidate = path.join(entry.name, `index${ext}`)
        if ((await stat(path.join(scriptsDir, candidate)).catch(() => null))?.isFile()) {
          file = candidate
          break
        }
      }
    } else {
      const ext = path.extname(entry.name)
      baseName = path.basename(entry.name, ext)
      file = stats.isFile() && extensions.includes(ext) ? entry.name : undefined
    }

    if (file == null) continue

    const name = slugify(baseName)
    if (!isUsableName(name, file, scripts, 'script', env)) continue

    scripts.push({ name, file, path: path.join(scriptsDir, file) })
  }

  return scripts
}

/** Follows symlinks. Returns `null` (with a warning) for a broken link. */
async function statEntry(entry: Dirent, fullPath: string, env: Pick<Environment, 'warn'>) {
  if (!entry.isSymbolicLink()) {
    return { isDirectory: () => entry.isDirectory(), isFile: () => entry.isFile() }
  }

  const stats: Stats | string = await stat(fullPath).catch(errorCode)
  if (typeof stats === 'string') {
    env.warn(`${fullPath} is a broken symbolic link (${stats}). It is ignored.`)
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
    env.warn(`"${source}" has no usable ${kind} name (letters, digits, "_" or "-"). It is ignored.`)
    return false
  }
  if (existing.some(other => other.name === name)) {
    env.warn(`"${source}" is ignored: another ${kind} is already named "${name}".`)
    return false
  }
  return true
}

function isSameOrAncestor(candidate: string, folder: string): boolean {
  const relative = path.relative(candidate, folder)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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
    throw new CliError(`Cannot read ${dir}: ${(error as Error).message}`)
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}
