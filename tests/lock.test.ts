import { spawn } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CliError } from '../src/errors.ts'
import { withLock } from '../src/lock.ts'
import { createSandbox } from './helpers.ts'

/** The pid of a process that has ended. */
async function deadPid(): Promise<number> {
  const dead = spawn(process.execPath, ['-e', ''])
  await new Promise(resolve => dead.on('exit', resolve))
  return dead.pid as number
}

/** A process that keeps running until it is killed (at the end of the test at the latest). */
const living: ReturnType<typeof spawn>[] = []
function livingPid(): number {
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
  living.push(other)
  return other.pid as number
}
afterEach(() => {
  for (const other of living.splice(0)) other.kill()
})

describe('withLock', () => {
  it('runs the task while holding ~/.configfile/lock, then releases it', async () => {
    const { home } = await createSandbox()
    const lock = path.join(home, '.configfile/lock')

    const seen = await withLock(home, () => readFile(lock, 'utf8'))

    expect(seen).toBe(String(process.pid))
    await expect(readFile(lock, 'utf8')).rejects.toThrow()
  })

  it('releases the lock when the task fails', async () => {
    const { home } = await createSandbox()

    await expect(withLock(home, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(withLock(home, async () => 'again')).resolves.toBe('again')
  })

  it('says why when its folder cannot be created', async () => {
    const { home, write } = await createSandbox()
    await write('home/.configfile', 'not a folder')

    const result = withLock(home, async () => 'done')

    await expect(result).rejects.toThrow(CliError)
    await expect(result).rejects.toThrow(/^Cannot take the lock .*\.configfile\/lock: /)
  })

  // root writes to a folder whatever its permissions.
  it.skipIf(process.getuid?.() === 0)('says why when the lock cannot be written', async () => {
    const { home } = await createSandbox()
    const folder = path.join(home, '.configfile')
    await mkdir(folder, { mode: 0o555 })

    try {
      const result = withLock(home, async () => 'done')

      await expect(result).rejects.toThrow(CliError)
      await expect(result).rejects.toThrow(/^Cannot take the lock .*: EACCES/)
    } finally {
      await chmod(folder, 0o755)
    }
  })

  it('never takes over a lock without pid, which an older configfile may be writing', async () => {
    const { home, write } = await createSandbox()
    const lock = await write('home/.configfile/lock', '')
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)

    await expect(withLock(home, async () => 'never', { maxWaitMs: 300 })).rejects.toThrow(
      'Another configfile is changing files',
    )
    expect(await readFile(lock, 'utf8')).toBe('')
  })

  it('leaves only the lock in its folder, holding the pid of its owner', async () => {
    const { home } = await createSandbox()
    const folder = path.join(home, '.configfile')

    const seen = await withLock(home, async () => ({
      files: await readdir(folder),
      lock: await readFile(path.join(folder, 'lock'), 'utf8'),
    }))

    expect(seen).toEqual({ files: ['lock'], lock: String(process.pid) })
    expect(await readdir(folder)).toEqual([])
  })

  // root reads any file whatever its permissions.
  it.skipIf(process.getuid?.() === 0)(
    'never takes over a lock it cannot read: its owner cannot be checked',
    async () => {
      const { home, write } = await createSandbox()
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
      const lock = await write('home/.configfile/lock', String(other.pid), 0o000)
      try {
        await expect(withLock(home, async () => 'never', { maxWaitMs: 300 })).rejects.toThrow(
          /^Cannot take the lock .*: EACCES/,
        )
        await chmod(lock, 0o600)
        expect(await readFile(lock, 'utf8')).toBe(String(other.pid))
      } finally {
        other.kill()
      }
    },
  )

  // root removes files from a folder whatever its permissions.
  it.skipIf(process.getuid?.() === 0)(
    'keeps the result of the task when the lock cannot be removed',
    async () => {
      const { home } = await createSandbox()
      const folder = path.join(home, '.configfile')

      const left: string[] = []
      try {
        const result = await withLock(
          home,
          async () => {
            await chmod(folder, 0o555)
            return 'done'
          },
          { onLeftBehind: message => left.push(message) },
        )

        expect(result).toBe('done')
        expect(left).toEqual([
          expect.stringMatching(
            /^.*\.configfile\/lock could not be removed \(.*EACCES.*\)\. Delete it if no configfile is running\.$/,
          ),
        ])
      } finally {
        await chmod(folder, 0o755)
      }
      // The lock left behind names this process, which no longer holds it: taken over at once.
      expect(await readFile(path.join(folder, 'lock'), 'utf8')).toBe(String(process.pid))
      await expect(withLock(home, async () => 'again', { maxWaitMs: 300 })).resolves.toBe('again')
    },
  )

  it('takes over the lock of a process that no longer exists', async () => {
    const { home, write } = await createSandbox()
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise(resolve => dead.on('exit', resolve))
    await write('home/.configfile/lock', String(dead.pid))

    await expect(withLock(home, async () => 'done')).resolves.toBe('done')
  })

  it('fails, naming the process, when another configfile keeps the lock', async () => {
    const { home, write } = await createSandbox()
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
    try {
      await write('home/.configfile/lock', String(other.pid))

      await expect(withLock(home, async () => 'never', { maxWaitMs: 300 })).rejects.toThrow(
        `Another configfile (process ${other.pid}) is changing files`,
      )
      expect(await readFile(path.join(home, '.configfile/lock'), 'utf8')).toBe(String(other.pid))
    } finally {
      other.kill()
    }
  })

  it('says once that it waits, naming the process', async () => {
    const { home, write } = await createSandbox()
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
    const waits: string[] = []
    try {
      await write('home/.configfile/lock', String(other.pid))
      setTimeout(() => other.kill(), 400)

      await withLock(home, async () => 'done', { onWait: who => waits.push(who) })
    } finally {
      other.kill()
    }

    expect(waits).toEqual([`another configfile (process ${other.pid})`])
  })

  /**
   * Runs `count` processes that each take the lock for a moment, and returns
   * what they logged: `+` when one starts its task, `-` when it ends.
   */
  async function race(home: string, count: number): Promise<string> {
    const log = path.join(home, 'log')
    const go = path.join(home, 'go')
    const ready = path.join(home, 'ready')
    await mkdir(ready)
    // Every process says it is ready, then waits for the same signal, so they
    // all find the lock at once.
    const script =
      `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'\n` +
      `import { withLock } from ${JSON.stringify(new URL('../src/lock.ts', import.meta.url).href)}\n` +
      `writeFileSync(${JSON.stringify(ready)} + '/' + process.pid, '')\n` +
      `const until = Date.now() + 20000\n` +
      `while (!existsSync(${JSON.stringify(go)}) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 1))\n` +
      `await withLock(${JSON.stringify(home)}, async () => {\n` +
      `  appendFileSync(${JSON.stringify(log)}, '+')\n` +
      `  await new Promise(resolve => setTimeout(resolve, 50))\n` +
      `  appendFileSync(${JSON.stringify(log)}, '-')\n` +
      `}, { maxWaitMs: 20000 })\n`
    const runs = Array.from({ length: count }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script])
      let stderr = ''
      child.stderr.on('data', chunk => {
        stderr += chunk
      })
      return new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', code =>
          code === 0 ? resolve(code) : reject(new Error(`exit ${code}: ${stderr}`)),
        )
      })
    })
    // Once they have all started.
    const until = Date.now() + 20_000
    while ((await readdir(ready)).length < count && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await writeFile(go, '')
    await Promise.all(runs)
    await rm(ready, { recursive: true })
    return readFile(log, 'utf8')
  }

  it('never lets two processes hold the lock, also when they take over the same one', {
    timeout: 30_000,
  }, async () => {
    const { home, write } = await createSandbox()
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise(resolve => dead.on('exit', resolve))
    // Every process finds the lock of a process that no longer exists.
    await write('home/.configfile/lock', String(dead.pid))

    const log = await race(home, 8)

    expect(log).toBe('+-'.repeat(8))
    // No lock and no draft left behind.
    expect(await readdir(path.join(home, '.configfile'))).toEqual([])
  })

  it('never lets two processes hold the lock when the takeover guard was left behind', {
    timeout: 30_000,
  }, async () => {
    const { home, write } = await createSandbox()
    const dead = await deadPid()
    await write('home/.configfile/lock', String(dead))
    await write('home/.configfile/lock.takeover', String(dead))

    const log = await race(home, 8)

    expect(log).toBe('+-'.repeat(8))
    expect(await readdir(path.join(home, '.configfile'))).toEqual([])
  })

  it('waits for another process taking over the lock, and gives up in time', async () => {
    const { home, write } = await createSandbox()
    const other = livingPid()
    await write('home/.configfile/lock', String(await deadPid()))
    const guard = await write('home/.configfile/lock.takeover', String(other))

    const started = Date.now()
    await expect(withLock(home, async () => 'never', { maxWaitMs: 300 })).rejects.toThrow(
      `Another configfile (process ${other}) is changing files. Try again when it is done, or delete ${guard} if no configfile is running.`,
    )
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await readFile(guard, 'utf8')).toBe(String(other))
  })

  it('takes over a takeover guard left behind, by another process or by this one', async () => {
    for (const owner of [await deadPid(), process.pid]) {
      const { home, write } = await createSandbox()
      await write('home/.configfile/lock', String(await deadPid()))
      await write('home/.configfile/lock.takeover', String(owner))

      await expect(withLock(home, async () => 'done', { maxWaitMs: 300 })).resolves.toBe('done')
      expect(await readdir(path.join(home, '.configfile'))).toEqual([])
    }
  })

  it('removes a takeover guard left behind by a process still running, once it holds the lock', async () => {
    // Put back by a process that had moved it aside, after its owner was done.
    const { home, write } = await createSandbox()
    await write('home/.configfile/lock.takeover', String(livingPid()))

    let during: string[] = []
    await withLock(home, async () => {
      during = await readdir(path.join(home, '.configfile'))
    })

    expect(during).toEqual(['lock'])
    expect(await readdir(path.join(home, '.configfile'))).toEqual([])
  })

  it('never removes a lock it does not hold any more, and says so', async () => {
    const { home } = await createSandbox()
    const lock = path.join(home, '.configfile/lock')
    const other = livingPid()
    const said: string[] = []

    await withLock(home, async () => writeFile(lock, String(other)), {
      onLeftBehind: message => said.push(message),
    })
    // Left as it is: it names another process, still running.
    expect(await readFile(lock, 'utf8')).toBe(String(other))
    await rm(lock)
    await withLock(home, async () => rm(lock), { onLeftBehind: message => said.push(message) })

    expect(said).toEqual([
      `${lock} was replaced while this configfile held it: another configfile may have changed files at the same time. Delete ${lock} if no configfile is running.`,
      `${lock} was removed while this configfile held it: another configfile may have changed files at the same time.`,
    ])
  })

  // 600 calls: allow for slow, busy CI machines.
  it('never runs two tasks of the same process at once', { timeout: 30_000 }, async () => {
    const { home } = await createSandbox()
    let running = 0
    let overlaps = 0

    // Thirty callers, each taking the lock twenty times in a row.
    await Promise.all(
      Array.from({ length: 30 }, async () => {
        for (let call = 0; call < 20; call++) {
          await withLock(home, async () => {
            running++
            if (running > 1) overlaps++
            await new Promise(resolve => setTimeout(resolve, 1))
            running--
          })
        }
      }),
    )

    expect(overlaps).toBe(0)
  })

  it('removes the drafts left by processes that no longer exist', async () => {
    const { home, write } = await createSandbox()
    const uuid = '0f0e0d0c-0b0a-4908-8706-050403020100'
    await write(`home/.configfile/lock.${await deadPid()}.${uuid}`, '1')
    await write(`home/.configfile/lock.takeover.${await deadPid()}.${uuid}`, '1')
    const living = `lock.${livingPid()}.${uuid}`
    await write(`home/.configfile/${living}`, '1')

    await withLock(home, async () => 'done')

    expect(await readdir(path.join(home, '.configfile'))).toEqual([living])
  })

  it('serializes tasks', async () => {
    const { home } = await createSandbox()
    const events: string[] = []
    const task = (name: string) => async () => {
      events.push(`${name} start`)
      await new Promise(resolve => setTimeout(resolve, 50))
      events.push(`${name} end`)
    }

    await Promise.all([withLock(home, task('a')), withLock(home, task('b'))])

    // Whichever runs first, the two tasks never overlap.
    expect([
      ['a start', 'a end', 'b start', 'b end'],
      ['b start', 'b end', 'a start', 'a end'],
    ]).toContainEqual(events)
  })
})
