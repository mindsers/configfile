import { mkdir, symlink } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_SCRIPT_EXTENSIONS } from '../src/config.js'
import { CliError } from '../src/errors.js'
import { listModules, listScripts } from '../src/repository.js'
import { createSandbox, type Sandbox } from './helpers.js'

const settings = (files: unknown) => JSON.stringify({ files })

async function modulesOf(sandbox: Sandbox) {
  const warnings: string[] = []
  const modules = await listModules(sandbox.repo, {
    ...sandbox,
    warn: message => warnings.push(message),
  })
  return { modules, warnings }
}

async function scriptsOf(sandbox: Sandbox, extensions = DEFAULT_SCRIPT_EXTENSIONS) {
  const warnings: string[] = []
  const scripts = await listScripts(sandbox.repo, extensions, {
    warn: message => warnings.push(message),
  })
  return { scripts, warnings }
}

describe('listModules', () => {
  it('lists folders of files/ that have a settings.json, with slugified names', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/My Zsh/settings.json', settings([]))
    await sandbox.write('home/dotfiles/files/git/settings.json', settings([]))
    await sandbox.write('home/dotfiles/files/no-settings/file', '')
    await sandbox.write('home/dotfiles/files/.hidden/settings.json', settings([]))
    await sandbox.write('home/dotfiles/files/.DS_Store', '')

    const { modules } = await modulesOf(sandbox)

    expect(modules.map(module => module.name)).toEqual(['git', 'my-zsh'])
  })

  it('follows symlinks to module folders', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('elsewhere/zsh/settings.json', settings([]))
    await mkdir(path.join(sandbox.repo, 'files'), { recursive: true })
    await symlink(path.join(sandbox.root, 'elsewhere/zsh'), path.join(sandbox.repo, 'files/zsh'))

    const { modules } = await modulesOf(sandbox)

    expect(modules.map(module => module.name)).toEqual(['zsh'])
  })

  it('warns about broken symlinks, duplicate and empty names', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/Foo Bar/settings.json', settings([]))
    await sandbox.write('home/dotfiles/files/foo-bar/settings.json', settings([]))
    await sandbox.write('home/dotfiles/files/@@@/settings.json', settings([]))
    await symlink(path.join(sandbox.root, 'nowhere'), path.join(sandbox.repo, 'files/broken'))

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules.map(module => module.name)).toEqual(['foo-bar'])
    expect(warnings).toEqual([
      expect.stringContaining('"@@@" has no usable module name'),
      expect.stringContaining('broken is a broken symbolic link'),
      expect.stringContaining('another module is already named "foo-bar"'),
    ])
  })

  it('resolves source and target paths with their deployment strategy', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      settings([
        { source_path: 'zshrc', target_path: '~/.zshrc', global: true },
        { source_path: 'local.env', target_path: '.env', global: false },
        { source_path: 'aliases', target_path: '~/.aliases', deploy: 'global' },
        { source_path: 'editorconfig', target_path: '.editorconfig', deploy: 'local' },
        { source_path: 'parked', target_path: '~/.parked', deploy: 'none' },
        { source_path: 'forgotten', target_path: '~/.forgotten' },
      ]),
    )

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules[0]?.files).toEqual([
      {
        source: path.join(sandbox.repo, 'files/zsh/zshrc'),
        target: path.join(sandbox.home, '.zshrc'),
        strategy: 'global',
      },
      {
        source: path.join(sandbox.repo, 'files/zsh/local.env'),
        target: path.join(sandbox.cwd, '.env'),
        strategy: 'local',
      },
      {
        source: path.join(sandbox.repo, 'files/zsh/aliases'),
        target: path.join(sandbox.home, '.aliases'),
        strategy: 'global',
      },
      {
        source: path.join(sandbox.repo, 'files/zsh/editorconfig'),
        target: path.join(sandbox.cwd, '.editorconfig'),
        strategy: 'local',
      },
    ])
    expect(modules[0]?.undecided).toEqual(['forgotten'])
    expect(modules[0]?.error).toBeNull()
    expect(warnings).toEqual([
      'Module "zsh": "global": true | false is deprecated and will stop working in 2.0. ' +
        'Use "deploy": "global" | "local" instead.',
    ])
  })

  it('resolves relative global targets against the home folder, local ones against the current folder', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      settings([
        { source_path: 'zshrc', target_path: '.zshrc', deploy: 'global' },
        { source_path: 'env', target_path: '.env', deploy: 'local' },
      ]),
    )

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules[0]?.files.map(file => file.target)).toEqual([
      path.join(sandbox.home, '.zshrc'),
      path.join(sandbox.cwd, '.env'),
    ])
    expect(warnings).toEqual([])
  })

  it.each([
    [{ deploy: 'symlink' }, 'use "deploy": "global", "local" or "none"'],
    [{ global: 'yes' }, 'use "deploy": "global", "local" or "none"'],
    [{ deploy: 'local', global: true }, 'not both'],
    [{ deploy: 'global', source_path: '' }, '"source_path" is missing'],
    [{ deploy: 'global', target_path: '' }, '"target_path" is missing'],
  ])('warns about an invalid entry: %o', async (entry, reason) => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      settings([{ source_path: 'zshrc', target_path: '~/.zshrc', ...entry }]),
    )

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules[0]).toMatchObject({ files: [], undecided: [] })
    expect(warnings).toEqual([
      expect.stringMatching(/^Entry #1 of the "zsh" module settings is ignored: .+\.$/),
    ])
    expect(warnings[0]).toContain(reason)
  })

  it.each(['~', '~/', '.', '..', '/'])(
    'refuses a target_path that would replace the home or current folder: %s',
    async target => {
      const sandbox = await createSandbox()
      await sandbox.write(
        'home/dotfiles/files/zsh/settings.json',
        settings([{ source_path: 'zshrc', target_path: target, deploy: 'global' }]),
      )

      const { modules, warnings } = await modulesOf(sandbox)

      expect(modules[0]?.files).toEqual([])
      expect(warnings[0]).toContain('would replace')
    },
  )

  it('keeps modules with an unusable settings.json, with the reason', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/broken/settings.json', '{')
    await sandbox.write('home/dotfiles/files/nofiles/settings.json', '{}')

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules).toMatchObject([
      { name: 'broken', files: [], error: expect.stringContaining('not valid JSON') },
      { name: 'nofiles', files: [], error: 'settings.json has no "files" list' },
    ])
    expect(warnings).toEqual([])
  })

  it('returns nothing when files/ does not exist', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/README.md')

    await expect(modulesOf(sandbox)).resolves.toMatchObject({ modules: [] })
  })

  it('fails when the repository folder does not exist or is a file', async () => {
    const sandbox = await createSandbox()
    await expect(modulesOf(sandbox)).rejects.toThrow(/does not exist/)

    await sandbox.write('home/dotfiles', 'not a folder')
    await expect(modulesOf(sandbox)).rejects.toThrow(CliError)
    await expect(modulesOf(sandbox)).rejects.toThrow(/is not a folder/)
  })
})

