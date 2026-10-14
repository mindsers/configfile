import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, utimes } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CliError } from '../src/errors.ts'
import { withLock } from '../src/lock.ts'
import { createSandbox } from './helpers.ts'

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

  it('takes over a lock left empty by a process that died before writing its pid', async () => {
    const { home, write } = await createSandbox()
    const lock = await write('home/.configfile/lock', '')
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)

    await expect(withLock(home, async () => 'done', { maxWaitMs: 300 })).resolves.toBe('done')
  })

  it('waits for a lock that is being created', async () => {
    const { home, write } = await createSandbox()
    await write('home/.configfile/lock', '')

    await expect(withLock(home, async () => 'never', { maxWaitMs: 300 })).rejects.toThrow(
      'Another configfile is changing files',
    )
  })

  // root removes files from a folder whatever its permissions.
  it.skipIf(process.getuid?.() === 0)(
    'keeps the result of the task when the lock cannot be removed',
    async () => {
      const { home } = await createSandbox()
      const folder = path.join(home, '.configfile')

      try {
        const result = await withLock(home, async () => {
          await chmod(folder, 0o555)
          return 'done'
        })

        expect(result).toBe('done')
      } finally {
        await chmod(folder, 0o755)
      }
      // The lock left behind names a process that is still running: this one.
      expect(await readFile(path.join(folder, 'lock'), 'utf8')).toBe(String(process.pid))
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
