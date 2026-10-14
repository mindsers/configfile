import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Context } from './context.ts'
import { CliError } from './errors.ts'
import { errnoCode, messageOf } from './fsutil.ts'
import { configfilePaths } from './paths.ts'

const RETRY_DELAY_MS = 100
const MAX_WAIT_MS = 10_000
/** A lock still empty after this was left by a process that died before writing its pid. */
const EMPTY_LOCK_MS = 2_000

/**
 * Runs `task` while holding `~/.configfile/lock`, so that two configfile
 * processes never change the same files, the deployment record, the mirror of
 * the repository or the configuration at once. Waits a little for another
 * process to finish, and takes over the lock of a process that no longer
 * exists.
 */
export async function withLock<T>(
  home: string,
  task: () => Promise<T>,
  {
    maxWaitMs = MAX_WAIT_MS,
    onWait,
  }: {
    maxWaitMs?: number
    /** Called once, when another process holds the lock: `who` names it. */
    onWait?: (who: string) => void
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
    let created = false
    try {
      await using handle = await open(lock, 'wx', 0o600)
      created = true
      await handle.writeFile(String(process.pid))
      break
    } catch (error) {
      // A lock created but left without our pid would hold the others back.
      if (created) await rm(lock, { force: true }).catch(() => {})
      if (errnoCode(error) !== 'EEXIST') throw unusable(error)
    }

    const content = await readFile(lock, 'utf8').catch(() => '')
    const owner = Number.parseInt(content, 10)
    // An empty lock is being created by another process: wait for its pid,
    // unless it has been empty for too long.
    if (content === '' ? await isAbandoned(lock) : !isRunning(owner)) {
      // Re-read just before removing, so a lock another process has just taken is kept.
      if ((await readFile(lock, 'utf8').catch(() => '')) === content) {
        await rm(lock, { force: true })
      }
      continue
    }
    const who = Number.isNaN(owner) ? 'another configfile' : `another configfile (process ${owner})`
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

  try {
    return await task()
  } finally {
    // Only remove our own lock. If it cannot be removed, the task's result
    // stands: the next process takes over a lock whose process is gone.
    if ((await readFile(lock, 'utf8').catch(() => '')) === String(process.pid)) {
      await rm(lock, { force: true }).catch(() => {})
    }
  }
}

/** `withLock` for a command: says so when it has to wait for another configfile. */
export function withCommandLock<T>(
  ctx: Pick<Context, 'home' | 'output'>,
  task: () => Promise<T>,
): Promise<T> {
  return withLock(ctx.home, task, {
    onWait: who => ctx.output.info(`Waiting for ${who} to finish…`),
  })
}

/** Whether an empty lock was left by a process that died before writing its pid. */
async function isAbandoned(lock: string): Promise<boolean> {
  const stats = await stat(lock).catch(() => null)
  return stats != null && Date.now() - stats.mtimeMs > EMPTY_LOCK_MS
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
