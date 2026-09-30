import { lstat, mkdir, readdir, readFile, readlink, rename, symlink } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { deployFile, inspectFile, latestBackup, undeployFile } from '../src/deploy.js'
import { CliError } from '../src/errors.js'
import { createSandbox } from './helpers.js'

async function setup() {
  const sandbox = await createSandbox()
  const source = await sandbox.write('home/dotfiles/files/zsh/zshrc', 'from repo')
  const target = path.join(sandbox.home, 'config', '.zshrc')

  return { sandbox, source, target }
}

describe('deployFile (global)', () => {
  it('creates a symlink and its parent folders', async () => {
    const { source, target } = await setup()

    await expect(deployFile({ source, target, strategy: 'global' })).resolves.toEqual({
      status: 'deployed',
    })
    expect(await readlink(target)).toBe(source)
  })

  it('does nothing when the link is already in place', async () => {
    const { source, target } = await setup()
    await deployFile({ source, target, strategy: 'global' })

    await expect(deployFile({ source, target, strategy: 'global' })).resolves.toEqual({
      status: 'up-to-date',
    })
  })

  it('backs up an existing file without overwriting a previous backup', async () => {
    const { sandbox, source, target } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await sandbox.write('home/config/.zshrc.old', 'older')

    await expect(deployFile({ source, target, strategy: 'global' })).resolves.toEqual({
      status: 'backed-up',
      backup: `${target}.old.1`,
    })
    expect(await readFile(`${target}.old`, 'utf8')).toBe('older')
    expect(await readFile(`${target}.old.1`, 'utf8')).toBe('mine')
    expect(await readlink(target)).toBe(source)
  })

  it('backs up a symlink that points somewhere else', async () => {
    const { sandbox, source, target } = await setup()
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(path.join(sandbox.root, 'elsewhere'), target)

    const result = await deployFile({ source, target, strategy: 'global' })

    expect(result).toEqual({ status: 'backed-up', backup: `${target}.old` })
    expect((await lstat(`${target}.old`)).isSymbolicLink()).toBe(true)
  })

  it('recognises a relative symlink to the source as up to date', async () => {
    const { source, target } = await setup()
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(path.relative(path.dirname(target), source), target)

    await expect(deployFile({ source, target, strategy: 'global' })).resolves.toEqual({
      status: 'up-to-date',
    })
  })

  it('does not reuse a backup name taken by a broken symlink', async () => {
    const { sandbox, source, target } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await symlink(path.join(sandbox.root, 'nowhere'), `${target}.old`)

    const result = await deployFile({ source, target, strategy: 'global' })

    expect(result).toEqual({ status: 'backed-up', backup: `${target}.old.1` })
    expect(await readFile(`${target}.old.1`, 'utf8')).toBe('mine')
  })

  it('fails when the source does not exist', async () => {
    const { sandbox, target } = await setup()
    const source = path.join(sandbox.repo, 'missing')

    await expect(deployFile({ source, target, strategy: 'global' })).rejects.toThrow(CliError)
  })
})

describe('deployFile (local)', () => {
  it('copies the file', async () => {
    const { source, target } = await setup()

    await expect(deployFile({ source, target, strategy: 'local' })).resolves.toEqual({
      status: 'deployed',
    })
    expect(await readFile(target, 'utf8')).toBe('from repo')
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
  })

  it('reports a conflict instead of overwriting', async () => {
    const { sandbox, source, target } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')

    await expect(deployFile({ source, target, strategy: 'local' })).resolves.toEqual({
      status: 'conflict',
    })
    expect(await readFile(target, 'utf8')).toBe('mine')
  })

  it('moves the existing target aside when forced', async () => {
    const { sandbox, source, target } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')

    await expect(
      deployFile({ source, target, strategy: 'local' }, { force: true }),
    ).resolves.toEqual({
      status: 'backed-up',
      backup: `${target}.old`,
    })
    expect(await readFile(target, 'utf8')).toBe('from repo')
    expect(await readFile(`${target}.old`, 'utf8')).toBe('mine')
  })

  it('replaces a folder instead of merging into it when forced', async () => {
    const { sandbox } = await setup()
    await sandbox.write('home/dotfiles/files/vim/colors/theme.vim', 'new')
    await sandbox.write('cwd/colors/theme.vim', 'old')
    await sandbox.write('cwd/colors/stale.vim', 'stale')
    const source = path.join(sandbox.repo, 'files/vim/colors')
    const target = path.join(sandbox.cwd, 'colors')

    await deployFile({ source, target, strategy: 'local' }, { force: true })

    expect(await readdir(target)).toEqual(['theme.vim'])
    expect(await readFile(path.join(target, 'theme.vim'), 'utf8')).toBe('new')
    expect((await readdir(`${target}.old`)).sort()).toEqual(['stale.vim', 'theme.vim'])
  })

  it('copies folders recursively', async () => {
    const { sandbox } = await setup()
    await sandbox.write('home/dotfiles/files/vim/colors/theme.vim', 'colors')
    const source = path.join(sandbox.repo, 'files/vim/colors')
    const target = path.join(sandbox.cwd, 'colors')

    await deployFile({ source, target, strategy: 'local' })

    expect(await readFile(path.join(target, 'theme.vim'), 'utf8')).toBe('colors')
  })
})

