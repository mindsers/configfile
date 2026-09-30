import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { deployFile, inspectFile, undeployFile } from '../src/deploy.js'
import { CliError } from '../src/errors.js'
import type { ModuleFile } from '../src/repository.js'
import { BackupRecord } from '../src/state.js'
import { createSandbox, type Sandbox } from './helpers.js'

const isRoot = process.getuid?.() === 0

async function setup() {
  const sandbox = await createSandbox()
  const source = await sandbox.write('home/dotfiles/files/zsh/zshrc', 'from repo')
  const target = path.join(sandbox.home, 'config', '.zshrc')
  const record = await BackupRecord.load(sandbox.home)

  const file = (strategy: 'global' | 'local', overrides: Partial<ModuleFile> = {}): ModuleFile => ({
    source,
    target,
    strategy,
    repository: sandbox.repo,
    module: path.join(sandbox.repo, 'files/zsh'),
    ...overrides,
  })

  return { sandbox, source, target, record, file }
}

async function folderModule(sandbox: Sandbox) {
  await sandbox.write('home/dotfiles/files/vim/colors/theme.vim', 'theme')
  await symlink('theme.vim', path.join(sandbox.repo, 'files/vim/colors/link.vim'))
  return {
    source: path.join(sandbox.repo, 'files/vim/colors'),
    target: path.join(sandbox.cwd, 'colors'),
    strategy: 'local',
    repository: sandbox.repo,
    module: path.join(sandbox.repo, 'files/vim'),
  } as const
}

