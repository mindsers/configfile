import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { CliError, NotInitializedError } from './errors.js'
import { resolveUserPath } from './paths.js'

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

  constructor(home: string) {
    this.#home = home
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
    if (typeof raw?.folder_path === 'string') partial.folderPath = raw.folder_path

    return partial
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
      await writeFile(this.path, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      throw new CliError(
        `Cannot save the configuration to ${this.path}: ${(error as Error).message}`,
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
      throw new CliError(`Cannot read ${this.path}: ${(error as Error).message}`)
    }

    let data: unknown
    try {
      data = JSON.parse(content)
    } catch (error) {
      throw new InvalidConfigError(
        `Invalid configuration in ${this.path}: not valid JSON (${(error as Error).message}).`,
      )
    }

    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidConfigError(`Invalid configuration in ${this.path}: not a JSON object.`)
    }
    return data as RawConfig
  }
}

function ignoreInvalid(error: unknown): null {
  if (error instanceof InvalidConfigError) return null
  throw error
}