describe('deployFile (local), unchanged copy', () => {
  it('reports an identical copy as up to date instead of a conflict', async () => {
    const { source, target } = await setup()
    const file = { source, target, strategy: 'local' } as const
    await deployFile(file)

    await expect(deployFile(file)).resolves.toEqual({ status: 'up-to-date' })
  })
})

describe('inspectFile', () => {
  it('describes global targets', async () => {
    const { sandbox, source, target } = await setup()
    const file = { source, target, strategy: 'global' } as const

    await expect(inspectFile(file)).resolves.toEqual({ kind: 'missing' })
    await sandbox.write('home/config/.zshrc', 'mine')
    await expect(inspectFile(file)).resolves.toEqual({ kind: 'occupied', what: 'file' })
    await deployFile(file)
    await expect(inspectFile(file)).resolves.toEqual({ kind: 'deployed' })
  })

  it('compares local copies, folders included', async () => {
    const { sandbox } = await setup()
    await sandbox.write('home/dotfiles/files/vim/colors/theme.vim', 'theme')
    const file = {
      source: path.join(sandbox.repo, 'files/vim/colors'),
      target: path.join(sandbox.cwd, 'colors'),
      strategy: 'local',
    } as const

    await deployFile(file)
    await expect(inspectFile(file)).resolves.toEqual({ kind: 'deployed' })

    await sandbox.write('cwd/colors/theme.vim', 'edited')
    await expect(inspectFile(file)).resolves.toEqual({ kind: 'modified' })
  })
})

describe('undeployFile', () => {
  it('removes the link and restores the most recent backup', async () => {
    const { sandbox, source, target } = await setup()
    const file = { source, target, strategy: 'global' } as const
    await sandbox.write('home/config/.zshrc.old', 'older')
    await sandbox.write('home/config/.zshrc', 'mine')
    await deployFile(file)

    await expect(undeployFile(file)).resolves.toEqual({
      status: 'removed',
      restored: `${target}.old.1`,
    })
    expect(await readFile(target, 'utf8')).toBe('mine')
    expect(await readFile(`${target}.old`, 'utf8')).toBe('older')
  })

  it('keeps what configfile did not deploy, and modified copies', async () => {
    const { sandbox, source, target } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')

    await expect(undeployFile({ source, target, strategy: 'global' })).resolves.toMatchObject({
      status: 'kept',
    })
    await expect(undeployFile({ source, target, strategy: 'local' })).resolves.toMatchObject({
      status: 'kept',
    })
    expect(await readFile(target, 'utf8')).toBe('mine')
  })

  it('removes an unmodified local copy', async () => {
    const { source, target } = await setup()
    const file = { source, target, strategy: 'local' } as const
    await deployFile(file)

    await expect(undeployFile(file)).resolves.toEqual({ status: 'removed', restored: null })
    await expect(inspectFile(file)).resolves.toEqual({ kind: 'missing' })
  })

  it('reports files that are not deployed', async () => {
    const { source, target } = await setup()

    await expect(undeployFile({ source, target, strategy: 'global' })).resolves.toEqual({
      status: 'not-deployed',
    })
  })
})

describe('latestBackup', () => {
  it('returns the backup made last, whatever its number', async () => {
    const { sandbox, target } = await setup()
    await expect(latestBackup(target)).resolves.toBeNull()

    await sandbox.write('home/config/.zshrc.old.2', 'b')
    await new Promise(resolve => setTimeout(resolve, 20))
    await sandbox.write('home/config/.zshrc.old.1', 'c')
    await rename(`${target}.old.1`, `${target}.old.3`)

    await expect(latestBackup(target)).resolves.toBe(`${target}.old.3`)
  })
})
