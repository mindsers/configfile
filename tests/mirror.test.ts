import { rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { hashContent } from '../src/fsutil.ts'
import { changesUnder, parseStatus, RepositoryView } from '../src/mirror.ts'
import { createSandbox, git } from './helpers.ts'

describe('parseStatus', () => {
  it('reads modified, new and deleted files, sorted by path', () => {
    const output = [' M files/zsh/zshrc', '?? files/nvim/lock.json', ' D files/nvim/old.lua', '']
    expect(parseStatus(output.join('\0'))).toEqual([
      { path: 'files/nvim/lock.json', kind: 'new' },
      { path: 'files/nvim/old.lua', kind: 'deleted' },
      { path: 'files/zsh/zshrc', kind: 'modified' },
    ])
  })

  it('keeps names with spaces and newlines whole', () => {
    expect(parseStatus('?? files/a b\nc\0')).toEqual([{ path: 'files/a b\nc', kind: 'new' }])
  })

  it('reads both paths of a rename, and the new path of a copy', () => {
    expect(parseStatus('R  files/new\0files/old\0C  files/copy\0files/original\0')).toEqual([
      { path: 'files/copy', kind: 'new' },
      { path: 'files/new', kind: 'new' },
      { path: 'files/old', kind: 'deleted' },
    ])
  })

  it('reads an untracked folder, such as a repository a tool cloned, as one new path', () => {
    expect(parseStatus('?? files/nvim/pack/plugin/\0')).toEqual([
      { path: 'files/nvim/pack/plugin/', kind: 'new' },
    ])
  })

  it('takes a file added to the index, then deleted, as not in the last commit', () => {
    expect(parseStatus('AD files/added\0RD files/moved\0files/from\0')).toEqual([
      { path: 'files/added', kind: 'new' },
      { path: 'files/from', kind: 'deleted' },
      { path: 'files/moved', kind: 'new' },
    ])
  })

  it('reads staged changes too', () => {
    expect(parseStatus('A  files/added\0MM files/both\0D  files/gone\0')).toEqual([
      { path: 'files/added', kind: 'new' },
      { path: 'files/both', kind: 'modified' },
      { path: 'files/gone', kind: 'deleted' },
    ])
  })
})

describe('changesUnder', () => {
  const changes = parseStatus(
    [' M files/nvim/init.lua', ' M files/nvim2/init.lua', ' M files/zsh/zshrc', ''].join('\0'),
  )

  it('keeps an untracked folder that contains the source', () => {
    const untracked = parseStatus('?? files/new/\0')
    expect(changesUnder(untracked, 'files/new/sub/file')).toEqual(untracked)
    expect(changesUnder(untracked, 'files/newer')).toEqual([])
  })

  it('keeps the changes to a file, or inside a folder', () => {
    expect(changesUnder(changes, 'files/zsh/zshrc').map(change => change.path)).toEqual([
      'files/zsh/zshrc',
    ])
    expect(changesUnder(changes, 'files/nvim').map(change => change.path)).toEqual([
      'files/nvim/init.lua',
    ])
  })
})

describe('RepositoryView', () => {
  /** A git repository at `sandbox.repo` with `files/m/m/{a,b,c}` committed. */
  async function repository() {
    const sandbox = await createSandbox()
    for (const name of ['a', 'b', 'c']) await sandbox.write(`home/dotfiles/files/m/m/${name}`, name)
    await sandbox.write('home/dotfiles/files/m/m/.gitignore', 'ignored\n')
    git(sandbox.repo, 'init', '--quiet')
    git(sandbox.repo, 'add', '.')
    git(sandbox.repo, 'commit', '--quiet', '-m', 'first')
    const source = path.join(sandbox.repo, 'files/m/m')
    return { sandbox, source, view: () => new RepositoryView(sandbox.repo) }
  }
  const hash = (content: string) => hashContent(Buffer.from(content))

  it('gives the committed version of files changed or deleted in the mirror', async () => {
    const { source, view } = await repository()
    await writeFile(path.join(source, 'a'), 'changed in the mirror')
    await rm(path.join(source, 'b'))
    await writeFile(path.join(source, 'untracked'), 'u')
    await writeFile(path.join(source, 'ignored'), 'i')

    const current = view()
    expect(await current.filesUnder(source)).toEqual(['.gitignore', 'a', 'b', 'c'])
    expect(await current.versionOf(path.join(source, 'a'))).toEqual(hash('a'))
    expect(await current.versionOf(path.join(source, 'b'))).toEqual(hash('b'))
    expect(await current.versionOf(path.join(source, 'c'))).toEqual(hash('c'))
    // Not the repository's: only its own content.
    expect(await current.versionOf(path.join(source, 'untracked'))).toEqual(hash('u'))
  })

  it('has no version for a path under a file, nor for a missing one', async () => {
    const { source, view } = await repository()

    await expect(view().versionOf(path.join(source, 'a/below'))).resolves.toBeNull()
    await expect(view().versionOf(path.join(source, 'missing/deeper'))).resolves.toBeNull()
  })

  it('reads a folder outside the repository, and a mirror without git, from disk', async () => {
    const { sandbox, view } = await repository()
    const outside = path.join(sandbox.root, 'outside')
    await sandbox.write('outside/x', 'x')
    await symlink(outside, path.join(sandbox.repo, 'files/linked'))

    expect(await view().filesUnder(path.join(sandbox.repo, 'files/linked'))).toEqual(['x'])

    await rm(path.join(sandbox.repo, '.git'), { recursive: true })
    await writeFile(path.join(sandbox.repo, 'files/m/m/untracked'), 'u')
    // Without git, every file on disk is the repository's.
    await writeFile(path.join(sandbox.repo, 'files/m/m/ignored'), 'i')
    expect(await view().filesUnder(path.join(sandbox.repo, 'files/m/m'))).toEqual([
      '.gitignore',
      'a',
      'b',
      'c',
      'ignored',
      'untracked',
    ])
  })

  it('reads the files of a submodule from disk', async () => {
    const { sandbox, source, view } = await repository()
    await sandbox.write('sub/plugin.vim', 'plugin')
    const sub = path.join(sandbox.root, 'sub')
    git(sub, 'init', '--quiet')
    git(sub, 'add', '.')
    git(sub, 'commit', '--quiet', '-m', 'sub')
    git(
      sandbox.repo,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      '--quiet',
      'add',
      sub,
      'files/m/m/sub',
    )
    git(sandbox.repo, 'commit', '--quiet', '-m', 'a submodule')

    expect(await view().filesUnder(source)).toContain('sub/plugin.vim')
    expect(await view().versionOf(path.join(source, 'sub/plugin.vim'))).toEqual(hash('plugin'))
  })

  it('fails when git cannot read the mirror, and when the source is gone', async () => {
    const { sandbox, source, view } = await repository()
    await expect(view().filesUnder(path.join(sandbox.repo, 'files/gone'))).rejects.toThrow('ENOENT')

    await writeFile(path.join(sandbox.repo, '.git/index'), 'not an index')
    await expect(view().versionOf(path.join(source, 'a'))).rejects.toThrow(
      'Cannot compare copies with the repository: git status failed:',
    )
  })
})
