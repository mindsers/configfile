import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  type DeployContext,
  deployFile,
  Guard,
  inspectFile,
  planDeploy,
  undeployFile,
} from '../src/deploy.js'
import { CliError } from '../src/errors.js'
import type { ModuleFile } from '../src/repository.js'
import { DeploymentRecord } from '../src/state.js'
import { createSandbox, type Sandbox } from './helpers.js'

const isRoot = process.getuid?.() === 0

async function contextOf(sandbox: Sandbox): Promise<DeployContext> {
  return {
    record: await DeploymentRecord.load(sandbox.home),
    guard: new Guard({ home: sandbox.home, cwd: sandbox.cwd }),
  }
}

async function setup() {
  const sandbox = await createSandbox()
  const source = await sandbox.write('home/dotfiles/files/zsh/zshrc', 'from repo')
  const target = path.join(sandbox.home, 'config', '.zshrc')
  const context = await contextOf(sandbox)

  const file = (strategy: 'global' | 'local', overrides: Partial<ModuleFile> = {}): ModuleFile => ({
    source,
    target,
    strategy,
    repository: sandbox.repo,
    module: path.join(sandbox.repo, 'files/zsh'),
    ...overrides,
  })

  return { sandbox, source, target, context, file }
}

/** A local module copying the folder `files/vim/colors` (with a relative link) to `cwd/colors`. */
async function folderModule(sandbox: Sandbox): Promise<ModuleFile> {
  await sandbox.write('home/dotfiles/files/vim/colors/theme.vim', 'theme')
  await symlink('theme.vim', path.join(sandbox.repo, 'files/vim/colors/link.vim'))
  return {
    source: path.join(sandbox.repo, 'files/vim/colors'),
    target: path.join(sandbox.cwd, 'colors'),
    strategy: 'local',
    repository: sandbox.repo,
    module: path.join(sandbox.repo, 'files/vim'),
  }
}

const backupsOf = async (context: DeployContext, target: string) =>
  ((await context.record.find(target))?.backups ?? []).map(backup => backup.path)

