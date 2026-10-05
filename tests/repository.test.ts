import { chmod, mkdir, symlink } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CliError } from '../src/errors.ts'
import { listModules, listScripts, type Module, type Script } from '../src/repository.ts'
import { createSandbox, type Sandbox } from './helpers.ts'

const settings = (files: unknown) => JSON.stringify({ files })

async function modulesOf(sandbox: Sandbox) {
  const warnings: string[] = []
  const modules = await listModules(sandbox.repo, {
    ...sandbox,
    warn: message => warnings.push(message),
  })
  return { modules, warnings }
}

/** The module, which must have a usable settings.json. */
function usable(module: Module | undefined) {
  if (module == null || module.error != null) throw new Error(`unusable module: ${module?.error}`)
  return module
}

async function scriptsOf(
  sandbox: Sandbox,
  extensions: readonly string[] | null = null,
  platform: NodeJS.Platform = 'linux',
) {
  const warnings: string[] = []
  const scripts = await listScripts(sandbox.repo, extensions, platform, {
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
    const zsh = usable(modules[0])
    const repository = sandbox.repo
    const module = path.join(sandbox.repo, 'files/zsh')

    expect(zsh.files).toEqual([
      {
        source: path.join(sandbox.repo, 'files/zsh/zshrc'),
        target: path.join(sandbox.home, '.zshrc'),
        strategy: 'global',
        repository,
        module,
        entry: { module: 'files/zsh', source: 'zshrc', target: '~/.zshrc', folder: sandbox.home },
      },
      {
        source: path.join(sandbox.repo, 'files/zsh/local.env'),
        target: path.join(sandbox.cwd, '.env'),
        strategy: 'local',
        repository,
        module,
        entry: { module: 'files/zsh', source: 'local.env', target: '.env', folder: sandbox.cwd },
      },
      {
        source: path.join(sandbox.repo, 'files/zsh/aliases'),
        target: path.join(sandbox.home, '.aliases'),
        strategy: 'global',
        repository,
        module,
        entry: {
          module: 'files/zsh',
          source: 'aliases',
          target: '~/.aliases',
          folder: sandbox.home,
        },
      },
      {
        source: path.join(sandbox.repo, 'files/zsh/editorconfig'),
        target: path.join(sandbox.cwd, '.editorconfig'),
        strategy: 'local',
        repository,
        module,
        entry: {
          module: 'files/zsh',
          source: 'editorconfig',
          target: '.editorconfig',
          folder: sandbox.cwd,
        },
      },
    ])
    expect(zsh.undecided).toEqual(['forgotten'])
    expect(zsh.invalidEntries).toEqual([])
    expect(zsh.deprecations).toEqual([
      '"global": true | false is deprecated and will stop working in 2.0. ' +
        'Use "deploy": "global" | "local" instead',
    ])
    expect(warnings).toEqual([])
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

    expect(usable(modules[0]).files.map(file => file.target)).toEqual([
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
  ])('reports an invalid entry: %o', async (entry, reason) => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      settings([{ source_path: 'zshrc', target_path: '~/.zshrc', ...entry }]),
    )

    const { modules } = await modulesOf(sandbox)
    const zsh = usable(modules[0])

    expect(zsh).toMatchObject({ files: [], undecided: [] })
    expect(zsh.invalidEntries).toEqual([expect.stringMatching(/^entry #1 is ignored: .+$/)])
    expect(zsh.invalidEntries[0]).toContain(reason)
  })

  it.each([
    ['~', 'global', 'would replace the home folder'],
    ['..', 'global', 'would replace the home folder'],
    ['/', 'global', 'would replace the home folder'],
    ['.', 'local', 'would replace the current folder'],
    ['~/dotfiles', 'global', 'would replace the dotfiles repository'],
    ['~/dotfiles/files', 'global', 'would replace the module folder'],
    ['~/dotfiles/files/zsh/zshrc', 'global', 'is inside the dotfiles repository'],
    ['~/.configfilerc', 'global', "would replace configfile's configuration"],
    ['~/.configfile', 'global', "would replace configfile's working folder"],
    ['~/.configfile/state.json', 'global', "is inside configfile's working folder"],
  ])('refuses the dangerous target_path %s (%s)', async (target, deploy, reason) => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      settings([{ source_path: 'zshrc', target_path: target, deploy }]),
    )

    const { modules } = await modulesOf(sandbox)
    const zsh = usable(modules[0])

    expect(zsh.files).toEqual([])
    expect(zsh.invalidEntries[0]).toContain(reason)
  })

  it.each(['../zshrc', '../../../Documents', '/etc/hosts', '.', 'sub/../../other/zshrc'])(
    'refuses a source_path outside the module folder: %s',
    async source => {
      const sandbox = await createSandbox()
      await sandbox.write(
        'home/dotfiles/files/zsh/settings.json',
        settings([{ source_path: source, target_path: '~/.zshrc', deploy: 'global' }]),
      )

      const { modules } = await modulesOf(sandbox)
      const zsh = usable(modules[0])

      expect(zsh.files).toEqual([])
      expect(zsh.invalidEntries[0]).toContain('must name a file or folder inside the module folder')
    },
  )

  it('accepts sources in subfolders of the module', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      settings([{ source_path: 'conf/./zshrc', target_path: '~/.zshrc', deploy: 'global' }]),
    )

    const { modules } = await modulesOf(sandbox)

    expect(usable(modules[0]).files[0]?.source).toBe(
      path.join(sandbox.repo, 'files/zsh/conf/zshrc'),
    )
  })

  it('reads the configfile 0.3.1 list format, with a deprecation', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      JSON.stringify([{ source_path: 'zshrc', target_path: '~/.zshrc', global: true }]),
    )

    const { modules } = await modulesOf(sandbox)
    const zsh = usable(modules[0])

    expect(zsh.files.map(file => file.target)).toEqual([path.join(sandbox.home, '.zshrc')])
    expect(zsh.deprecations).toEqual([
      expect.stringContaining('settings.json is a list (configfile 0.3 format)'),
      expect.stringContaining('"global": true | false is deprecated'),
    ])
  })

  it('refuses a target that contains the repository', async () => {
    const sandbox = await createSandbox()
    // The repository lives in ~/.config/dot and a module targets ~/.config.
    await sandbox.write(
      'home/.config/dot/files/cfg/settings.json',
      settings([{ source_path: 'config', target_path: '~/.config', deploy: 'global' }]),
    )

    const modules = await listModules(path.join(sandbox.home, '.config/dot'), {
      ...sandbox,
      warn: () => {},
    })

    expect(usable(modules[0]).invalidEntries[0]).toContain('would replace the dotfiles repository')
  })

  it('refuses local targets inside the repository, when run from it', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/app/settings.json',
      settings([{ source_path: 'config.json', target_path: 'config.json', deploy: 'local' }]),
    )

    const modules = await listModules(sandbox.repo, {
      ...sandbox,
      cwd: path.join(sandbox.repo, 'files/app'),
      warn: () => {},
    })

    expect(usable(modules[0]).invalidEntries[0]).toContain('is inside the dotfiles repository')
  })

  it('keeps modules with an unusable settings.json, with the reason', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/broken/settings.json', '{')
    await sandbox.write('home/dotfiles/files/nofiles/settings.json', '{}')

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules).toEqual([
      expect.objectContaining({ name: 'broken', error: expect.stringContaining('not valid JSON') }),
      expect.objectContaining({ name: 'nofiles', error: 'settings.json has no "files" list' }),
    ])
    expect(modules[0]).not.toHaveProperty('files')
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
  it('lists every file by default, named up to the first dot (as in 0.3)', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/setup.sh')
    await sandbox.write('home/dotfiles/scripts/install.node.js')
    await sandbox.write('home/dotfiles/scripts/bootstrap')
    await sandbox.write('home/dotfiles/scripts/tool.py')

    const { scripts } = await scriptsOf(sandbox)

    expect(scripts.map(script => [script.name, script.file])).toEqual([
      ['bootstrap', 'bootstrap'],
      ['install', 'install.node.js'],
      ['setup', 'setup.sh'],
      ['tool', 'tool.py'],
    ])
  })

  it('only lists files with one of script_extensions when it is set', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/setup.sh')
    await sandbox.write('home/dotfiles/scripts/bootstrap')
    await sandbox.write('home/dotfiles/scripts/notes.shell.txt')
    await sandbox.write('home/dotfiles/scripts/tool.py')
    await sandbox.write('home/dotfiles/scripts/macos/index.sh')
    await sandbox.write('home/dotfiles/scripts/linux/index.py')

    const { scripts } = await scriptsOf(sandbox, ['.sh', ''])

    expect(scripts.map(script => script.file)).toEqual([
      'bootstrap',
      path.join('macos', 'index.sh'),
      'setup.sh',
    ])
  })

  it("uses this system's version of a script instead of the generic one", async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/setup.sh')
    await sandbox.write('home/dotfiles/scripts/setup.macos.sh')
    await sandbox.write('home/dotfiles/scripts/setup.linux.py')
    await sandbox.write('home/dotfiles/scripts/clean.linux.sh')
    await sandbox.write('home/dotfiles/scripts/brew.macos/index.sh')

    const files = (scripts: Script[]) => scripts.map(script => [script.name, script.file])

    const mac = await scriptsOf(sandbox, null, 'darwin')
    expect(files(mac.scripts)).toEqual([
      ['brew', path.join('brew.macos', 'index.sh')],
      ['setup', 'setup.macos.sh'],
    ])
    expect(mac.warnings).toEqual([])

    const linux = await scriptsOf(sandbox, null, 'linux')
    expect(files(linux.scripts)).toEqual([
      ['clean', 'clean.linux.sh'],
      ['setup', 'setup.linux.py'],
    ])
    expect(linux.warnings).toEqual([])
  })

  it('falls back to the generic script when there is no version for this system', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/setup.sh')
    await sandbox.write('home/dotfiles/scripts/setup.macos.sh')
    await sandbox.write('home/dotfiles/scripts/setup.constructor.sh')

    const { scripts, warnings } = await scriptsOf(sandbox, null, 'linux')

    // "constructor" is not a system: setup.constructor.sh is another generic setup.
    expect(scripts.map(script => script.file)).toEqual(['setup.constructor.sh'])
    expect(warnings).toEqual(['"setup.sh" is ignored: another script is already named "setup".'])
  })

  it('warns about two versions of a script for the same system', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/setup.macos.py')
    await sandbox.write('home/dotfiles/scripts/setup.macos.sh')

    const { scripts, warnings } = await scriptsOf(sandbox, null, 'darwin')

    expect(scripts.map(script => script.file)).toEqual(['setup.macos.py'])
    expect(warnings).toEqual([
      '"setup.macos.sh" is ignored: another script is already named "setup".',
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
    await sandbox.write('home/dotfiles/scripts/plain/index')
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
        name: 'plain',
        file: path.join('plain', 'index'),
        path: path.join(sandbox.repo, 'scripts', 'plain', 'index'),
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

  it.skipIf(process.getuid?.() === 0)(
    'warns about a script folder that cannot be read',
    async () => {
      const sandbox = await createSandbox()
      await sandbox.write('home/dotfiles/scripts/setup/index.sh')
      await chmod(path.join(sandbox.repo, 'scripts/setup'), 0o000)

      try {
        const { scripts, warnings } = await scriptsOf(sandbox)

        expect(scripts).toEqual([])
        expect(warnings[0]).toContain('cannot be read')
      } finally {
        await chmod(path.join(sandbox.repo, 'scripts/setup'), 0o755)
      }
    },
  )

  it('respects custom extensions', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/scripts/tool.py')
    await sandbox.write('home/dotfiles/scripts/setup.sh')

    const { scripts } = await scriptsOf(sandbox, ['.py'])

    expect(scripts.map(script => script.name)).toEqual(['tool'])
  })
})
