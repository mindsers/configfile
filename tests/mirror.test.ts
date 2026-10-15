import { describe, expect, it } from 'vitest'

import { changesUnder, parseStatus } from '../src/mirror.ts'

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
