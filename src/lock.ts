import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Context } from './context.ts'
import { CliError } from './errors.ts'
import { errnoCode, messageOf } from './fsutil.ts'
import { configfilePaths } from './paths.ts'

const RETRY_DELAY_MS = 100
const MAX_WAIT_MS = 10_000

/** The locks this process holds: a lock naming this process that is not here was left behind. */
const held = new Set<string>()

/**
 * Runs `task` while holding `~/.configfile/lock`, so that two configfile
 * processes never change the same files, the deployment record, the mirror of
 * the repository or the configuration at once. Waits a little for another
 * process to finish, and takes over the lock of a process that no longer
 * exists.
 *
 * The lock always holds the pid of its owner: it is written to a file of its
 * own first, then linked as the lock, which fails when a lock exists. A lock
 * that cannot be read stops the command: its owner cannot be checked.
 */
export async function withLock<T>(
  home: string,
  task: () => Promise<T>,
  {
    maxWaitMs = MAX_WAIT_MS,
    onWait,
    onLeftBehind,
  }: {
    maxWaitMs?: number
    /** Called once, when another process holds the lock: `who` names it. */
    onWait?: (who: string) => void
    /** Called when the lock cannot be removed at the end (the task's result stands). */
    onLeftBehind?: (lock: string, error: unknown) => void
  } = {},
): Promise<T> {
  const lock = path.join(configfilePaths(home).dir, 'lock')
  const unusable = (error: unknown) =>
    new CliError(`Cannot take the lock ${lock}: ${messageOf(error)}`, { cause: error })
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 }).catch(error => {
    throw unusable(error)
  })

  const started = Date.now()
  let waiting = false
  for (;;) {
    if (await createExclusive(lock).catch(error => Promise.reject(unusable(error)))) break

    const owner = await readOwner(lock).catch(error => Promise.reject(unusable(error)))
    if (owner === 'gone') continue
    if (owner != null && isLeftBehind(lock, owner)) {
      await takeOver(lock, owner).catch(error => Promise.reject(unusable(error)))
      continue
    }

    const who = owner == null ? 'another configfile' : `another configfile (process ${owner})`
    if (Date.now() - started > maxWaitMs) {
      throw new CliError(
        `${who[0]?.toUpperCase()}${who.slice(1)} is changing files. Try again when it is done, ` +
          `or delete ${lock} if no configfile is running.`,
      )
    }
    if (!waiting) {
      waiting = true
      onWait?.(who)
    }
    await sleep(RETRY_DELAY_MS)
  }

  held.add(lock)
  try {
    return await task()
  } finally {
    held.delete(lock)
    // Only remove our own lock. If it cannot be removed, the task's result
    // stands: said, and the next command takes over a lock whose owner is gone.
    try {
      if ((await readOwner(lock)) === process.pid) await rm(lock, { force: true })
    } catch (error) {
      onLeftBehind?.(lock, error)
    }
  }
}

/** `withLock` for a command: says so when it has to wait, or leaves the lock behind. */
export function withCommandLock<T>(
  ctx: Pick<Context, 'home' | 'output'>,
  task: () => Promise<T>,
): Promise<T> {
  return withLock(ctx.home, task, {
    onWait: who => ctx.output.info(`Waiting for ${who} to finish…`),
    onLeftBehind: (lock, error) =>
      ctx.output.warn(
        `${lock} could not be removed (${messageOf(error)}). ` +
          'Delete it if no configfile is running.',
      ),
  })
}

/**
 * Creates `file` holding this process's pid, unless it exists. It never
 * exists empty or half written: the pid is written to a file of its own,
 * which is then linked under the name `file` (this fails when it exists).
 */
async function createExclusive(file: string): Promise<boolean> {
  const draft = `${file}.${process.pid}.${randomUUID()}`
  await writeFile(draft, String(process.pid), { flag: 'wx', mode: 0o600 })
  try {
    await link(draft, file)
    return true
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return false
    throw error
  } finally {
    await rm(draft, { force: true }).catch(() => {})
  }
}

/**
 * The pid in a lock: `null` when it holds none (written by an older
 * configfile, or damaged), `gone` when the lock no longer exists. Any other
 * error is thrown: a lock that cannot be read is never taken over.
 */
async function readOwner(file: string): Promise<number | null | 'gone'> {
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'gone'
    throw error
  }
  const pid = Number.parseInt(content, 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Whether the lock was left behind: by a process that no longer exists, or by
 * this one, which does not hold it any more. A lock without pid is never: it
 * may be being written by an older configfile, which wrote it in two steps.
 */
function isLeftBehind(lock: string, owner: number): boolean {
  if (owner === process.pid) return !held.has(lock)
  return !isRunning(owner)
}

/**
 * Removes a lock left behind by `owner`. Only one process at a time does it,
 * holding `<lock>.takeover`: two of them could otherwise both see the old
 * lock, and one remove the lock the other has just taken.
 */
async function takeOver(lock: string, owner: number): Promise<void> {
  const guard = `${lock}.takeover`
  if (!(await createExclusive(guard))) {
    // Another process is taking it over, unless it died doing so.
    const other = await readOwner(guard)
    if (other !== 'gone' && other !== process.pid && (other == null || !isRunning(other))) {
      await rm(guard, { force: true })
    }
    return
  }
  try {
    // Checked again: another process may have taken it over meanwhile.
    if ((await readOwner(lock)) === owner) await rm(lock, { force: true })
  } finally {
    await rm(guard, { force: true }).catch(() => {})
  }
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errnoCode(error) === 'EPERM'
  }
}
