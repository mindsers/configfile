import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config.js'
import { CliError, NotInitializedError } from '../src/errors.js'
import { redactUrl } from '../src/output.js'
import { createSandbox } from './helpers.js'

describe('ConfigStore', () => {
  it('reports a missing configuration', async () => {
    const { home } = await createSandbox()
    const store = new ConfigStore(home)

    expect(store.exists()).toBe(false)
    await expect(store.read()).rejects.toBeInstanceOf(NotInitializedError)
  })

  it('reads the snake_case file format; without script_extensions, every file is a script', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure({ repo_url: 'git@example.com:me/dotfiles.git' })

    await expect(new ConfigStore(sandbox.home).read()).resolves.toEqual({
      repoUrl: 'git@example.com:me/dotfiles.git',
      folderPath: sandbox.repo,
      scriptExtensions: null,
    })
  })

  it('reads custom script extensions', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure({ script_extensions: ['.py'] })

    const config = await new ConfigStore(sandbox.home).read()
    expect(config.scriptExtensions).toEqual(['.py'])
  })

  it('writes the configuration and keeps unknown keys', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure({ script_extensions: ['.py'], custom: 42 })
    const store = new ConfigStore(sandbox.home)

    await store.write({ repoUrl: 'https://example.com/dotfiles.git', folderPath: '/somewhere' })

    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual({
      repo_url: 'https://example.com/dotfiles.git',
      folder_path: '/somewhere',
      script_extensions: ['.py'],
      custom: 42,
    })
  })

  it('rejects an invalid file with a readable error', async () => {
    const { home } = await createSandbox()
    const store = new ConfigStore(home)
    await writeFile(store.path, '{ not json')

    await expect(store.read()).rejects.toThrow(CliError)
    await expect(store.read()).rejects.toThrow(/not valid JSON \(.*position/)

    await writeFile(store.path, '[]')
    await expect(store.read()).rejects.toThrow(/not a JSON object/)
  })

  it('reports an unreadable file with its path', async () => {
    const { home } = await createSandbox()
    const store = new ConfigStore(home)
    await mkdir(store.path)

    await expect(store.read()).rejects.toThrow(CliError)
    await expect(store.read()).rejects.toThrow(`Cannot read ${store.path}`)
  })

  it('resolves a hand-edited folder_path against the home folder', async () => {
    const sandbox = await createSandbox()

    for (const folder of ['~/dotfiles', 'dotfiles']) {
      await sandbox.configure({ folder_path: folder })
      const config = await new ConfigStore(sandbox.home).read()
      expect(config.folderPath).toBe(sandbox.repo)
    }
  })

  it('normalizes script extensions and rejects invalid ones', async () => {
    const sandbox = await createSandbox()
    const store = new ConfigStore(sandbox.home)

    await sandbox.configure({ script_extensions: ['py', '.rb', ''] })
    expect((await store.read()).scriptExtensions).toEqual(['.py', '.rb', ''])

    for (const invalid of ['.py', [1], 3]) {
      await sandbox.configure({ script_extensions: invalid })
      await expect(store.read()).rejects.toThrow(/"script_extensions" must be a list of strings/)
    }
  })

  it('rejects a configuration without folder_path', async () => {
    const { home } = await createSandbox()
    const store = new ConfigStore(home)
    await writeFile(store.path, '{"repo_url": "x"}')

    await expect(store.read()).rejects.toThrow(/"folder_path" is missing/)
  })

  it('reads partial values for prompt defaults, even from an invalid file', async () => {
    const { home } = await createSandbox()
    const store = new ConfigStore(home)

    await expect(store.readPartial()).resolves.toEqual({})

    await writeFile(store.path, '{"repo_url": "u"}')
    await expect(store.readPartial()).resolves.toEqual({ repoUrl: 'u' })

    await writeFile(store.path, 'garbage')
    await expect(store.readPartial()).resolves.toEqual({})
  })

  it('replaces an invalid file on write, but does not hide other errors', async () => {
    const { home } = await createSandbox()
    const store = new ConfigStore(home)

    await writeFile(store.path, 'garbage')
    await store.write({ repoUrl: 'u', folderPath: '/f' })
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual({
      repo_url: 'u',
      folder_path: '/f',
    })

    await rm(store.path)
    await mkdir(store.path)
    await expect(store.write({ repoUrl: 'u', folderPath: '/f' })).rejects.toThrow(/Cannot read/)
  })
})

describe('redactUrl', () => {
  it.each([
    ['https://user:token@github.com/a/b.git', 'https://***:***@github.com/a/b.git'],
    ['https://token@github.com/a/b.git', 'https://***@github.com/a/b.git'],
    ['https://github.com/a/b.git', 'https://github.com/a/b.git'],
    ['git@github.com:a/b.git', 'git@github.com:a/b.git'],
    ['ssh://git@github.com/a/b.git', 'ssh://git@github.com/a/b.git'],
    ['/local/path', '/local/path'],
  ])('%s', (url, expected) => {
    expect(redactUrl(url)).toBe(expected)
  })
})

describe('ConfigStore.readHistorySize', () => {
  it.each([
    [undefined, 1024 * 1024],
    [0, 0],
    [2048, 2048],
    ['512KB', 512 * 1024],
    ['5 MB', 5 * 1024 * 1024],
    ['1gb', 1024 ** 3],
    ['100', 100],
  ])('reads %o as %i bytes', async (value, expected) => {
    const sandbox = await createSandbox()
    await sandbox.configure(value === undefined ? {} : { history_max_size: value })

    await expect(new ConfigStore(sandbox.home).readHistorySize()).resolves.toEqual({
      maxBytes: expected,
      warning: null,
    })
  })

  it.each([-1, 1.5, 'big', '5 TB', true])(
    'falls back to 1MB with a warning for %o',
    async value => {
      const sandbox = await createSandbox()
      await sandbox.configure({ history_max_size: value })

      const result = await new ConfigStore(sandbox.home).readHistorySize()

      expect(result.maxBytes).toBe(1024 * 1024)
      expect(result.warning).toContain('"history_max_size"')
    },
  )

  it('works without a configuration, or with an invalid one', async () => {
    const { home } = await createSandbox()
    const store = new ConfigStore(home)
    await expect(store.readHistorySize()).resolves.toEqual({ maxBytes: 1024 * 1024, warning: null })

    await writeFile(store.path, 'not json')
    await expect(store.readHistorySize()).resolves.toEqual({ maxBytes: 1024 * 1024, warning: null })
  })
})