describe('deployFile (global)', () => {
  it('creates a symlink and its parent folders, and records it', async () => {
    const { source, target, context, file } = await setup()

    await expect(deployFile(file('global'), context)).resolves.toEqual({ status: 'deployed' })
    expect(await readlink(target)).toBe(source)
    expect((await context.record.find(target))?.deployed).toMatchObject({
      strategy: 'global',
      source,
    })
  })

  it('does nothing when the link is already in place', async () => {
    const { context, file } = await setup()
    await deployFile(file('global'), context)

    await expect(deployFile(file('global'), context)).resolves.toEqual({ status: 'up-to-date' })
  })

  it('adopts a link made by configfile 0.3 (not recorded)', async () => {
    const { source, target, context, file } = await setup()
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(source, target)

    await expect(inspectFile(file('global'), context.record)).resolves.toEqual({
      kind: 'deployed',
      recorded: false,
    })
    await expect(deployFile(file('global'), context)).resolves.toEqual({ status: 'up-to-date' })
    await expect(inspectFile(file('global'), context.record)).resolves.toEqual({
      kind: 'deployed',
      recorded: true,
    })
  })

  it('backs up an existing file without overwriting a previous backup, and records it', async () => {
    const { sandbox, source, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await sandbox.write('home/config/.zshrc.old', 'older')

    await expect(deployFile(file('global'), context)).resolves.toEqual({
      status: 'backed-up',
      backup: `${target}.old.1`,
    })
    expect(await readFile(`${target}.old`, 'utf8')).toBe('older')
    expect(await readFile(`${target}.old.1`, 'utf8')).toBe('mine')
    expect(await readlink(target)).toBe(source)
    expect(await backupsOf(context, target)).toEqual([`${target}.old.1`])
  })

  it('backs up a symlink that points somewhere else', async () => {
    const { sandbox, target, context, file } = await setup()
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(path.join(sandbox.root, 'elsewhere'), target)

    const result = await deployFile(file('global'), context)

    expect(result).toEqual({ status: 'backed-up', backup: `${target}.old` })
    expect((await lstat(`${target}.old`)).isSymbolicLink()).toBe(true)
  })

  it('backs up a folder in the way, with its content', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc/inside', 'kept')

    await deployFile(file('global'), context)

    expect(await readFile(path.join(`${target}.old`, 'inside'), 'utf8')).toBe('kept')
  })

  it('recognises a relative symlink to the source as up to date', async () => {
    const { source, target, context, file } = await setup()
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(path.relative(path.dirname(target), source), target)

    await expect(deployFile(file('global'), context)).resolves.toEqual({ status: 'up-to-date' })
  })

  it('does not reuse a backup name taken by a broken symlink', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await symlink(path.join(sandbox.root, 'nowhere'), `${target}.old`)

    const result = await deployFile(file('global'), context)

    expect(result).toEqual({ status: 'backed-up', backup: `${target}.old.1` })
    expect(await readFile(`${target}.old.1`, 'utf8')).toBe('mine')
  })

  it('replaces its own link to an old location of the repository without a backup', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await deployFile(file('global'), context)
    // The repository moved: the recorded link now points to a path that no longer exists.
    const moved = path.join(sandbox.home, 'moved-dotfiles')
    await rename(sandbox.repo, moved)
    const movedFile = file('global', {
      source: path.join(moved, 'files/zsh/zshrc'),
      repository: moved,
      module: path.join(moved, 'files/zsh'),
    })

    await expect(inspectFile(movedFile, context.record)).resolves.toEqual({ kind: 'stale' })
    await expect(deployFile(movedFile, context)).resolves.toEqual({ status: 'deployed' })
    expect(await readlink(target)).toBe(path.join(moved, 'files/zsh/zshrc'))
    expect(await backupsOf(context, target)).toEqual([`${target}.old`])
  })

  it('fails when the source does not exist', async () => {
    const { sandbox, context, file } = await setup()
    const source = path.join(sandbox.repo, 'files/zsh/missing')

    await expect(deployFile(file('global', { source }), context)).rejects.toThrow(CliError)
  })

  it('refuses a source that leads outside the module through a symbolic link', async () => {
    const { sandbox, context, file } = await setup()
    await sandbox.write('home/.ssh/id_rsa', 'PRIVATE KEY')
    const source = path.join(sandbox.repo, 'files/zsh/key')
    await symlink(path.join(sandbox.home, '.ssh/id_rsa'), source)

    await expect(deployFile(file('global', { source }), context)).rejects.toThrow(
      /leads outside the module folder/,
    )
  })

  it('refuses a target that leads into the repository through a symbolic link', async () => {
    const { sandbox, context, file } = await setup()
    await mkdir(path.join(sandbox.repo, 'files/nvim/nvim'), { recursive: true })
    await mkdir(path.join(sandbox.home, '.config'), { recursive: true })
    await symlink(
      path.join(sandbox.repo, 'files/nvim/nvim'),
      path.join(sandbox.home, '.config/nvim'),
    )
    const target = path.join(sandbox.home, '.config/nvim/lua.vim')

    await expect(deployFile(file('global', { target }), context)).rejects.toThrow(
      /inside the dotfiles repository/,
    )
    await expect(
      planDeploy(file('global', { target }), { ...context, force: false }),
    ).rejects.toThrow(/inside the dotfiles repository/)
    expect(await readdir(path.join(sandbox.repo, 'files/nvim/nvim'))).toEqual([])
  })

  it('refuses a target that really is the repository, whatever the path used', async () => {
    const { sandbox, context, file } = await setup()
    // <root>/link leads to the home folder, so <root>/link/dotfiles is the repository itself.
    await symlink(sandbox.home, path.join(sandbox.root, 'link'))
    const target = path.join(sandbox.root, 'link', 'dotfiles')

    await expect(deployFile(file('global', { target }), context)).rejects.toThrow(
      /dotfiles repository/,
    )
    expect((await lstat(sandbox.repo)).isDirectory()).toBe(true)
  })

  it('refuses a target whose letter case differs from the repository (case-insensitive disks)', async () => {
    const { sandbox, context, file } = await setup()
    const upper = path.join(sandbox.home, 'DOTFILES')
    const caseInsensitive = (await lstat(upper).catch(() => null)) != null
    if (!caseInsensitive) return

    await expect(deployFile(file('global', { target: upper }), context)).rejects.toThrow(
      /would replace the dotfiles repository/,
    )
  })

  it('refuses a target that is the real location of a symlinked module', async () => {
    const { sandbox, context } = await setup()
    await sandbox.write('home/.config/nvim/init.lua', 'lua')
    await symlink(path.join(sandbox.home, '.config/nvim'), path.join(sandbox.repo, 'files/nvim'))
    const file: ModuleFile = {
      source: path.join(sandbox.repo, 'files/nvim/init.lua'),
      target: path.join(sandbox.home, '.config'),
      strategy: 'global',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/nvim'),
    }

    await expect(deployFile(file, context)).rejects.toThrow(/would replace the module folder/)
    expect(await readFile(path.join(sandbox.home, '.config/nvim/init.lua'), 'utf8')).toBe('lua')
  })

  it("refuses configfile's own files", async () => {
    const { sandbox, context, file } = await setup()
    await sandbox.write('home/.configfilerc', '{}')
    await mkdir(path.join(sandbox.home, '.configfile'), { recursive: true })

    for (const target of [
      path.join(sandbox.home, '.configfilerc'),
      path.join(sandbox.home, '.configfile'),
      path.join(sandbox.home, '.configfile/state.json'),
    ]) {
      await expect(deployFile(file('global', { target }), context)).rejects.toThrow(/configfile's/)
    }
  })
})

