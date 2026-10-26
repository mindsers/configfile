import { createHash, randomBytes } from 'node:crypto'
import { constants, existsSync, type Stats } from 'node:fs'
import { chmod, lstat, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { CliError } from './errors.ts'

/** Identifies a file or folder independently of the path used to reach it. */
export interface Identity {
  readonly dev: number
  readonly ino: number
}

export function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The message of a `JSON.parse` error without the start of the text it
 * quotes, which may contain a secret.
 */
export function describeJsonError(error: unknown): string {
  return messageOf(error).replace(/, "[\s\S]*"(?:\.\.\.)? is not valid JSON$/, '')
}

/** `lstat`, or `null` when nothing exists at `target`. Other errors are thrown. */
export async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null
    throw error
  }
}

/** `stat` (following links), or `null` when nothing exists there. Other errors are thrown. */
export async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await stat(target)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null
    throw error
  }
}

export function identityOf(stats: Stats): Identity {
  return { dev: stats.dev, ino: stats.ino }
}

export function sameIdentity(a: Identity | null | undefined, b: Identity | null | undefined) {
  return a != null && b != null && a.dev === b.dev && a.ino === b.ino
}

export function kindOf(stats: Stats): 'file' | 'folder' | 'link' {
  if (stats.isSymbolicLink()) return 'link'
  return stats.isDirectory() ? 'folder' : 'file'
}

/** Real path of `target`, or of its closest existing parent followed by the rest. */
export async function realpathOfExisting(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch (error) {
    const parent = path.dirname(target)
    if (errnoCode(error) !== 'ENOENT' || parent === target) throw error
    return path.join(await realpathOfExisting(parent), path.basename(target))
  }
}

/** A name next to `target` that nothing else uses, for temporary copies. */
export function siblingName(target: string, purpose: string): string {
  const random = randomBytes(4).toString('hex')
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.configfile-${purpose}-${process.pid}-${random}`,
  )
}

/**
 * Writes `content` to `file` through a new temporary file, so readers never
 * see a half-written file. The temporary file is created exclusively, so a
 * planted symbolic link is never followed.
 */
export async function writeFileAtomic(
  file: string,
  content: string | Buffer,
  { mode }: { mode: number },
): Promise<void> {
  const temporary = siblingName(file, 'write')
  {
    await using handle = await open(temporary, 'wx', mode)
    await handle.writeFile(content)
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Deletes a file or folder, including read-only subfolders. Never follows links. */
export async function removeTree(target: string): Promise<void> {
  const stats = await lstatOrNull(target)
  if (stats == null) return

  if (stats.isDirectory()) {
    await chmod(target, 0o700)
    for (const name of await readdir(target)) {
      await removeTree(path.join(target, name))
    }
  }
  await rm(target, { recursive: true, force: true })
}

/** The content of a file: its SHA-256 (hexadecimal) and size. */
export interface ContentHash {
  readonly sha256: string
  readonly size: number
}

export function hashContent(content: Buffer): ContentHash {
  return { sha256: createHash('sha256').update(content).digest('hex'), size: content.length }
}

/**
 * The hash of a regular file, read in chunks. `follow: false` fails with
 * `ELOOP` when the file itself is a symbolic link; its parent folders are
 * the caller's to check.
 */
export async function hashFile(
  file: string,
  { follow }: { follow: boolean },
): Promise<ContentHash> {
  const flags = constants.O_RDONLY | (follow ? 0 : constants.O_NOFOLLOW)
  await using handle = await open(file, flags)
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(64 * 1024)
  let size = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    size += bytesRead
  }
  return { sha256: hash.digest('hex'), size }
}

export function sameHash(a: ContentHash | null | undefined, b: ContentHash | null | undefined) {
  return a != null && b != null && a.size === b.size && a.sha256 === b.sha256
}

/** What is at a folder to clone into or reuse (see `inspectFolder`). */
export type FolderState = 'missing' | 'empty' | 'git-repository' | 'not-empty' | 'not-a-directory'

/**
 * What is at `folderPath`, for a folder to clone into or reuse: nothing, an
 * empty folder, a git repository (a `.git` folder or file), or something
 * else. Fails for a broken symbolic link, or a folder that cannot be read.
 */
export async function inspectFolder(folderPath: string): Promise<FolderState> {
  const fail = (error: unknown): never => {
    throw new CliError(`Cannot use ${folderPath}: ${messageOf(error)}`, { cause: error })
  }

  const link = await lstatOrNull(folderPath).catch(fail)
  if (link == null) return 'missing'

  const stats = await stat(folderPath).catch(error => {
    if (errnoCode(error) === 'ENOENT') {
      throw new CliError(`${folderPath} is a broken symbolic link.`)
    }
    return fail(error)
  })

  if (!stats.isDirectory()) return 'not-a-directory'
  if (existsSync(path.join(folderPath, '.git'))) return 'git-repository'
  if ((await readdir(folderPath).catch(fail)).length > 0) return 'not-empty'
  return 'empty'
}