describe('listScripts', () => {
  it('only lists files with an allowed extension', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/setup.sh')
    await sandbox.write('home/dotfiles/scripts/install.js')
    await sandbox.write('home/dotfiles/scripts/bootstrap')
    await sandbox.write('home/dotfiles/scripts/notes.shell.txt')
    await sandbox.write('home/dotfiles/scripts/tool.py')

    const { scripts } = await scriptsOf(sandbox)

    expect(scripts.map(script => [script.name, script.file])).toEqual([
      ['bootstrap', 'bootstrap'],
      ['install', 'install.js'],
      ['setup', 'setup.sh'],
    ])
  })

  it('ignores hidden files', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/.DS_Store')
    await sandbox.write('home/dotfiles/scripts/.env.sh')

    await expect(scriptsOf(sandbox)).resolves.toMatchObject({ scripts: [] })
  })

  it('lists folders that contain an index script, also through symlinks', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/Mac OS/index.sh')
    await sandbox.write('home/dotfiles/scripts/empty/README.md')
    await sandbox.write('elsewhere/tools/index.sh')
    await symlink(
      path.join(sandbox.root, 'elsewhere/tools'),
      path.join(sandbox.repo, 'scripts/tools'),
    )

    const { scripts } = await scriptsOf(sandbox)

    expect(scripts).toEqual([
      {
        name: 'mac-os',
        file: path.join('Mac OS', 'index.sh'),
        path: path.join(sandbox.repo, 'scripts', 'Mac OS', 'index.sh'),
      },
      {
        name: 'tools',
        file: path.join('tools', 'index.sh'),
        path: path.join(sandbox.repo, 'scripts', 'tools', 'index.sh'),
      },
    ])
  })

  it('keeps the first of two scripts with the same name and warns', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/dup.js')
    await sandbox.write('home/dotfiles/scripts/dup.sh')

    const { scripts, warnings } = await scriptsOf(sandbox)

    expect(scripts.map(script => script.file)).toEqual(['dup.js'])
    expect(warnings).toEqual(['"dup.sh" is ignored: another script is already named "dup".'])
  })

  it('respects custom extensions', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/tool.py')
    await sandbox.write('home/dotfiles/scripts/setup.sh')

    const { scripts } = await scriptsOf(sandbox, ['.py'])

    expect(scripts.map(script => script.name)).toEqual(['tool'])
  })
})