describe('deployFile (local)', () => {
  it('copies the file', async () => {
    const { target, context, file } = await setup()

    await expect(deployFile(file('local'), context)).resolves.toEqual({ status: 'deployed' })
    expect(await readFile(target, 'utf8')).toBe('from repo')
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
  })

  it('reports an identical copy as up to date', async () => {
    const { context, file } = await setup()
    await deployFile(file('local'), context)

    await expect(deployFile(file('local'), context)).resolves.toEqual({ status: 'up-to-date' })
  })

  it('reports a conflict instead of overwriting', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')

    await expect(deployFile(file('local'), context)).resolves.toEqual({ status: 'conflict' })
    expect(await readFile(target, 'utf8')).toBe('mine')
  })

  it('moves the existing target aside when forced', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')

    await expect(deployFile(file('local'), { ...context, force: true })).resolves.toEqual({
      status: 'backed-up',
      backup: `${target}.old`,
    })
    expect(await readFile(target, 'utf8')).toBe('from repo')
    expect(await readFile(`${target}.old`, 'utf8')).toBe('mine')
  })

  it('replaces a folder instead of merging into it when forced', async () => {
    const { sandbox, context } = await setup()
    const colors = await folderModule(sandbox)
    await sandbox.write('cwd/colors/theme.vim', 'old')
    await sandbox.write('cwd/colors/stale.vim', 'stale')

    await deployFile(colors, { ...context, force: true })

    expect((await readdir(colors.target)).sort()).toEqual(['link.vim', 'theme.vim'])
    expect((await readdir(`${colors.target}.old`)).sort()).toEqual(['stale.vim', 'theme.vim'])
  })

  it('makes real copies: links in the source are followed', async () => {
    const { sandbox, context } = await setup()
    const colors = await folderModule(sandbox)

    await deployFile(colors, context)

    const copiedLink = path.join(colors.target, 'link.vim')
    expect((await lstat(copiedLink)).isSymbolicLink()).toBe(false)
    expect(await readFile(copiedLink, 'utf8')).toBe('theme')
    await expect(inspectFile(colors, context.record)).resolves.toEqual({
      kind: 'deployed',
      recorded: true,
    })
  })

  it('copies the file a symlinked source points to, never a link into the repository', async () => {
    const { sandbox, context, file } = await setup()
    await sandbox.write('home/dotfiles/files/zsh/shared/cfg', 'shared')
    const source = path.join(sandbox.repo, 'files/zsh/abs')
    await symlink(path.join(sandbox.repo, 'files/zsh/shared/cfg'), source)
    const target = path.join(sandbox.cwd, 'abs')

    await deployFile(file('local', { source, target }), context)

    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    await writeFile(target, 'edited')
    expect(await readFile(path.join(sandbox.repo, 'files/zsh/shared/cfg'), 'utf8')).toBe('shared')
  })

  it('refuses to copy a folder containing a link that leads outside the module', async () => {
    const { sandbox, context } = await setup()
    const colors = await folderModule(sandbox)
    await sandbox.write('home/.ssh/id_rsa', 'PRIVATE KEY')
    await symlink(path.join(sandbox.home, '.ssh'), path.join(colors.source, 'ssh'))

    await expect(deployFile(colors, context)).rejects.toThrow(/leads outside the module folder/)
    await expect(lstat(colors.target)).rejects.toThrow()
  })

  it.skipIf(isRoot)(
    'puts the original back when the copy fails, leaving nothing half-copied',
    async () => {
      const { sandbox, context } = await setup()
      await sandbox.write('home/dotfiles/files/secret/folder/unreadable', 'x')
      await chmod(path.join(sandbox.repo, 'files/secret/folder/unreadable'), 0o000)
      await sandbox.write('cwd/folder/mine', 'mine')
      const file: ModuleFile = {
        source: path.join(sandbox.repo, 'files/secret/folder'),
        target: path.join(sandbox.cwd, 'folder'),
        strategy: 'local',
        repository: sandbox.repo,
        module: path.join(sandbox.repo, 'files/secret'),
      }

      await expect(deployFile(file, { ...context, force: true })).rejects.toThrow(CliError)

      expect(await readdir(file.target)).toEqual(['mine'])
      expect(await readdir(sandbox.cwd)).toEqual(['folder'])
      expect(await backupsOf(context, file.target)).toEqual([])
    },
  )

  it('compares large files by chunks', async () => {
    const { sandbox, context, file } = await setup()
    const big = Buffer.alloc(3 * 1024 * 1024, 7)
    const source = path.join(sandbox.repo, 'files/zsh/big')
    await writeFile(source, big)
    const target = path.join(sandbox.cwd, 'big')
    await deployFile(file('local', { source, target }), context)

    await expect(inspectFile(file('local', { source, target }), context.record)).resolves.toEqual({
      kind: 'deployed',
      recorded: true,
    })
    big[big.length - 1] = 8
    await writeFile(target, big)
    await expect(inspectFile(file('local', { source, target }), context.record)).resolves.toEqual({
      kind: 'modified',
    })
  })
})

