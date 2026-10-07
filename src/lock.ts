import { mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { CliError } from './errors.ts'
import { errnoCode } from './fsutil.ts'
import { configfilePaths } from './paths.ts'

const RETRY_DELAY_MS = 100
const MAX_WAIT_MS = 10_000

/**
 * Runs `task` while holding `~/.configfile/lock`, so that two configfile
 * processes never change the same files or the deployment record at once.
 * Waits a little for another process to finish, and takes over the lock of a
 * process that no longer exists.
 */
export async function withLock<T>(
  home: string,
  task: () => Promise<T>,
  { maxWaitMs = MAX_WAIT_MS }: { maxWaitMs?: number } = {},
): Promise<T> {
  const lock = path.join(configfilePaths(home).dir, 'lock')
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 })

  const started = Date.now()
  for (;;) {
    try {
      await using handle = await open(lock, 'wx', 0o600)
      await handle.writeFile(String(process.pid))
      break
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error
    }

    const content = await readFile(lock, 'utf8').catch(() => '')
    const owner = Number.parseInt(content, 10)
    // An empty lock is being created by another process: wait for its pid.
    if (content !== '' && !isRunning(owner)) {
      // Re-read just before removing, so a lock another process has just taken is kept.
      if ((await readFile(lock, 'utf8').catch(() => '')) === content) {
        await rm(lock, { force: true })
      }
      continue
    }
    if (Date.now() - started > maxWaitMs) {
      const who = Number.isNaN(owner)
        ? 'Another configfile'
        : `Another configfile (process ${owner})`
      throw new CliError(
        `${who} is changing files. Try again when it is done, ` +
          `or delete ${lock} if no configfile is running.`,
      )
    }
    await sleep(RETRY_DELAY_MS)
  }

  try {
    return await task()
  } finally {
    // Only remove our own lock.
    if ((await readFile(lock, 'utf8').catch(() => '')) === String(process.pid)) {
      await rm(lock, { force: true })
    }
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
