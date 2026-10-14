// Where hard links are not supported (some network or FAT filesystems), the
// lock is created in two steps, as configfile 1.0 did.

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { withLock } from '../src/lock.ts'
import { createSandbox } from './helpers.ts'

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  link: async () => {
    throw Object.assign(new Error('operation not permitted, link'), { code: 'EPERM' })
  },
}))

describe('withLock without hard links', () => {
  it('still takes the lock, holding the pid of its owner, then releases it', async () => {
    const { home } = await createSandbox()
    const lock = path.join(home, '.configfile/lock')

    const seen = await withLock(home, () => readFile(lock, 'utf8'))

    expect(seen).toBe(String(process.pid))
    await expect(readFile(lock, 'utf8')).rejects.toThrow()
  })

  it('still waits for another process holding it', async () => {
    const { home, write } = await createSandbox()
    await write('home/.configfile/lock', String(process.ppid))

    await expect(withLock(home, async () => 'never', { maxWaitMs: 300 })).rejects.toThrow(
      `Another configfile (process ${process.ppid}) is changing files`,
    )
  })
})