describe('deployFile (global)', () => {
  it('creates a symlink and its parent folders', async () => {
    const { source, target, record, file } = await setup()

    await expect(deployFile(file('global'), { record })).resolves.toEqual({ status: 'deployed' })
    expect(await readlink(target)).toBe(source)
  })

  it('does nothing when the link is already in place', async () => {
    const { record, file } = await setup()
    await deployFile(file('global'), { record })

    await expect(deployFile(file('global'), { record })).resolves.toEqual({ status: 'up-to-date' })
  })

  it('backs up an existing file without overwriting a previous backup, and records it', async () => {
    const { sandbox, source, target, record, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await sandbox.write('home/config/.zshrc.old', 'older')

    await expect(deployFile(file('global'), { record })).resolves.toEqual({
      status: 'backed-up',
      backup: `${target}.old.1`,
    })
    expect(await readFile(`${target}.old`, 'utf8')).toBe('older')
    expect(await readFile(`${target}.old.1`, 'utf8')).toBe('mine')
    expect(await readlink(target)).toBe(source)
    await expect(record.latest(target)).resolves.toEqual({ path: `${target}.old.1`, exists: true })
  })

  it('backs up a symlink that points somewhere else', async () => {
    const { sandbox, target, record, file } = await setup()
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(path.join(sandbox.root, 'elsewhere'), target)

    const result = await deployFile(file('global'), { record })

    expect(result).toEqual({ status: 'backed-up', backup: `${target}.old` })
    expect((await lstat(`${target}.old`)).isSymbolicLink()).toBe(true)
  })

  it('backs up a folder in the way, with its content', async () => {
    const { sandbox, target, record, file } = await setup()
    await sandbox.write('home/config/.zshrc/inside', 'kept')

    await deployFile(file('global'), { record })

    expect(await readFile(path.join(`${target}.old`, 'inside'), 'utf8')).toBe('kept')
  })

  it('recognises a relative symlink to the source as up to date', async () => {
    const { source, target, record, file } = await setup()
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(path.relative(path.dirname(target), source), target)

    await expect(deployFile(file('global'), { record })).resolves.toEqual({ status: 'up-to-date' })
  })

  it('does not reuse a backup name taken by a broken symlink', async () => {
    const { sandbox, target, record, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await symlink(path.join(sandbox.root, 'nowhere'), `${target}.old`)

    const result = await deployFile(file('global'), { record })

    expect(result).toEqual({ status: 'backed-up', backup: `${target}.old.1` })
    expect(await readFile(`${target}.old.1`, 'utf8')).toBe('mine')
  })

  it('fails when the source does not exist', async () => {
    const { sandbox, record, file } = await setup()
    const source = path.join(sandbox.repo, 'missing')

    await expect(deployFile(file('global', { source }), { record })).rejects.toThrow(CliError)
  })

  it('refuses a target that leads into the repository through a symbolic link', async () => {
    const { sandbox, record, file } = await setup()
    // ~/.config/nvim is a link to a folder of the repository (deployed by another module).
    await mkdir(path.join(sandbox.repo, 'files/nvim/nvim'), { recursive: true })
    await mkdir(path.join(sandbox.home, '.config'), { recursive: true })
    await symlink(
      path.join(sandbox.repo, 'files/nvim/nvim'),
      path.join(sandbox.home, '.config/nvim'),
    )
    const target = path.join(sandbox.home, '.config/nvim/lua.vim')

    await expect(deployFile(file('global', { target }), { record })).rejects.toThrow(
      /leads into the dotfiles repository/,
    )
    expect(await readdir(path.join(sandbox.repo, 'files/nvim/nvim'))).toEqual([])
  })
})

describe('deployFile (local)', () => {
  it('copies the file', async () => {
    const { target, record, file } = await setup()

    await expect(deployFile(file('local'), { record })).resolves.toEqual({ status: 'deployed' })
    expect(await readFile(target, 'utf8')).toBe('from repo')
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
  })

  it('reports an identical copy as up to date', async () => {
    const { record, file } = await setup()
    await deployFile(file('local'), { record })

    await expect(deployFile(file('local'), { record })).resolves.toEqual({ status: 'up-to-date' })
  })

  it('reports a conflict instead of overwriting', async () => {
    const { sandbox, target, record, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')

    await expect(deployFile(file('local'), { record })).resolves.toEqual({ status: 'conflict' })
    expect(await readFile(target, 'utf8')).toBe('mine')
  })

  it('moves the existing target aside when forced', async () => {
    const { sandbox, target, record, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')

    await expect(deployFile(file('local'), { force: true, record })).resolves.toEqual({
      status: 'backed-up',
      backup: `${target}.old`,
    })
    expect(await readFile(target, 'utf8')).toBe('from repo')
    expect(await readFile(`${target}.old`, 'utf8')).toBe('mine')
  })

  it('replaces a folder instead of merging into it when forced', async () => {
    const { sandbox, record } = await setup()
    const colors = await folderModule(sandbox)
    await sandbox.write('cwd/colors/theme.vim', 'old')
    await sandbox.write('cwd/colors/stale.vim', 'stale')

    await deployFile(colors, { force: true, record })

    expect((await readdir(colors.target)).sort()).toEqual(['link.vim', 'theme.vim'])
    expect((await readdir(`${colors.target}.old`)).sort()).toEqual(['stale.vim', 'theme.vim'])
  })

  it('copies folders, keeping relative links as they are', async () => {
    const { sandbox, record } = await setup()
    const colors = await folderModule(sandbox)

    await deployFile(colors, { record })

    expect(await readFile(path.join(colors.target, 'theme.vim'), 'utf8')).toBe('theme')
    expect(await readlink(path.join(colors.target, 'link.vim'))).toBe('theme.vim')
    await expect(inspectFile(colors)).resolves.toEqual({ kind: 'deployed' })
  })

  it.skipIf(isRoot)(
    'removes a partial copy and puts the original back when the copy fails',
    async () => {
      const { sandbox, record } = await setup()
      await sandbox.write('home/dotfiles/files/secret/folder/unreadable', 'x')
      await chmod(path.join(sandbox.repo, 'files/secret/folder/unreadable'), 0o000)
      await sandbox.write('cwd/folder/mine', 'mine')
      const file = {
        source: path.join(sandbox.repo, 'files/secret/folder'),
        target: path.join(sandbox.cwd, 'folder'),
        strategy: 'local',
        repository: sandbox.repo,
        module: path.join(sandbox.repo, 'files/secret'),
      } as const

      await expect(deployFile(file, { force: true, record })).rejects.toThrow(CliError)

      expect(await readdir(file.target)).toEqual(['mine'])
      expect(await readdir(sandbox.cwd)).toEqual(['folder'])
      await expect(record.latest(file.target)).resolves.toBeNull()
    },
  )

  it.skipIf(isRoot)('removes a partial copy when nothing was there before', async () => {
    const { sandbox, record } = await setup()
    await sandbox.write('home/dotfiles/files/secret/folder/unreadable', 'x')
    await chmod(path.join(sandbox.repo, 'files/secret/folder/unreadable'), 0o000)
    const file = {
      source: path.join(sandbox.repo, 'files/secret/folder'),
      target: path.join(sandbox.cwd, 'folder'),
      strategy: 'local',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/secret'),
    } as const

    await expect(deployFile(file, { record })).rejects.toThrow(CliError)
    expect(await readdir(sandbox.cwd)).toEqual([])
  })
})

describe('inspectFile', () => {
  it('describes global targets', async () => {
    const { sandbox, record, file } = await setup()

    await expect(inspectFile(file('global'))).resolves.toEqual({ kind: 'missing' })
    await sandbox.write('home/config/.zshrc', 'mine')
    await expect(inspectFile(file('global'))).resolves.toEqual({ kind: 'occupied', what: 'file' })
    await deployFile(file('global'), { record })
    await expect(inspectFile(file('global'))).resolves.toEqual({ kind: 'deployed' })
  })

  it.each([
    ['a file was added', (target: string) => rmAndWrite(path.join(target, 'extra.vim'), 'extra')],
    [
      'a file was replaced by a link',
      async (target: string) => {
        await rm(path.join(target, 'theme.vim'))
        await symlink('link.vim', path.join(target, 'theme.vim'))
      },
    ],
    [
      'a link was changed',
      async (target: string) => {
        await rm(path.join(target, 'link.vim'))
        await symlink('elsewhere.vim', path.join(target, 'link.vim'))
      },
    ],
    ['a file was edited', (target: string) => rmAndWrite(path.join(target, 'theme.vim'), 'edited')],
  ])('detects a modified folder copy: %s', async (_, modify) => {
    const { sandbox, record } = await setup()
    const colors = await folderModule(sandbox)
    await deployFile(colors, { record })

    await modify(colors.target)

    await expect(inspectFile(colors)).resolves.toEqual({ kind: 'modified' })
    await expect(undeployFile(colors, { record })).resolves.toMatchObject({ status: 'kept' })
    expect(await readdir(colors.target)).not.toEqual([])
  })

  it('reports targets whose source disappeared from the repository', async () => {
    const { source, record, file } = await setup()
    await deployFile(file('global'), { record })
    await rm(source)

    await expect(inspectFile(file('global'))).resolves.toEqual({
      kind: 'source-missing',
      ours: true,
    })
    await expect(inspectFile(file('local'))).resolves.toEqual({
      kind: 'source-missing',
      ours: false,
    })
  })
})

describe('undeployFile', () => {
  it('removes the link and restores the backup configfile made', async () => {
    const { sandbox, target, record, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await deployFile(file('global'), { record })

    await expect(undeployFile(file('global'), { record })).resolves.toEqual({
      status: 'removed',
      restored: `${target}.old`,
      missingBackup: null,
    })
    expect(await readFile(target, 'utf8')).toBe('mine')
    await expect(record.latest(target)).resolves.toBeNull()
  })

  it('never restores a .old file configfile did not make', async () => {
    const { sandbox, target, record, file } = await setup()
    await sandbox.write('home/config/.zshrc.old', 'made by hand')
    await deployFile(file('global'), { record })

    await expect(undeployFile(file('global'), { record })).resolves.toEqual({
      status: 'removed',
      restored: null,
      missingBackup: null,
    })
    expect(await readFile(`${target}.old`, 'utf8')).toBe('made by hand')
    expect(await readdir(path.dirname(target))).toEqual(['.zshrc.old'])
  })

  it('reports a recorded backup that was deleted since', async () => {
    const { sandbox, target, record, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await deployFile(file('global'), { record })
    await rm(`${target}.old`)

    await expect(undeployFile(file('global'), { record })).resolves.toEqual({
      status: 'removed',
      restored: null,
      missingBackup: `${target}.old`,
    })
  })

  it('removes a linked folder without touching the folder in the repository', async () => {
    const { sandbox, record } = await setup()
    await sandbox.write('home/dotfiles/files/nvim/nvim/init.lua', 'init')
    const nvim = {
      source: path.join(sandbox.repo, 'files/nvim/nvim'),
      target: path.join(sandbox.home, '.config/nvim'),
      strategy: 'global',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/nvim'),
    } as const
    await deployFile(nvim, { record })

    await expect(undeployFile(nvim, { record })).resolves.toMatchObject({ status: 'removed' })
    await expect(lstat(nvim.target)).rejects.toThrow()
    expect(await readdir(nvim.source)).toEqual(['init.lua'])
  })

  it('keeps what configfile did not deploy, and modified copies', async () => {
    const { sandbox, target, record, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')

    await expect(undeployFile(file('global'), { record })).resolves.toMatchObject({
      status: 'kept',
    })
    await expect(undeployFile(file('local'), { record })).resolves.toMatchObject({ status: 'kept' })
    expect(await readFile(target, 'utf8')).toBe('mine')
  })

  it('removes an unmodified local copy and restores the forced backup', async () => {
    const { sandbox, target, record, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await deployFile(file('local'), { force: true, record })

    await expect(undeployFile(file('local'), { record })).resolves.toMatchObject({
      status: 'removed',
      restored: `${target}.old`,
    })
    expect(await readFile(target, 'utf8')).toBe('mine')
  })

  it('removes the link of a source that disappeared, but keeps a copy it cannot compare', async () => {
    const { source, target, record, file } = await setup()
    await deployFile(file('global'), { record })
    await rm(source)

    await expect(undeployFile(file('global'), { record })).resolves.toMatchObject({
      status: 'removed',
    })

    await rmAndWrite(target, 'a copy')
    await expect(undeployFile(file('local'), { record })).resolves.toEqual({
      status: 'kept',
      state: { kind: 'source-missing', ours: false },
    })
  })

  it('reports files that are not deployed', async () => {
    const { record, file } = await setup()

    await expect(undeployFile(file('global'), { record })).resolves.toEqual({
      status: 'not-deployed',
    })
  })
})

async function rmAndWrite(target: string, content: string) {
  await rm(target, { force: true })
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}