describe('inspectFile', () => {
  it('describes global targets', async () => {
    const { sandbox, context, file } = await setup()

    await expect(inspectFile(file('global'), context.record)).resolves.toEqual({ kind: 'missing' })
    await sandbox.write('home/config/.zshrc', 'mine')
    await expect(inspectFile(file('global'), context.record)).resolves.toEqual({
      kind: 'foreign',
      what: 'file',
    })
  })

  it('tells a copy configfile made from an identical file it did not make', async () => {
    const { sandbox, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'from repo')

    await expect(inspectFile(file('local'), context.record)).resolves.toEqual({ kind: 'identical' })
    await expect(undeployFile(file('local'), context)).resolves.toMatchObject({ status: 'kept' })
  })

  it.each([
    ['a file was added', (target: string) => writeFile(path.join(target, 'extra.vim'), 'extra')],
    [
      'a file was replaced by a link',
      async (target: string) => {
        await rm(path.join(target, 'theme.vim'))
        await symlink('link.vim', path.join(target, 'theme.vim'))
      },
    ],
    ['a file was edited', (target: string) => writeFile(path.join(target, 'theme.vim'), 'edited')],
  ])('detects a modified folder copy: %s', async (_, modify) => {
    const { sandbox, context } = await setup()
    const colors = await folderModule(sandbox)
    await deployFile(colors, context)

    await modify(colors.target)

    await expect(inspectFile(colors, context.record)).resolves.toEqual({ kind: 'modified' })
    await expect(undeployFile(colors, context)).resolves.toMatchObject({ status: 'kept' })
    expect(await readdir(colors.target)).not.toEqual([])
  })

  it('reports targets whose source disappeared from the repository', async () => {
    const { source, context, file } = await setup()
    await deployFile(file('global'), context)
    await rm(source)

    await expect(inspectFile(file('global'), context.record)).resolves.toEqual({
      kind: 'source-missing',
      ours: true,
    })
    await expect(inspectFile(file('local'), context.record)).resolves.toEqual({
      kind: 'source-missing',
      ours: false,
    })
  })
})

