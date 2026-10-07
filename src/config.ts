import { existsSync } from 'node:fs'
import { chmod, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { CliError, NotInitializedError } from './errors.ts'
import { describeJsonError, messageOf, writeFileAtomic } from './fsutil.ts'
import { resolveUserPath } from './paths.ts'

export interface Config {
  /** URL of the dotfiles git repository. */
  readonly repoUrl: string | null
  /** Absolute path of the local clone of the dotfiles repository. */
  readonly folderPath: string
  /**
   * File extensions recognised as scripts, with their dot (`''` means "no
   * extension"), or `null` when every file of `scripts/` is a script.
   */
  readonly scriptExtensions: readonly string[] | null
}

/** On-disk shape of `~/.configfilerc`. Unknown keys are preserved on write. */
interface RawConfig {
  repo_url?: unknown
  folder_path?: unknown
  script_extensions?: unknown
  [key: string]: unknown
}

/** The file exists and is readable, but its content is not a valid configuration. */
class InvalidConfigError extends CliError {
  override name = 'InvalidConfigError'
}

export class ConfigStore {
  readonly path: string
  readonly #home: string
  readonly #warn: (message: string) => void

  /** `warn` reports a configuration other users could read, made private on reading. */
  constructor(home: string, { warn = () => {} }: { warn?: (message: string) => void } = {}) {
    this.#home = home
    this.#warn = warn
    this.path = path.join(home, '.configfilerc')
  }

  exists(): boolean {
    return existsSync(this.path)
  }

  async read(): Promise<Config> {
    const raw = await this.#readRaw()

    if (raw == null) {
      throw new NotInitializedError(this.path)
    }

    if (typeof raw.folder_path !== 'string' || raw.folder_path.trim() === '') {
      throw new InvalidConfigError(
        `Invalid configuration in ${this.path}: "folder_path" is missing.`,
      )
    }

    return {
      repoUrl: typeof raw.repo_url === 'string' ? raw.repo_url : null,
      // Hand-edited values such as "~/dotfiles" must not depend on the current folder.
      folderPath: resolveUserPath(raw.folder_path.trim(), { home: this.#home, cwd: this.#home }),
      scriptExtensions: this.#readExtensions(raw.script_extensions),
    }
  }

  /** Reads the stored values without validating them, for use as prompt defaults. */
  async readPartial(): Promise<{ repoUrl?: string; folderPath?: string }> {
    const raw = await this.#readRaw().catch(ignoreInvalid)
    const partial: { repoUrl?: string; folderPath?: string } = {}

    if (typeof raw?.repo_url === 'string') partial.repoUrl = raw.repo_url
    if (typeof raw?.folder_path === 'string' && raw.folder_path.trim() !== '') {
      // Resolved like `read` does: "~/dotfiles" must not become a folder named "~".
      partial.folderPath = resolveUserPath(raw.folder_path.trim(), {
        home: this.#home,
        cwd: this.#home,
      })
    }

    return partial
  }

  /**
   * The maximum size of the history (`history_max_size`), in bytes: a number
   * of bytes or a size such as "512KB" or "5MB"; 0 turns the history off.
   * Works before `init`, without a configuration file. An invalid value gives
   * the default and a warning. A file that cannot be read gives 0 and a
   * warning: it may be what turns the history off.
   */
  async readHistorySize(): Promise<{ maxBytes: number; warning: string | null }> {
    let raw: RawConfig | null
    try {
      raw = await this.#readRaw()
    } catch (error) {
      return {
        maxBytes: 0,
        warning: `${messageOf(error)} This run is not recorded in the history.`,
      }
    }

    const value = raw?.history_max_size
    if (value === undefined) return { maxBytes: DEFAULT_HISTORY_SIZE, warning: null }

    const size = parseSize(value)
    if (size == null || size > MAX_HISTORY_SIZE) {
      return {
        maxBytes: DEFAULT_HISTORY_SIZE,
        warning:
          `"history_max_size" in ${this.path} must be a size up to 1GB, such as 1048576, ` +
          `"512KB" or "5MB" (0 turns the history off); using 1MB.`,
      }
    }
    return { maxBytes: size, warning: null }
  }

  /** Saves the configuration. Unknown keys of a valid existing file are kept. */
  async write(config: { repoUrl: string; folderPath: string }): Promise<void> {
    const previous = (await this.#readRaw().catch(ignoreInvalid)) ?? {}
    const next: RawConfig = {
      ...previous,
      repo_url: config.repoUrl,
      folder_path: config.folderPath,
    }

    try {
      // Readable by the user only: the repository URL may contain credentials.
      await writeFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      throw new CliError(
        `Cannot save the configuration to ${this.path}: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }

  #readExtensions(value: unknown): readonly string[] | null {
    if (value === undefined || value === null) return null

    if (!Array.isArray(value) || !value.every(ext => typeof ext === 'string')) {
      throw new InvalidConfigError(
        `Invalid configuration in ${this.path}: "script_extensions" must be a list of strings, such as [".sh", ".py", ""].`,
      )
    }

    // Accept "py" as well as ".py".
    return value.map(ext => (ext === '' || ext.startsWith('.') ? ext : `.${ext}`))
  }

  async #readRaw(): Promise<RawConfig | null> {
    let content: string
    try {
      content = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new CliError(`Cannot read ${this.path}: ${(error as Error).message}`, { cause: error })
    }

    let data: unknown
    try {
      data = JSON.parse(content)
    } catch (error) {
      throw new InvalidConfigError(
        `Invalid configuration in ${this.path}: not valid JSON (${describeJsonError(error)}).`,
      )
    }

    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidConfigError(`Invalid configuration in ${this.path}: not a JSON object.`)
    }
    await this.#makePrivate()
    return data as RawConfig
  }

  /**
   * The repository URL may contain credentials: a configuration other users
   * can read (written by hand, or by configfile 0.3) is made readable by its
   * owner only, with a warning.
   */
  async #makePrivate(): Promise<void> {
    const stats = await stat(this.path).catch(() => null)
    if (stats == null || (stats.mode & 0o077) === 0) return

    try {
      await chmod(this.path, stats.mode & 0o700)
      this.#warn(`${this.path} was readable by other users. It is now only readable by you.`)
    } catch (error) {
      this.#warn(
        `${this.path} is readable by other users, and cannot be made private (${messageOf(error)}). ` +
          `Run "chmod 600 ${this.path}".`,
      )
    }
  }
}

function ignoreInvalid(error: unknown): null {
  if (error instanceof InvalidConfigError) return null
  throw error
}

/** Default size of `history.jsonl` before it is rotated: 1 MiB. */
export const DEFAULT_HISTORY_SIZE = 1024 * 1024

/** Larger histories would be slow to read back. */
const MAX_HISTORY_SIZE = 1024 ** 3

const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }

/** Bytes from 1048576, "1048576", "512KB" or "5 MB"; `null` when invalid. */
function parseSize(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  const match = /^\s*(\d+)\s*(B|KB|MB|GB)?\s*$/i.exec(value)
  if (match == null) return null
  return Number(match[1]) * (UNITS[(match[2] ?? 'B').toUpperCase()] ?? 1)
}
