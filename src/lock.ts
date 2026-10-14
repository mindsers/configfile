import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
/** Calls of this process waiting for a lock, in order: one at a time, whatever the file says. */
const queues = new Map<string, Promise<void>>()

/**
 * Runs `task` while holding `~/.configfile/lock`, so that two configfile
 * processes never change the same files, the deployment record, the mirror of
 * the repository or the configuration at once. Waits a little for another
 * process to finish, and takes over the lock of a process that no longer
 * exists.
 *
 * The lock always holds the pid of its owner: it is written to a draft file
 * first, then linked as the lock, which fails when a lock exists. A lock that
 * cannot be read stops the command: its owner cannot be checked. Calls made
 * by the same process take their turn: the file cannot tell them apart.
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
    /**
     * Called when the lock cannot be released as it should at the end (the
     * task's result stands), with what to tell the user.
     */
    onLeftBehind?: (message: string) => void
  } = {},
): Promise<T> {
  const lock = path.join(configfilePaths(home).dir, 'lock')
  const previous = queues.get(lock) ?? Promise.resolve()
  let done = () => {}
  const turn = previous.then(() => new Promise<void>(resolve => (done = resolve)))
  queues.set(lock, turn)
  await previous
  try {
    await acquire(lock, maxWaitMs, onWait)
    held.add(lock)
    try {
      await sweepDrafts(lock)
      return await task()
    } finally {
      held.delete(lock)
      await release(lock, onLeftBehind)
    }
  } finally {
    done()
    if (queues.get(lock) === turn) queues.delete(lock)
  }
}

/** `withLock` for a command: says so when it has to wait, or when the lock is left behind. */
export function withCommandLock<T>(
  ctx: Pick<Context, 'home' | 'output'>,
  task: () => Promise<T>,
): Promise<T> {
  return withLock(ctx.home, task, {
    onWait: who => ctx.output.info(`Waiting for ${who} to finish…`),
    onLeftBehind: message => ctx.output.warn(message),
  })
}

async function acquire(
  lock: string,
  maxWaitMs: number,
  onWait: ((who: string) => void) | undefined,
): Promise<void> {
  const unusable = (error: unknown) =>
    new CliError(`Cannot take the lock ${lock}: ${messageOf(error)}`, { cause: error })
  const guarded = <V>(promise: Promise<V>) =>
    promise.catch(error => Promise.reject(unusable(error)))
  await guarded(mkdir(path.dirname(lock), { recursive: true, mode: 0o700 }))

  const started = Date.now()
  let waiting = false
  for (;;) {
    if (await guarded(createExclusive(lock))) return

    const owner = await guarded(readOwner(lock))
    if (owner === 'gone') continue
    let blocker = { file: lock, owner }
    if (owner != null && isLeftBehind(lock, owner)) {
      const taken = await guarded(takeOver(lock, owner))
      if (taken === 'removed') continue
      // Another process is taking it over: waited for like a lock.
      blocker = taken
    }

    const who =
      blocker.owner == null ? 'another configfile' : `another configfile (process ${blocker.owner})`
    if (Date.now() - started > maxWaitMs) {
      throw new CliError(
        `${who[0]?.toUpperCase()}${who.slice(1)} is changing files. Try again when it is done, ` +
          `or delete ${blocker.file} if no configfile is running.`,
      )
    }
    if (!waiting) {
      waiting = true
      onWait?.(who)
    }
    await sleep(RETRY_DELAY_MS)
  }
}

/**
 * Removes our own lock. Anything else is said, never thrown: the task's
 * result stands, and the next command takes over a lock whose owner is gone.
 */
async function release(
  lock: string,
  onLeftBehind: ((message: string) => void) | undefined,
): Promise<void> {
  try {
    const owner = await readOwner(lock)
    if (owner === process.pid) {
      await rm(lock, { force: true })
      return
    }
    onLeftBehind?.(
      owner === 'gone'
        ? `${lock} was removed while this configfile held it: another configfile may have changed files at the same time.`
        : `${lock} was replaced while this configfile held it: another configfile may have changed files at the same time. ` +
            `Delete ${lock} if no configfile is running.`,
    )
  } catch (error) {
    onLeftBehind?.(
      `${lock} could not be removed (${messageOf(error)}). Delete it if no configfile is running.`,
    )
  }
}