describe('undeployFile', () => {
  it('removes the link and restores the backup configfile made', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await deployFile(file('global'), context)

    await expect(undeployFile(file('global'), context)).resolves.toEqual({
      status: 'removed',
      backup: { path: `${target}.old`, status: 'ok' },
      leftover: null,
    })
    expect(await readFile(target, 'utf8')).toBe('mine')
    await expect(context.record.find(target)).resolves.toBeNull()
  })

  it('restores the newest of two backups, then the older one', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'A')
    await deployFile(file('global'), context)
    await rm(target)
    await sandbox.write('home/config/.zshrc', 'B')
    await deployFile(file('global'), context)

    expect(await backupsOf(context, target)).toEqual([`${target}.old`, `${target}.old.1`])
    await undeployFile(file('global'), context)
    expect(await readFile(target, 'utf8')).toBe('B')
    expect(await readFile(`${target}.old`, 'utf8')).toBe('A')
    expect(await backupsOf(context, target)).toEqual([`${target}.old`])
  })

  it('never restores a .old file configfile did not make', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc.old', 'made by hand')
    await deployFile(file('global'), context)

    await expect(undeployFile(file('global'), context)).resolves.toEqual({
      status: 'removed',
      backup: null,
      leftover: null,
    })
    expect(await readFile(`${target}.old`, 'utf8')).toBe('made by hand')
    expect(await readdir(path.dirname(target))).toEqual(['.zshrc.old'])
  })

  it('does not restore a backup that was replaced since it was made', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    // An old modification time: the replacement differs even if it reuses the inode number.
    await utimes(target, 1_000_000, 1_000_000)
    await deployFile(file('global'), context)
    await rm(`${target}.old`)
    await sandbox.write('home/config/.zshrc.old', 'someone else')

    await expect(undeployFile(file('global'), context)).resolves.toMatchObject({
      status: 'removed',
      backup: { path: `${target}.old`, status: 'changed' },
    })
    await expect(lstat(target)).rejects.toThrow()
    expect(await backupsOf(context, target)).toEqual([`${target}.old`])
  })

  it('reports a recorded backup that was deleted since, and forgets it', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await deployFile(file('global'), context)
    await rm(`${target}.old`)

    await expect(undeployFile(file('global'), context)).resolves.toMatchObject({
      status: 'removed',
      backup: { path: `${target}.old`, status: 'missing' },
    })
    await expect(context.record.find(target)).resolves.toBeNull()
  })

  it('removes a linked folder without touching the folder in the repository', async () => {
    const { sandbox, context } = await setup()
    await sandbox.write('home/dotfiles/files/nvim/nvim/init.lua', 'init')
    const nvim: ModuleFile = {
      source: path.join(sandbox.repo, 'files/nvim/nvim'),
      target: path.join(sandbox.home, '.config/nvim'),
      strategy: 'global',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/nvim'),
    }
    await deployFile(nvim, context)

    await expect(undeployFile(nvim, context)).resolves.toMatchObject({ status: 'removed' })
    await expect(lstat(nvim.target)).rejects.toThrow()
    expect(await readdir(nvim.source)).toEqual(['init.lua'])
  })

  it('keeps what configfile did not deploy', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')

    await expect(undeployFile(file('global'), context)).resolves.toMatchObject({ status: 'kept' })
    await expect(undeployFile(file('local'), context)).resolves.toMatchObject({ status: 'kept' })
    expect(await readFile(target, 'utf8')).toBe('mine')
  })

  it('removes an unmodified local copy and restores the forced backup', async () => {
    const { sandbox, target, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'mine')
    await deployFile(file('local'), { ...context, force: true })

    await expect(undeployFile(file('local'), context)).resolves.toMatchObject({
      status: 'removed',
      backup: { path: `${target}.old`, status: 'ok' },
    })
    expect(await readFile(target, 'utf8')).toBe('mine')
  })

  it.skipIf(isRoot)('removes a local copy containing a read-only folder', async () => {
    const { sandbox, context } = await setup()
    await sandbox.write('home/dotfiles/files/ro/d/sub/inner', 'x')
    await chmod(path.join(sandbox.repo, 'files/ro/d/sub'), 0o555)
    await sandbox.write('cwd/d', 'original')
    const file: ModuleFile = {
      source: path.join(sandbox.repo, 'files/ro/d'),
      target: path.join(sandbox.cwd, 'd'),
      strategy: 'local',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/ro'),
    }
    await deployFile(file, { ...context, force: true })

    await expect(undeployFile(file, context)).resolves.toMatchObject({
      status: 'removed',
      leftover: null,
    })
    expect(await readFile(file.target, 'utf8')).toBe('original')
    expect(await readdir(sandbox.cwd)).toEqual(['d'])
    await chmod(path.join(sandbox.repo, 'files/ro/d/sub'), 0o755)
  })

  it('removes its link even when the source disappeared, but keeps a copy it cannot compare', async () => {
    const { source, target, context, file } = await setup()
    await deployFile(file('global'), context)
    await rm(source)

    await expect(undeployFile(file('global'), context)).resolves.toMatchObject({
      status: 'removed',
    })

    await writeFile(target, 'a copy')
    await expect(undeployFile(file('local'), context)).resolves.toEqual({
      status: 'kept',
      state: { kind: 'source-missing', ours: false },
    })
  })

  it('reports files that are not deployed', async () => {
    const { context, file } = await setup()

    await expect(undeployFile(file('global'), context)).resolves.toEqual({
      status: 'not-deployed',
    })
  })
})
