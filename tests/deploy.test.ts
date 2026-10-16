import { existsSync } from 'node:fs'
import {
  chmod,
  link,
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

import { applyCopy, inspectCopy, planCopyUndeploy, unchangedFiles } from '../src/copy.ts'
import {
  type DeployContext,
  deployFile,
  Guard,
  inspectFile,
  planDeploy,
  undeployFile,
} from '../src/deploy.ts'
import { CliError } from '../src/errors.ts'
import { RepositoryView } from '../src/mirror.ts'
import type { ModuleFile } from '../src/repository.ts'
import { DeploymentRecord } from '../src/state.ts'
import { createSandbox, git, type Sandbox } from './helpers.ts'

const isRoot = process.getuid?.() === 0

async function contextOf(sandbox: Sandbox): Promise<DeployContext> {
  return {
    record: await DeploymentRecord.load(sandbox.home),
    guard: new Guard({ home: sandbox.home, cwd: sandbox.cwd }),
    view: new RepositoryView(sandbox.repo),
  }
}

async function setup() {
  const sandbox = await createSandbox()
  const source = await sandbox.write('home/dotfiles/files/zsh/zshrc', 'from repo')
  const target = path.join(sandbox.home, 'config', '.zshrc')
  const context = await contextOf(sandbox)

  /** Global files are linked here: `deployFile (global copy)` tests copies. */
  const file = (strategy: 'global' | 'local', overrides: Partial<ModuleFile> = {}): ModuleFile => ({
    source,
    target,
    strategy,
    method: strategy === 'global' ? 'link' : 'copy',
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
    method: 'copy',
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
    expect((await context.record.find(target))?.deployed).not.toHaveProperty('copy')
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

    await expect(inspectFile(file('global'), context.record, context.view)).resolves.toEqual({
      kind: 'deployed',
      recorded: false,
    })
    await expect(deployFile(file('global'), context)).resolves.toEqual({ status: 'up-to-date' })
    await expect(inspectFile(file('global'), context.record, context.view)).resolves.toEqual({
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

    await expect(inspectFile(movedFile, context.record, context.view)).resolves.toEqual({
      kind: 'stale',
    })
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
      method: 'link',
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
    await expect(inspectFile(colors, context.record, context.view)).resolves.toEqual({
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
        method: 'copy',
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

    await expect(
      inspectFile(file('local', { source, target }), context.record, context.view),
    ).resolves.toEqual({
      kind: 'deployed',
      recorded: true,
    })
    big[big.length - 1] = 8
    await writeFile(target, big)
    await expect(
      inspectFile(file('local', { source, target }), context.record, context.view),
    ).resolves.toEqual({
      kind: 'modified',
    })
  })
})

describe('inspectFile', () => {
  it('describes global targets', async () => {
    const { sandbox, context, file } = await setup()

    await expect(inspectFile(file('global'), context.record, context.view)).resolves.toEqual({
      kind: 'missing',
    })
    await sandbox.write('home/config/.zshrc', 'mine')
    await expect(inspectFile(file('global'), context.record, context.view)).resolves.toEqual({
      kind: 'foreign',
      what: 'file',
    })
  })

  it('tells a copy configfile made from an identical file it did not make', async () => {
    const { sandbox, context, file } = await setup()
    await sandbox.write('home/config/.zshrc', 'from repo')

    await expect(inspectFile(file('local'), context.record, context.view)).resolves.toEqual({
      kind: 'identical',
    })
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

    await expect(inspectFile(colors, context.record, context.view)).resolves.toEqual({
      kind: 'modified',
    })
    await expect(undeployFile(colors, context)).resolves.toMatchObject({ status: 'kept' })
    expect(await readdir(colors.target)).not.toEqual([])
  })

  it('reports targets whose source disappeared from the repository', async () => {
    const { source, context, file } = await setup()
    await deployFile(file('global'), context)
    await rm(source)

    await expect(inspectFile(file('global'), context.record, context.view)).resolves.toEqual({
      kind: 'source-missing',
      ours: true,
    })
    await expect(inspectFile(file('local'), context.record, context.view)).resolves.toEqual({
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
      method: 'link',
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
      method: 'copy',
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

describe('deployFile (global copy)', () => {
  /** A global file deployed by copying it, and what changing the repository's version takes. */
  async function copySetup() {
    const base = await setup()
    const copy = (overrides: Partial<ModuleFile> = {}) =>
      base.file('global', { method: 'copy', ...overrides })
    const changeRepository = (content: string) => writeFile(base.source, content)
    return { ...base, copy, changeRepository }
  }

  /** A global folder `files/nvim/nvim` copied to `~/.config/nvim`. */
  async function folderSetup() {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/nvim/nvim/init.lua', 'init')
    await sandbox.write('home/dotfiles/files/nvim/nvim/lua/opts.lua', 'opts')
    await sandbox.write('home/dotfiles/files/nvim/nvim/lua/keys.lua', 'keys')
    const context = await contextOf(sandbox)
    const file: ModuleFile = {
      source: path.join(sandbox.repo, 'files/nvim/nvim'),
      target: path.join(sandbox.home, '.config/nvim'),
      strategy: 'global',
      method: 'copy',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/nvim'),
      entry: {
        module: 'files/nvim',
        source: 'nvim',
        target: '~/.config/nvim',
        folder: sandbox.home,
      },
    }
    const repo = (inner: string) => path.join(file.source, inner)
    const home = (inner: string) => path.join(file.target, inner)
    return { sandbox, context, file, repo, home }
  }

  it('copies the file and records its content', async () => {
    const { source, target, context, copy } = await copySetup()

    await expect(deployFile(copy(), context)).resolves.toEqual({ status: 'deployed' })

    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('from repo')
    expect((await context.record.find(target))?.deployed).toMatchObject({
      strategy: 'global',
      source,
      copy: { kind: 'file', size: 9, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
    await expect(deployFile(copy(), context)).resolves.toEqual({ status: 'up-to-date' })
  })

  it('keeps a file changed on this machine, even saved through a new file', async () => {
    const { target, context, copy } = await copySetup()
    await deployFile(copy(), context)
    // Like a tool that saves by writing a new file and renaming it over the old one.
    await writeFile(`${target}.tmp`, 'set by a tool')
    await rename(`${target}.tmp`, target)

    const result = await deployFile(copy(), context)

    expect(result).toEqual({
      status: 'updated',
      outcome: { files: [{ path: '', result: 'kept' }] },
    })
    expect(await readFile(target, 'utf8')).toBe('set by a tool')
    await expect(inspectFile(copy(), context.record, context.view)).resolves.toMatchObject({
      kind: 'copied',
      changed: [''],
    })
  })

  it('follows the repository when the copy is unchanged, keeping its permissions', async () => {
    const { target, context, copy, changeRepository } = await copySetup()
    await deployFile(copy(), context)
    await chmod(target, 0o600)
    await changeRepository('newer')

    await expect(inspectFile(copy(), context.record, context.view)).resolves.toMatchObject({
      kind: 'copied',
      outdated: [''],
    })
    await expect(deployFile(copy(), context)).resolves.toMatchObject({
      status: 'updated',
      outcome: { files: [{ path: '', result: 'updated' }] },
    })

    expect(await readFile(target, 'utf8')).toBe('newer')
    expect((await lstat(target)).mode & 0o777).toBe(0o600)
    await expect(deployFile(copy(), context)).resolves.toEqual({ status: 'up-to-date' })
  })

  it('asks about a file changed both here and in the repository', async () => {
    const { target, context, copy, changeRepository } = await copySetup()
    await deployFile(copy(), context)
    await writeFile(target, 'mine')
    await changeRepository('theirs')

    await expect(deployFile(copy(), context)).resolves.toMatchObject({
      status: 'conflict',
      paths: [''],
    })
    await expect(deployFile(copy(), { ...context, copies: 'skip' })).resolves.toMatchObject({
      status: 'updated',
      outcome: { files: [{ path: '', result: 'conflict' }] },
    })
    expect(await readFile(target, 'utf8')).toBe('mine')

    const replaced = await deployFile(copy(), { ...context, copies: 'conflicts' })

    expect(replaced).toMatchObject({
      status: 'updated',
      outcome: { files: [{ path: '', result: 'updated', backup: `${target}.old` }] },
    })
    expect(await readFile(target, 'utf8')).toBe('theirs')
    expect(await readFile(`${target}.old`, 'utf8')).toBe('mine')
  })

  it('replaces a file changed on this machine only with force, keeping a backup', async () => {
    const { target, context, copy } = await copySetup()
    await deployFile(copy(), context)
    await writeFile(target, 'mine')

    await deployFile(copy(), { ...context, copies: 'conflicts' })
    expect(await readFile(target, 'utf8')).toBe('mine')

    await deployFile(copy(), { ...context, force: true })
    expect(await readFile(target, 'utf8')).toBe('from repo')
    expect(await readFile(`${target}.old`, 'utf8')).toBe('mine')
  })

  it("turns configfile's link into a copy of what it showed, keeping changes made through it", async () => {
    const { source, target, context, copy, file } = await copySetup()
    await deployFile(file('global'), context)
    await writeFile(target, 'written through the link')

    await expect(deployFile(copy(), context)).resolves.toEqual({ status: 'converted' })

    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('written through the link')
    // Without git, the mirror's file is the repository's: it is the copy's base.
    expect(await readFile(source, 'utf8')).toBe('written through the link')
  })

  it('adopts a file a tool put in place of its link, and never overwrites it unasked', async () => {
    const { target, context, copy, file, changeRepository } = await copySetup()
    await deployFile(file('global'), context)
    await rm(target)
    await writeFile(target, 'saved by a tool')
    await changeRepository('newer from the repository')

    await expect(inspectFile(copy(), context.record, context.view)).resolves.toMatchObject({
      kind: 'copied',
      changed: [''],
      adopted: true,
    })
    await expect(deployFile(copy(), context)).resolves.toMatchObject({
      status: 'updated',
      outcome: { files: [{ path: '', result: 'kept' }] },
    })
    expect(await readFile(target, 'utf8')).toBe('saved by a tool')
    // The repository's version is the base: its next change is a conflict, never a silent overwrite.
    await changeRepository('changed again')
    await expect(deployFile(copy(), context)).resolves.toMatchObject({
      status: 'conflict',
      paths: [''],
    })
  })

  it('replaces an unchanged copy by a link, but asks about a changed one', async () => {
    const { source, target, context, copy, file } = await copySetup()
    await deployFile(copy(), context)

    await expect(deployFile(file('global'), context)).resolves.toEqual({ status: 'converted' })
    expect(await readlink(target)).toBe(source)

    await rm(target)
    await deployFile(copy(), context)
    await writeFile(target, 'mine')
    await expect(deployFile(file('global'), context)).resolves.toEqual({ status: 'conflict' })
    await deployFile(file('global'), { ...context, force: true })
    expect(await readlink(target)).toBe(source)
    expect(await readFile(`${target}.old`, 'utf8')).toBe('mine')
  })

  it('updates a folder file by file, and never touches files that only exist here', async () => {
    const { context, file, repo, home } = await folderSetup()
    await deployFile(file, context)
    await writeFile(home('lazy-lock.json'), '{}')
    await writeFile(home('lua/keys.lua'), 'my keys')
    await writeFile(repo('init.lua'), 'init v2')
    await rm(repo('lua/opts.lua'))
    await writeFile(repo('lua/new.lua'), 'new')

    await expect(inspectFile(file, context.record, context.view)).resolves.toMatchObject({
      kind: 'copied',
      outdated: ['init.lua', 'lua/new.lua'],
      deleted: ['lua/opts.lua'],
      changed: ['lua/keys.lua'],
      conflicts: [],
    })
    const result = await deployFile(file, context)

    expect(result).toEqual({
      status: 'updated',
      outcome: {
        files: [
          { path: 'init.lua', result: 'updated' },
          { path: 'lua/keys.lua', result: 'kept' },
          { path: 'lua/new.lua', result: 'created' },
          { path: 'lua/opts.lua', result: 'deleted' },
        ],
      },
    })
    expect(await readFile(home('init.lua'), 'utf8')).toBe('init v2')
    expect(await readFile(home('lua/new.lua'), 'utf8')).toBe('new')
    expect(existsSync(home('lua/opts.lua'))).toBe(false)
    expect(await readFile(home('lua/keys.lua'), 'utf8')).toBe('my keys')
    expect(await readFile(home('lazy-lock.json'), 'utf8')).toBe('{}')
  })

  it('backs up a file of a folder replaced in a conflict next to it', async () => {
    const { context, file, repo, home } = await folderSetup()
    await deployFile(file, context)
    await writeFile(home('init.lua'), 'mine')
    await writeFile(repo('init.lua'), 'theirs')

    await expect(deployFile(file, context)).resolves.toMatchObject({
      status: 'conflict',
      paths: ['init.lua'],
    })
    await deployFile(file, { ...context, copies: 'conflicts' })

    expect(await readFile(home('init.lua'), 'utf8')).toBe('theirs')
    expect(await readFile(home('init.lua.old'), 'utf8')).toBe('mine')
    expect(await backupsOf(context, home('init.lua'))).toEqual([home('init.lua.old')])
  })

  it('never follows a link planted inside a copied folder', async () => {
    const { sandbox, context, file, repo, home } = await folderSetup()
    await deployFile(file, context)
    const outside = await sandbox.write('home/precious/opts.lua', 'precious')
    await rm(home('lua'), { recursive: true })
    await symlink(path.dirname(outside), home('lua'))
    await writeFile(repo('lua/opts.lua'), 'opts v2')

    await deployFile(file, { ...context, force: true })

    expect(await readFile(outside, 'utf8')).toBe('precious')
    expect(existsSync(path.join(path.dirname(outside), 'keys.lua'))).toBe(false)
  })

  it('refuses a folder containing a link that leads outside the module', async () => {
    const { sandbox, context, file, repo } = await folderSetup()
    const secret = await sandbox.write('home/.ssh/id_ed25519', 'secret')
    await symlink(secret, repo('key'))

    await expect(deployFile(file, context)).rejects.toThrow('leads outside the module folder')
    expect(existsSync(file.target)).toBe(false)
  })

  it('compares with the committed version, so changes in the mirror stay changes made here', async () => {
    const { sandbox, source, target, context, copy, file } = await copySetup()
    git(sandbox.repo, 'init', '--quiet')
    git(sandbox.repo, 'add', '.')
    git(sandbox.repo, 'commit', '--quiet', '-m', 'first')
    await deployFile(file('global'), context)
    await writeFile(target, 'written through the link')

    await deployFile(copy(), { ...context, view: new RepositoryView(sandbox.repo) })
    // What update does to the mirror.
    git(sandbox.repo, 'checkout', '--quiet', '--', '.')

    expect(await readFile(source, 'utf8')).toBe('from repo')
    await expect(
      inspectFile(copy(), context.record, new RepositoryView(sandbox.repo)),
    ).resolves.toMatchObject({ kind: 'copied', changed: [''], outdated: [] })
  })
})

describe('deployFile (global copy): edge cases', () => {
  async function folder(files: Record<string, string>) {
    const sandbox = await createSandbox()
    for (const [name, content] of Object.entries(files)) {
      await sandbox.write(`home/dotfiles/files/cfg/cfg/${name}`, content)
    }
    const context = await contextOf(sandbox)
    const file: ModuleFile = {
      source: path.join(sandbox.repo, 'files/cfg/cfg'),
      target: path.join(sandbox.home, '.cfg'),
      strategy: 'global',
      method: 'copy',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/cfg'),
    }
    return { sandbox, context, file }
  }

  it('keeps a file the repository renamed by letter case only', async () => {
    const { context, file } = await folder({ Foo: 'foo' })
    await deployFile(file, context)
    await rename(path.join(file.source, 'Foo'), path.join(file.source, 'tmp'))
    await rename(path.join(file.source, 'tmp'), path.join(file.source, 'foo'))
    // A disk that ignores letter case finds the file at both names: a hard
    // link does the same on any disk (it already exists on such a disk).
    await link(path.join(file.target, 'Foo'), path.join(file.target, 'foo')).catch(() => {})

    await deployFile(file, context)
    await deployFile(file, context)

    expect(await readFile(path.join(file.target, 'foo'), 'utf8')).toBe('foo')
    await expect(inspectFile(file, context.record, context.view)).resolves.toMatchObject({
      kind: 'copied',
      outdated: [],
      changed: [],
    })
  })

  it('creates the files of a folder the repository made of a file', async () => {
    const { context, file } = await folder({ a: 'a file' })
    await deployFile(file, context)
    await rm(path.join(file.source, 'a'))
    await mkdir(path.join(file.source, 'a'))
    await writeFile(path.join(file.source, 'a/x'), 'in a folder')

    await expect(deployFile(file, context)).resolves.toMatchObject({
      status: 'updated',
      outcome: {
        files: [
          { path: 'a', result: 'deleted' },
          { path: 'a/x', result: 'created' },
        ],
      },
    })
    expect(await readFile(path.join(file.target, 'a/x'), 'utf8')).toBe('in a folder')
  })

  it('takes files named like object properties as files', async () => {
    const { context, file } = await folder({ x: 'x' })
    await deployFile(file, context)
    await writeFile(path.join(file.source, 'constructor'), 'c')
    await writeFile(path.join(file.source, '__proto__'), 'p')

    await deployFile(file, context)

    expect(await readFile(path.join(file.target, 'constructor'), 'utf8')).toBe('c')
    expect(await readFile(path.join(file.target, '__proto__'), 'utf8')).toBe('p')
    const copy = (await context.record.find(file.target))?.deployed?.copy
    expect(copy?.kind === 'folder' && Object.keys(copy.files).sort()).toEqual([
      '__proto__',
      'constructor',
      'x',
    ])
    await writeFile(path.join(file.source, '__proto__'), 'p2')
    await expect(deployFile(file, context)).resolves.toMatchObject({
      status: 'updated',
      outcome: { files: [{ path: '__proto__', result: 'updated' }] },
    })
  })

  it('moves aside a file already identical to the repository, and puts it back', async () => {
    const { target, context, file, sandbox } = await setup()
    await sandbox.write('home/config/.zshrc', 'from repo')
    const copy = file('global', { method: 'copy' })

    await expect(deployFile(copy, context)).resolves.toEqual({
      status: 'backed-up',
      backup: `${target}.old`,
    })
    await undeployFile(copy, context)

    expect(await readFile(target, 'utf8')).toBe('from repo')
    expect(existsSync(`${target}.old`)).toBe(false)
  })

  it('never removes a copy for another entry whose source is gone', async () => {
    const { target, context, file } = await setup()
    const copy = file('global', { method: 'copy' })
    await deployFile(copy, context)
    await writeFile(target, 'changed after the copy')
    const other = file('global', {
      method: 'copy',
      source: path.join(path.dirname(copy.source), 'gone'),
    })

    await expect(undeployFile(other, context)).resolves.toMatchObject({ status: 'kept' })
    await expect(undeployFile({ ...other, method: 'link' }, context)).resolves.toMatchObject({
      status: 'kept',
    })
    expect(await readFile(target, 'utf8')).toBe('changed after the copy')
  })

  it.skipIf(isRoot)('keeps a copied folder with a subfolder it cannot read', async () => {
    const { context, file } = await folder({ x: 'x' })
    await deployFile(file, context)
    const locked = path.join(file.target, 'private')
    await mkdir(locked)
    await writeFile(path.join(locked, 'mine'), 'mine')
    await chmod(locked, 0o000)

    try {
      await expect(undeployFile(file, context)).rejects.toThrow()
      expect(existsSync(file.target)).toBe(true)
    } finally {
      await chmod(locked, 0o700)
    }
    expect(await readFile(path.join(locked, 'mine'), 'utf8')).toBe('mine')
  })

  it('leaves out the files the repository ignores', async () => {
    const { sandbox, context, file } = await folder({ x: 'x', '.gitignore': 'lock.json\n' })
    git(sandbox.repo, 'init', '--quiet')
    git(sandbox.repo, 'add', '.')
    git(sandbox.repo, 'commit', '--quiet', '-m', 'first')
    // Written through an old link, ignored by the repository.
    await writeFile(path.join(file.source, 'lock.json'), '{}')

    await deployFile(file, context)
    expect(Object.keys((await context.record.find(file.target))?.deployed?.copy ?? {})).toEqual([
      'kind',
      'files',
    ])
    expect((await context.record.find(file.target))?.deployed?.copy).toMatchObject({
      files: { x: expect.anything(), '.gitignore': expect.anything() },
    })
    expect((await context.record.find(file.target))?.deployed?.copy).not.toMatchObject({
      files: { 'lock.json': expect.anything() },
    })
    const result = await undeployFile(file, context)

    expect(await context.record.find(file.target)).toBeNull()
    expect(result).toMatchObject({
      status: 'kept',
      state: { kind: 'changed', others: ['lock.json'], removed: 2 },
    })
    expect(await readFile(path.join(file.target, 'lock.json'), 'utf8')).toBe('{}')
  })
})

describe('deployFile (global copy): failures and races', () => {
  /** A git mirror with the module `cfg` whose folder `cfg` is copied to `~/.cfg`. */
  async function mirror(files: Record<string, string>) {
    const sandbox = await createSandbox()
    for (const [name, content] of Object.entries(files)) {
      await sandbox.write(`home/dotfiles/files/cfg/cfg/${name}`, content)
    }
    git(sandbox.repo, 'init', '--quiet')
    git(sandbox.repo, 'add', '.')
    git(sandbox.repo, 'commit', '--quiet', '-m', 'first')
    const context = await contextOf(sandbox)
    const file: ModuleFile = {
      source: path.join(sandbox.repo, 'files/cfg/cfg'),
      target: path.join(sandbox.home, '.cfg'),
      strategy: 'global',
      method: 'copy',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/cfg'),
    }
    const fresh = () => ({ ...context, view: new RepositoryView(sandbox.repo) })
    return { sandbox, context, file, fresh }
  }

  it('fails instead of guessing when git cannot read the mirror', async () => {
    const { sandbox, file, fresh } = await mirror({ a: 'a' })
    await sandbox.write('home/dotfiles/files/cfg/cfg/untracked', 'not the repository')
    await writeFile(path.join(sandbox.repo, '.git/index'), 'not an index')

    await expect(deployFile(file, fresh())).rejects.toThrow(
      'Cannot compare copies with the repository: git status failed:',
    )
    expect(existsSync(file.target)).toBe(false)
  })

  it('copies a folder holding a link to another folder of the module', async () => {
    const { sandbox, file, fresh } = await mirror({ 'lua/opts.lua': 'opts', '.keep': '' })
    await symlink('lua', path.join(file.source, 'linked'))
    git(sandbox.repo, 'add', '.')
    git(sandbox.repo, 'commit', '--quiet', '-m', 'a link')

    await expect(deployFile(file, fresh())).resolves.toEqual({ status: 'deployed' })

    expect(await readFile(path.join(file.target, 'linked/opts.lua'), 'utf8')).toBe('opts')
    await expect(
      inspectFile(file, (await contextOf(sandbox)).record, fresh().view),
    ).resolves.toMatchObject({
      kind: 'copied',
      outdated: [],
      changed: [],
    })
  })

  it('copies a module whose folder links to another folder of the repository', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/shared/cfg/cfg/a', 'a')
    await mkdir(path.join(sandbox.repo, 'files'))
    await symlink('../shared/cfg', path.join(sandbox.repo, 'files/cfg'))
    git(sandbox.repo, 'init', '--quiet')
    git(sandbox.repo, 'add', '.')
    git(sandbox.repo, 'commit', '--quiet', '-m', 'first')
    await writeFile(path.join(sandbox.repo, 'shared/cfg/cfg/a'), 'changed in the mirror')
    const context = await contextOf(sandbox)
    const file: ModuleFile = {
      source: path.join(sandbox.repo, 'files/cfg/cfg'),
      target: path.join(sandbox.home, '.cfg'),
      strategy: 'global',
      method: 'copy',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/cfg'),
    }

    await deployFile(file, context)

    // The committed version is the base, through the link: the mirror's change is this machine's.
    await expect(
      inspectFile(file, context.record, new RepositoryView(sandbox.repo)),
    ).resolves.toMatchObject({
      kind: 'copied',
      changed: ['a'],
    })
  })

  it('never records the files of a repository a tool cloned in the source folder', async () => {
    const { file, fresh } = await mirror({ a: 'a' })
    const plugin = path.join(file.source, 'pack/plugin')
    await mkdir(plugin, { recursive: true })
    await writeFile(path.join(plugin, 'init.lua'), 'plugin')
    git(plugin, 'init', '--quiet')
    git(plugin, 'add', '.')
    git(plugin, 'commit', '--quiet', '-m', 'plugin')
    const context = fresh()

    await deployFile(file, context)

    const copy = (await context.record.find(file.target))?.deployed?.copy
    expect(copy?.kind === 'folder' && Object.keys(copy.files)).toEqual(['a'])
    await expect(undeployFile(file, fresh())).resolves.toMatchObject({ status: 'kept' })
    expect(await readFile(path.join(file.target, 'pack/plugin/init.lua'), 'utf8')).toBe('plugin')
  })

  it('leaves no copy behind when it cannot be recorded', { skip: isRoot }, async () => {
    const { sandbox, context, file } = await setup()
    const copy = file('global', { method: 'copy' })
    await mkdir(path.join(sandbox.home, '.configfile'), { recursive: true })
    await chmod(path.join(sandbox.home, '.configfile'), 0o500)

    try {
      await expect(deployFile(copy, context)).rejects.toThrow()
      expect(existsSync(copy.target)).toBe(false)
    } finally {
      await chmod(path.join(sandbox.home, '.configfile'), 0o700)
    }
  })

  it("keeps yours when the repository's version cannot be written in its place", async () => {
    const { sandbox, file, fresh } = await mirror({ a: 'a', b: 'b' })
    await deployFile(file, fresh())
    await writeFile(path.join(file.target, 'a'), 'mine')
    await writeFile(path.join(file.source, 'a'), 'theirs')
    git(sandbox.repo, 'commit', '--quiet', '-am', 'theirs')
    // Deleted from the mirror, still committed: there is nothing to copy from.
    await rm(path.join(file.source, 'a'))

    const result = await deployFile(file, { ...fresh(), copies: 'conflicts' })

    expect(result).toMatchObject({
      status: 'updated',
      outcome: {
        files: [{ path: 'a', result: 'conflict', reason: expect.stringContaining('missing') }],
      },
    })
    expect(await readFile(path.join(file.target, 'a'), 'utf8')).toBe('mine')
    expect(existsSync(path.join(file.target, 'a.old'))).toBe(false)
  })

  it('updates a copied folder while it is the current folder', async () => {
    const { sandbox, file, fresh } = await mirror({ a: 'a' })
    await deployFile(file, fresh())
    await writeFile(path.join(file.source, 'a'), 'theirs')
    git(sandbox.repo, 'commit', '--quiet', '-am', 'theirs')
    const inside = { ...fresh(), guard: new Guard({ home: sandbox.home, cwd: file.target }) }

    await expect(deployFile(file, inside)).resolves.toMatchObject({ status: 'updated' })
    expect(await readFile(path.join(file.target, 'a'), 'utf8')).toBe('theirs')
    // Removing the whole folder is still refused.
    await expect(undeployFile(file, inside)).rejects.toThrow('would replace the current folder')
  })

  it('updates the other files when one cannot be written, and records them', {
    skip: isRoot,
  }, async () => {
    const { sandbox, file, fresh } = await mirror({ a: 'a', 'locked/b': 'b' })
    await deployFile(file, fresh())
    await writeFile(path.join(file.source, 'a'), 'a2')
    await writeFile(path.join(file.source, 'locked/b'), 'b2')
    git(sandbox.repo, 'commit', '--quiet', '-am', 'both')
    await chmod(path.join(file.target, 'locked'), 0o500)

    try {
      const result = await deployFile(file, fresh())
      expect(result).toMatchObject({
        status: 'updated',
        outcome: {
          files: [
            { path: 'a', result: 'updated' },
            { path: 'locked/b', result: 'failed', reason: expect.stringContaining('EACCES') },
          ],
        },
      })
    } finally {
      await chmod(path.join(file.target, 'locked'), 0o700)
    }
    await expect(
      inspectFile(file, (await contextOf(sandbox)).record, fresh().view),
    ).resolves.toMatchObject({
      outdated: ['locked/b'],
    })
  })

  it('keeps a file written while it plans, as a conflict', async () => {
    const { sandbox, file, fresh } = await mirror({ a: 'a', b: 'b' })
    const context = fresh()
    await deployFile(file, context)
    await writeFile(path.join(file.source, 'a'), 'theirs')
    await rm(path.join(file.source, 'b'))
    git(sandbox.repo, 'commit', '--quiet', '-am', 'theirs')

    const state = await inspectCopy(file, context.record, fresh().view)
    if (state.kind !== 'copy') throw new Error(`unexpected ${state.kind}`)
    // A tool writes, with another size, after configfile read the files.
    await writeFile(path.join(file.target, 'a'), 'written by a tool meanwhile')
    await writeFile(path.join(file.target, 'b'), 'written by a tool meanwhile')
    const outcome = await applyCopy(file, state.plan, { replace: 'none', record: context.record })

    expect(outcome.files).toEqual([
      {
        path: 'a',
        result: 'conflict',
        reason: expect.stringContaining('while configfile was running'),
      },
      {
        path: 'b',
        result: 'conflict',
        reason: expect.stringContaining('while configfile was running'),
      },
    ])
    expect(await readFile(path.join(file.target, 'a'), 'utf8')).toBe('written by a tool meanwhile')
    expect(await readFile(path.join(file.target, 'b'), 'utf8')).toBe('written by a tool meanwhile')
  })

  it('never removes a copy written to, or added to, after it was planned', async () => {
    const { file, fresh } = await mirror({ a: 'a' })
    const context = fresh()
    await deployFile(file, context)
    const known = (await context.record.find(file.target))?.deployed?.copy
    if (known == null) throw new Error('not recorded')

    const plan = await planCopyUndeploy(file, known, context.view)
    if (plan.action !== 'remove') throw new Error(`unexpected ${plan.action}`)
    await writeFile(path.join(file.target, 'lock.json'), '{}')

    await expect(unchangedFiles(file.target, plan.files)).resolves.toBe(false)
  })

  it('copies a file the repository made of a copied folder, and of a folder inside it', async () => {
    const { sandbox, file, fresh } = await mirror({ 'd/x': 'x', y: 'y' })
    await deployFile(file, fresh())
    await rm(path.join(file.source, 'd'), { recursive: true })
    await writeFile(path.join(file.source, 'd'), 'now a file')
    git(sandbox.repo, 'add', '-A')
    git(sandbox.repo, 'commit', '--quiet', '-m', 'd is a file')

    await expect(deployFile(file, fresh())).resolves.toMatchObject({
      status: 'updated',
      outcome: {
        files: [
          { path: 'd', result: 'created' },
          { path: 'd/x', result: 'deleted' },
        ],
      },
    })
    expect(await readFile(path.join(file.target, 'd'), 'utf8')).toBe('now a file')

    await rm(file.source, { recursive: true })
    await writeFile(file.source, 'the whole folder is a file')
    git(sandbox.repo, 'add', '-A')
    git(sandbox.repo, 'commit', '--quiet', '-m', 'cfg is a file')

    await expect(
      inspectFile(file, (await contextOf(sandbox)).record, fresh().view),
    ).resolves.toMatchObject({
      kind: 'copied',
      outdated: [''],
    })
    await expect(deployFile(file, fresh())).resolves.toEqual({ status: 'deployed' })
    expect(await readFile(file.target, 'utf8')).toBe('the whole folder is a file')
  })

  it('asks before replacing a changed copy whose file the repository made a folder', async () => {
    const { context, file, source, target } = await setup()
    const copy = file('global', { method: 'copy' })
    await deployFile(copy, context)
    await writeFile(target, 'mine')
    await rm(source)
    await mkdir(source)
    await writeFile(path.join(source, 'part'), 'in a folder')

    await expect(deployFile(copy, context)).resolves.toMatchObject({
      status: 'conflict',
      paths: [''],
    })
    await expect(deployFile(copy, { ...context, copies: 'skip' })).resolves.toMatchObject({
      status: 'updated',
      outcome: { files: [{ path: '', result: 'conflict' }] },
    })
    expect(await readFile(target, 'utf8')).toBe('mine')

    await deployFile(copy, { ...context, copies: 'conflicts' })
    expect(await readFile(path.join(target, 'part'), 'utf8')).toBe('in a folder')
    expect(await readFile(`${target}.old`, 'utf8')).toBe('mine')
  })

  it('puts the link back when its copy cannot be recorded', { skip: isRoot }, async () => {
    const { sandbox, context, file, source, target } = await setup()
    await deployFile(file('global'), context)
    await chmod(path.join(sandbox.home, '.configfile'), 0o500)

    try {
      await expect(deployFile(file('global', { method: 'copy' }), context)).rejects.toThrow()
    } finally {
      await chmod(path.join(sandbox.home, '.configfile'), 0o700)
    }
    expect(await readlink(target)).toBe(source)
  })

  it('never records a repository a tool cloned in a folder the repository ignores', async () => {
    const { file, fresh } = await mirror({ a: 'a', '.gitignore': 'plugged/\n' })
    const plugin = path.join(file.source, 'plugged/foo')
    await mkdir(plugin, { recursive: true })
    await writeFile(path.join(plugin, 'plugin.vim'), 'plugin')
    git(plugin, 'init', '--quiet')

    await expect(fresh().view.filesUnder(file.source)).resolves.toEqual(['.gitignore', 'a'])
  })

  it('replaces its unchanged copy when the repository made a folder of the file', async () => {
    const { context, file, source, target } = await setup()
    const copy = file('global', { method: 'copy' })
    await deployFile(copy, context)
    await rm(source)
    await mkdir(source)
    await writeFile(path.join(source, 'part'), 'in a folder')

    await expect(deployFile(copy, context)).resolves.toEqual({ status: 'deployed' })
    expect(await readFile(path.join(target, 'part'), 'utf8')).toBe('in a folder')
    expect(existsSync(`${target}.old`)).toBe(false)
  })
})

describe('undeployFile (global copy)', () => {
  it('removes an unchanged copy, restores the backup, and keeps a changed one', async () => {
    const { target, context, file } = await setup()
    const copy = file('global', { method: 'copy' })
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'mine')
    await deployFile(copy, context)

    await expect(undeployFile(copy, context)).resolves.toMatchObject({
      status: 'removed',
      backup: { path: `${target}.old`, status: 'ok' },
    })
    expect(await readFile(target, 'utf8')).toBe('mine')

    await deployFile(copy, context)
    await writeFile(target, 'changed after the copy')
    await expect(undeployFile(copy, context)).resolves.toEqual({
      status: 'kept',
      state: { kind: 'changed', paths: [''], others: [], removed: 0 },
    })
    expect(await readFile(target, 'utf8')).toBe('changed after the copy')
  })

  it('puts back what a conflict replaced inside a copied folder', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/nvim/nvim/init.lua', 'init')
    await sandbox.write('home/dotfiles/files/nvim/nvim/keep', 'keep')
    const context = await contextOf(sandbox)
    const file: ModuleFile = {
      source: path.join(sandbox.repo, 'files/nvim/nvim'),
      target: path.join(sandbox.home, '.config/nvim'),
      strategy: 'global',
      method: 'copy',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/nvim'),
    }
    await deployFile(file, context)
    await writeFile(path.join(file.target, 'init.lua'), 'mine')
    await writeFile(path.join(file.source, 'init.lua'), 'theirs')
    await deployFile(file, { ...context, copies: 'conflicts' })

    const result = await undeployFile(file, context)

    // The repository's version goes, yours comes back from init.lua.old, and the folder stays.
    expect(result).toMatchObject({ status: 'kept', state: { kind: 'changed', removed: 2 } })
    expect(await readFile(path.join(file.target, 'init.lua'), 'utf8')).toBe('mine')
    expect(existsSync(path.join(file.target, 'init.lua.old'))).toBe(false)
    expect(existsSync(path.join(file.target, 'keep'))).toBe(false)
  })

  it('forgets a file deleted both here and in the repository, and leaves a blocked one', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/nvim/nvim/gone', 'gone')
    await sandbox.write('home/dotfiles/files/nvim/nvim/sub/x', 'x')
    await sandbox.write('home/dotfiles/files/nvim/nvim/y', 'y')
    const context = await contextOf(sandbox)
    const file: ModuleFile = {
      source: path.join(sandbox.repo, 'files/nvim/nvim'),
      target: path.join(sandbox.home, '.config/nvim'),
      strategy: 'global',
      method: 'copy',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/nvim'),
    }
    await deployFile(file, context)
    await rm(path.join(file.source, 'gone'))
    await rm(path.join(file.target, 'gone'))
    // A file where the copied folder `sub` was.
    await rm(path.join(file.target, 'sub'), { recursive: true })
    await writeFile(path.join(file.target, 'sub'), 'a file now')
    await writeFile(path.join(file.source, 'sub/x'), 'x2')

    const result = await deployFile(file, { ...context, force: true })

    expect(result).toMatchObject({
      status: 'updated',
      outcome: {
        files: [
          { path: 'sub/x', result: 'conflict', reason: expect.stringContaining('link or a file') },
        ],
      },
    })
    const copy = (await context.record.find(file.target))?.deployed?.copy
    expect(copy?.kind === 'folder' && Object.keys(copy.files).sort()).toEqual(['sub/x', 'y'])
    expect(await readFile(path.join(file.target, 'sub'), 'utf8')).toBe('a file now')
  })

  it('removes the files of a folder nothing changed, and keeps the others', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/nvim/nvim/init.lua', 'init')
    await sandbox.write('home/dotfiles/files/nvim/nvim/lua/opts.lua', 'opts')
    const context = await contextOf(sandbox)
    const file: ModuleFile = {
      source: path.join(sandbox.repo, 'files/nvim/nvim'),
      target: path.join(sandbox.home, '.config/nvim'),
      strategy: 'global',
      method: 'copy',
      repository: sandbox.repo,
      module: path.join(sandbox.repo, 'files/nvim'),
    }
    await deployFile(file, context)
    await writeFile(path.join(file.target, 'init.lua'), 'mine')
    await writeFile(path.join(file.target, 'lazy-lock.json'), '{}')

    const result = await undeployFile(file, context)

    expect(result).toEqual({
      status: 'kept',
      state: { kind: 'changed', paths: ['init.lua'], others: ['lazy-lock.json'], removed: 1 },
    })
    expect(existsSync(path.join(file.target, 'lua'))).toBe(false)
    expect(await readdir(file.target)).toEqual(['init.lua', 'lazy-lock.json'])
    expect((await context.record.find(file.target))?.deployed?.copy).toMatchObject({
      kind: 'folder',
      files: { 'init.lua': expect.anything() },
    })
  })
})
