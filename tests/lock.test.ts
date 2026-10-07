import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

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