/**
 * Creates `file` holding this process's pid, unless it exists. It never
 * exists empty or half written: the pid is written to a draft file, which is
 * then linked under the name `file` (this fails when it exists). Where hard
 * links are not supported, `file` is created and written in two steps, as
 * configfile 1.0 did.
 */
async function createExclusive(file: string): Promise<boolean> {
  const draft = draftOf(file)
  await writeFile(draft, String(process.pid), { flag: 'wx', mode: 0o600 })
  try {
    await link(draft, file)
    return true
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'EEXIST') return false
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS') throw error
  } finally {
    await rm(draft, { force: true }).catch(() => {})
  }

  try {
    await using handle = await open(file, 'wx', 0o600)
    await handle.writeFile(String(process.pid))
    return true
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return false
    throw error
  }
}

/** A file name of its own, next to `file`: `<file>.<pid>.<random>`. */
function draftOf(file: string): string {
  return `${file}.${process.pid}.${randomUUID()}`
}

/**
 * Removes the drafts of processes that no longer exist (killed between
 * writing a draft and removing it). Called with the lock held; never fails.
 */
async function sweepDrafts(lock: string): Promise<void> {
  const folder = path.dirname(lock)
  const pattern = new RegExp(
    `^${path.basename(lock).replace('.', '\\.')}(?:\\.takeover)?\\.(\\d+)\\.[0-9a-f-]{36}$`,
  )
  const names = await readdir(folder).catch(() => [])
  for (const name of names) {
    const pid = Number(pattern.exec(name)?.[1])
    if (Number.isInteger(pid) && pid !== process.pid && !isRunning(pid)) {
      await rm(path.join(folder, name), { force: true }).catch(() => {})
    }
  }
}

/**
 * The pid in a lock: `null` when it holds none (being written by configfile
 * 1.0, or damaged), `gone` when the lock no longer exists. Any other error is
 * thrown: a lock that cannot be read is never taken over.
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
 * this one, which does not hold it (its calls take their turn, so none is
 * holding it while this one asks). A lock without pid is never: configfile
 * 1.0 may be writing it, as it created the lock empty and wrote its pid after.
 */
function isLeftBehind(lock: string, owner: number): boolean {
  if (owner === process.pid) return !held.has(lock)
  return !isRunning(owner)
}

/**
 * Removes a lock left behind by `owner`. Only one process at a time does it,
 * holding `<lock>.takeover`: two of them could otherwise both see the old
 * lock, and one remove the lock the other has just taken. Returns `removed`
 * once done (by this process or another), or the guard file and its owner
 * when another process is taking it over.
 *
 * A guard left by a process that no longer exists is moved aside, then
 * checked: one moved by mistake (a new one, created meanwhile) is put back.
 * That leaves one rare case, a guard left behind and found by several
 * processes at the very same moment, where two of them may take over at once.
 */
async function takeOver(
  lock: string,
  owner: number,
): Promise<'removed' | { file: string; owner: number | null }> {
  const guard = `${lock}.takeover`
  if (!(await createExclusive(guard))) {
    const other = await readOwner(guard)
    if (other === 'gone') return 'removed'
    // Our own guard can only have been left behind: this process takes its turn.
    if (other != null && other !== process.pid && isRunning(other)) {
      return { file: guard, owner: other }
    }
    await removeStale(guard, other)
    return 'removed'
  }
  try {
    // Checked again: another process may have taken it over meanwhile.
    if ((await readOwner(lock)) === owner) await rm(lock, { force: true })
  } finally {
    await rm(guard, { force: true }).catch(() => {})
  }
  return 'removed'
}

/** Removes `file` if it still names `owner`; puts it back otherwise. */
async function removeStale(file: string, owner: number | null): Promise<void> {
  const aside = draftOf(file)
  try {
    await rename(file, aside)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return
    throw error
  }
  try {
    if ((await readOwner(aside)) !== owner) await link(aside, file).catch(() => {})
  } finally {
    await rm(aside, { force: true }).catch(() => {})
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
