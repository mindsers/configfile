import { chmod, mkdir, readFile, symlink } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CliError } from '../src/errors.ts'
import {
  listModules,
  listScripts,
  type Module,
  type Script,
  systemName,
} from '../src/repository.ts'
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

/** The module, which must have usable settings. */
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
  const { scripts, otherSystems } = await listScripts(sandbox.repo, extensions, platform, {
    warn: message => warnings.push(message),
  })
  return { scripts, otherSystems, warnings }
}

describe('listModules', () => {
  it('lists folders of files/ that have a configfile.module.json, with slugified names', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/My Zsh/settings.json', settings([]))
    await sandbox.write('home/dotfiles/files/git/configfile.module.json', settings([]))
    await sandbox.write('home/dotfiles/files/no-settings/file', '')
    await sandbox.write('home/dotfiles/files/.hidden/configfile.module.json', settings([]))
    await sandbox.write('home/dotfiles/files/.DS_Store', '')

    const { modules } = await modulesOf(sandbox)

    expect(modules.map(module => module.name)).toEqual(['git', 'my-zsh'])
  })

  it('follows symlinks to module folders', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('elsewhere/zsh/configfile.module.json', settings([]))
    await mkdir(path.join(sandbox.repo, 'files'), { recursive: true })
    await symlink(path.join(sandbox.root, 'elsewhere/zsh'), path.join(sandbox.repo, 'files/zsh'))

    const { modules } = await modulesOf(sandbox)

    expect(modules.map(module => module.name)).toEqual(['zsh'])
  })

  it('warns about broken symlinks, duplicate and empty names', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/Foo Bar/settings.json', settings([]))
    await sandbox.write('home/dotfiles/files/foo-bar/configfile.module.json', settings([]))
    await sandbox.write('home/dotfiles/files/@@@/configfile.module.json', settings([]))
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
      'home/dotfiles/files/zsh/configfile.module.json',
      settings([
        { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
        { source_path: 'local.env', target_path: '.env', deploy: 'local' },
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
        method: 'copy',
        repository,
        module,
        entry: { module: 'files/zsh', source: 'zshrc', target: '~/.zshrc', folder: sandbox.home },
      },
      {
        source: path.join(sandbox.repo, 'files/zsh/local.env'),
        target: path.join(sandbox.cwd, '.env'),
        strategy: 'local',
        method: 'copy',
        repository,
        module,
        entry: { module: 'files/zsh', source: 'local.env', target: '.env', folder: sandbox.cwd },
      },
      {
        source: path.join(sandbox.repo, 'files/zsh/aliases'),
        target: path.join(sandbox.home, '.aliases'),
        strategy: 'global',
        method: 'copy',
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
        method: 'copy',
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
    expect(warnings).toEqual([])
  })

  it('copies global files unless they ask for a link, and refuses links for local files', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/configfile.module.json',
      settings([
        { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global', method: 'link' },
        { source_path: 'aliases', target_path: '~/.aliases', deploy: 'global', method: 'copy' },
        { source_path: 'env', target_path: '.env', deploy: 'local', method: 'copy' },
        { source_path: 'rc', target_path: '.rc', deploy: 'local', method: 'link' },
        { source_path: 'other', target_path: '~/.other', deploy: 'global', method: 'symlink' },
      ]),
    )

    const zsh = usable((await modulesOf(sandbox)).modules[0])

    expect(zsh.files.map(file => [file.entry?.source, file.method])).toEqual([
      ['zshrc', 'link'],
      ['aliases', 'copy'],
      ['env', 'copy'],
    ])
    expect(zsh.invalidEntries).toEqual([
      'entry #4 is ignored: "method": "link" only applies to global files (local files are always copied)',
      'entry #5 is ignored: use "method": "link" or "copy"',
    ])
  })

  it('resolves relative global targets against the home folder, local ones against the current folder', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/configfile.module.json',
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
    [{ global: true }, '"global" is no longer read (configfile 2.0): use "deploy"'],
    [{ deploy: 'local', global: true }, '"global" is no longer read'],
    [{ deploy: 'global', source_path: '' }, '"source_path" is missing'],
    [{ deploy: 'global', target_path: '' }, '"target_path" is missing'],
  ])('reports an invalid entry: %o', async (entry, reason) => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/configfile.module.json',
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
      'home/dotfiles/files/zsh/configfile.module.json',
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
        'home/dotfiles/files/zsh/configfile.module.json',
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
      'home/dotfiles/files/zsh/configfile.module.json',
      settings([{ source_path: 'conf/./zshrc', target_path: '~/.zshrc', deploy: 'global' }]),
    )

    const { modules } = await modulesOf(sandbox)

    expect(usable(modules[0]).files[0]?.source).toBe(
      path.join(sandbox.repo, 'files/zsh/conf/zshrc'),
    )
  })

  it('refuses the configfile 0.3 list format, and says how to fix it', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zsh/configfile.module.json',
      JSON.stringify([{ source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' }]),
    )

    const { modules } = await modulesOf(sandbox)

    expect(modules[0]?.error).toBe(
      'configfile.module.json is a list, the format of configfile 0.3, which 2.0 no longer reads. ' +
        'Put the list in a "files" key: { "files": [ ... ] }',
    )
  })

  it('reads the scripts to run before and after the module is deployed', async () => {
    const sandbox = await createSandbox()
    const write = (module: string, content: unknown) =>
      sandbox.write(`home/dotfiles/files/${module}/configfile.module.json`, JSON.stringify(content))
    await write('a', { files: [], pre_deploy: 'check', post_deploy: ' plugins ' })
    await write('b', { files: [] })
    await write('c', { files: [], pre_deploy: '', post_deploy: 42 })

    const { modules } = await modulesOf(sandbox)

    expect(modules.map(usable)).toMatchObject([
      { hooks: { pre_deploy: 'check', post_deploy: 'plugins' }, hookProblems: {} },
      { hooks: {}, hookProblems: {} },
      {
        hooks: {},
        hookProblems: {
          pre_deploy: expect.stringContaining('"pre_deploy" is ignored'),
          post_deploy: expect.stringContaining('"post_deploy" is ignored'),
        },
      },
    ])
  })

  it('refuses a target that contains the repository', async () => {
    const sandbox = await createSandbox()
    // The repository lives in ~/.config/dot and a module targets ~/.config.
    await sandbox.write(
      'home/.config/dot/files/cfg/configfile.module.json',
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
      'home/dotfiles/files/app/configfile.module.json',
      settings([{ source_path: 'config.json', target_path: 'config.json', deploy: 'local' }]),
    )

    const modules = await listModules(sandbox.repo, {
      ...sandbox,
      cwd: path.join(sandbox.repo, 'files/app'),
      warn: () => {},
    })

    expect(usable(modules[0]).invalidEntries[0]).toContain('is inside the dotfiles repository')
  })

  it('keeps modules with unusable settings, with the reason', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/broken/configfile.module.json', '{')
    await sandbox.write('home/dotfiles/files/nofiles/configfile.module.json', '{}')

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules).toEqual([
      expect.objectContaining({ name: 'broken', error: expect.stringContaining('not valid JSON') }),
      expect.objectContaining({
        name: 'nofiles',
        error: 'configfile.module.json has no "files" list',
      }),
    ])
    expect(modules[0]).not.toHaveProperty('files')
    expect(warnings).toEqual([])
  })

  it("lets a module deploy an app's own settings.json", async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/files/zed/configfile.module.json',
      settings([
        {
          source_path: 'settings.json',
          target_path: '~/.config/zed/settings.json',
          deploy: 'global',
        },
      ]),
    )
    await sandbox.write('home/dotfiles/files/zed/settings.json', '{ "theme": "One Dark" }')

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules.map(module => module.name)).toEqual(['zed'])
    expect(usable(modules[0]).files.map(file => file.source)).toEqual([
      path.join(sandbox.repo, 'files/zed/settings.json'),
    ])
    expect(warnings).toEqual([])
  })

  it('says how to rename the settings.json of a configfile 1.x module', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/zsh/settings.json', settings([]))
    await sandbox.write('home/dotfiles/files/old/settings.json', '[]')
    // An app's own settings.json, in a folder that is not a module.
    await sandbox.write('home/dotfiles/files/zed/settings.json', '{ "theme": "One Dark" }')

    const { modules } = await modulesOf(sandbox)

    expect(modules.map(module => [module.name, module.error])).toEqual([
      [
        'old',
        "it has settings.json, but this repository's modules are described by " +
          'configfile.module.json: rename it ("git mv files/old/settings.json ' +
          'files/old/configfile.module.json" in your working copy), or set "module_settings": ' +
          '"settings.json" in configfile.repository.json',
      ],
      [
        'zsh',
        expect.stringContaining(
          '"git mv files/zsh/settings.json files/zsh/configfile.module.json"',
        ),
      ],
    ])
  })

  it('reads the modules with the settings file the repository names', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/configfile.repository.json',
      JSON.stringify({
        $schema: 'https://docs.configfile.sh/schemas/repository.json',
        module_settings: 'settings.json',
      }),
    )
    await sandbox.write('home/dotfiles/files/zsh/settings.json', settings([]))
    await sandbox.write('home/dotfiles/files/nofiles/settings.json', '{}')
    await sandbox.write('home/dotfiles/files/other/configfile.module.json', settings([]))

    const { modules } = await modulesOf(sandbox)

    expect(modules.map(module => [module.name, module.error, module.settingsFile])).toEqual([
      ['nofiles', 'settings.json has no "files" list', 'settings.json'],
      [
        'other',
        "it has configfile.module.json, but this repository's modules are described by " +
          'settings.json: rename it ("git mv files/other/configfile.module.json ' +
          'files/other/settings.json" in your working copy), or set "module_settings": ' +
          '"configfile.module.json" in configfile.repository.json',
        'settings.json',
      ],
      ['zsh', null, 'settings.json'],
    ])
  })

  it('warns about settings under another name that it cannot read, instead of skipping them', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/broken/settings.json', '<<<<<<< HEAD\n')
    await sandbox.write('home/dotfiles/files/typo/settings.json', '{ "file": [] }')
    await sandbox.write('home/dotfiles/files/unreadable/settings.json/x')

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules).toEqual([])
    const file = (folder: string) => path.join(sandbox.repo, `files/${folder}/settings.json`)
    expect(warnings).toEqual([
      `${file('broken')} is not read: this repository's modules are described by ` +
        'configfile.module.json. If it holds the settings of a module, fix it (not valid JSON: ' +
        `${warnings[0]?.match(/not valid JSON: (.*)\), then/)?.[1]}), then rename it to configfile.module.json.`,
      `${file('typo')} is not read: this repository's modules are described by ` +
        'configfile.module.json. If it holds the settings of a module, fix it (it has no "files" ' +
        'list), then rename it to configfile.module.json.',
      expect.stringContaining(`${file('unreadable')} is not read`),
    ])
    expect(warnings[2]).toContain('(cannot be read: EISDIR)')
  })

  it('refuses a configfile.repository.json that cannot be read or is a broken link', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/zsh/configfile.module.json', settings([]))
    await mkdir(path.join(sandbox.repo, 'configfile.repository.json'))

    await expect(modulesOf(sandbox)).rejects.toThrow('Cannot read')

    const other = await createSandbox()
    await other.write('home/dotfiles/files/zsh/configfile.module.json', settings([]))
    await symlink(
      path.join(other.root, 'nowhere.json'),
      path.join(other.repo, 'configfile.repository.json'),
    )

    await expect(modulesOf(other)).rejects.toThrow('is a broken symbolic link')
  })

  it.each([
    ['an unknown key', '{ "hooks": {} }', 'has "hooks", which configfile'],
    [
      'a folder in the name',
      '{ "module_settings": "a/b.json" }',
      'must be the name of a JSON file',
    ],
    [
      'a name that is not JSON',
      '{ "module_settings": "module.yaml" }',
      'must be the name of a JSON file',
    ],
    [
      'its own name',
      '{ "module_settings": "configfile.repository.json" }',
      'must be the name of a JSON file',
    ],
    ['a name that is not a string', '{ "module_settings": 1 }', 'must be the name of a JSON file'],
    ['a list', '[]', 'is not a JSON object.'],
    ['invalid JSON', '{', 'is not valid JSON'],
  ])('refuses repository settings with %s', async (_, content, message) => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/configfile.repository.json', content)
    await sandbox.write('home/dotfiles/files/zsh/configfile.module.json', settings([]))

    await expect(modulesOf(sandbox)).rejects.toThrow(message)
  })

  it('quotes the rename hint for the shell, and says where to rename through a link', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/My Zsh.d/settings.json', settings([]))
    await sandbox.write('elsewhere/git/settings.json', settings([]))
    await symlink(path.join(sandbox.root, 'elsewhere/git'), path.join(sandbox.repo, 'files/git'))

    const { modules } = await modulesOf(sandbox)

    expect(modules.map(module => module.error)).toEqual([
      expect.stringContaining('rename it to configfile.module.json where files/git links to,'),
      expect.stringContaining(
        `"git mv 'files/My Zsh.d/settings.json' 'files/My Zsh.d/configfile.module.json'"`,
      ),
    ])
  })

  it('says when the settings of a module, or a file under another name, are a broken link', async () => {
    const sandbox = await createSandbox()
    await mkdir(path.join(sandbox.repo, 'files/zsh'), { recursive: true })
    await symlink(
      path.join(sandbox.root, 'nowhere.json'),
      path.join(sandbox.repo, 'files/zsh/configfile.module.json'),
    )
    await mkdir(path.join(sandbox.repo, 'files/old'), { recursive: true })
    await symlink(
      path.join(sandbox.root, 'nowhere.json'),
      path.join(sandbox.repo, 'files/old/settings.json'),
    )

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules.map(module => [module.name, module.error])).toEqual([
      ['zsh', 'configfile.module.json cannot be read (a broken symbolic link)'],
    ])
    expect(warnings).toEqual([
      expect.stringContaining('fix it (it is a broken symbolic link), then rename it'),
    ])
  })

  it('prefers the settings of a module among the other names, when the repository names its own', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(
      'home/dotfiles/configfile.repository.json',
      JSON.stringify({ module_settings: 'dot.json' }),
    )
    await sandbox.write('home/dotfiles/files/zsh/configfile.module.json', '{')
    await sandbox.write('home/dotfiles/files/zsh/settings.json', settings([]))

    const { modules, warnings } = await modulesOf(sandbox)

    expect(modules[0]?.error).toContain(
      "it has settings.json, but this repository's modules are described by dot.json",
    )
    expect(warnings).toEqual([])
  })

  it('names its own version when the repository settings have a key it does not know', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/configfile.repository.json', '{ "hooks": {} }')
    const { version } = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }

    await expect(modulesOf(sandbox)).rejects.toThrow(
      `has "hooks", which configfile ${version} doesn't know`,
    )
  })

  it('quotes an apostrophe in the rename hint', async () => {
    const sandbox = await createSandbox()
    await sandbox.write("home/dotfiles/files/Bob's zsh/settings.json", settings([]))

    const { modules } = await modulesOf(sandbox)

    expect(modules[0]?.error).toContain(
      `"git mv 'files/Bob'\\''s zsh/settings.json' 'files/Bob'\\''s zsh/configfile.module.json'"`,
    )
  })

  it('says when the settings of a module cannot be read, apart from invalid JSON', async () => {
    const sandbox = await createSandbox()
    await mkdir(path.join(sandbox.repo, 'files/zsh/configfile.module.json'), { recursive: true })

    const { modules } = await modulesOf(sandbox)

    expect(modules[0]?.error).toBe('configfile.module.json cannot be read (EISDIR)')
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

describe('systemName', () => {
  it('names systems as script versions do', () => {
    expect(systemName('darwin')).toBe('macos')
    expect(systemName('linux')).toBe('linux')
    expect(systemName('freebsd')).toBe('freebsd')
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

describe('"when" conditions', () => {
  async function loadFor(sandbox: Sandbox, machine: { os: string; profiles: readonly string[] }) {
    return listModules(sandbox.repo, { ...sandbox, warn: () => {}, machine })
  }

  it('keeps the entries for this machine, and says why the others are not', async () => {
    const sandbox = await createSandbox()
    for (const name of ['mac', 'linux', 'work', 'any']) {
      await sandbox.write(`home/dotfiles/files/m/${name}`)
    }
    const entry = (name: string, when?: unknown) => ({
      source_path: name,
      target_path: `~/.${name}`,
      deploy: 'global',
      ...(when !== undefined && { when }),
    })
    await sandbox.write(
      'home/dotfiles/files/m/configfile.module.json',
      settings([
        entry('mac', { os: 'macos' }),
        entry('linux', { os: ['linux'] }),
        entry('work', { os: ['macos', 'linux'], profiles: ['work', 'client'] }),
        entry('any'),
      ]),
    )

    const [macOnly] = await loadFor(sandbox, { os: 'macos', profiles: [] })
    const [linuxWork] = await loadFor(sandbox, { os: 'linux', profiles: ['client'] })

    const names = (module: Module | undefined) =>
      usable(module).files.map(file => path.basename(file.source))
    expect(names(macOnly)).toEqual(['mac', 'any'])
    expect(
      usable(macOnly).elsewhere.map(({ file, reason }) => [path.basename(file.source), reason]),
    ).toEqual([
      ['linux', 'for linux; this machine: macos'],
      ['work', 'for profile "work" or "client"; this machine has no profile'],
    ])
    expect(names(linuxWork)).toEqual(['linux', 'work', 'any'])
    expect(usable(linuxWork).notHere).toBeNull()
  })

  it('applies a module condition to every entry, with the entry conditions', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/aws/config')
    await sandbox.write('home/dotfiles/files/aws/credentials')
    await sandbox.write(
      'home/dotfiles/files/aws/configfile.module.json',
      JSON.stringify({
        when: { profiles: 'work' },
        files: [
          { source_path: 'config', target_path: '~/.aws/config', deploy: 'global' },
          {
            source_path: 'credentials',
            target_path: '~/.aws/credentials',
            deploy: 'global',
            when: { profiles: 'admin', os: 'linux' },
          },
        ],
      }),
    )

    const [personal] = await loadFor(sandbox, { os: 'linux', profiles: ['personal'] })
    const [work] = await loadFor(sandbox, { os: 'linux', profiles: ['work'] })
    const [admin] = await loadFor(sandbox, { os: 'linux', profiles: ['work', 'admin'] })

    expect(usable(personal).notHere).toBe('for profile "work"; this machine: "personal"')
    expect(usable(personal).files).toEqual([])
    expect(usable(personal).elsewhere).toHaveLength(2)
    expect(usable(work).files.map(file => file.target)).toEqual([
      path.join(sandbox.home, '.aws/config'),
    ])
    expect(usable(work).elsewhere[0]?.reason).toBe('for profile "admin"; this machine: "work"')
    expect(usable(admin).files).toHaveLength(2)
    expect(usable(admin).when).toEqual({ profiles: [['work']] })
  })

  it('makes a module or an entry invalid when its condition cannot be read', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/a/x')
    await sandbox.write(
      'home/dotfiles/files/a/configfile.module.json',
      JSON.stringify({ when: { host: 'laptop' }, files: [] }),
    )
    await sandbox.write('home/dotfiles/files/b/x')
    const entry = (when: unknown) => ({
      source_path: 'x',
      target_path: '~/.x',
      deploy: 'global',
      when,
    })
    await sandbox.write(
      'home/dotfiles/files/b/configfile.module.json',
      settings([
        entry({ os: 'windows' }),
        entry({}),
        entry('macos'),
        entry({ profiles: ['my work'] }),
        entry({ os: [] }),
      ]),
    )

    const [a, b] = await loadFor(sandbox, { os: 'macos', profiles: [] })

    expect(a?.error).toBe(
      '"when" has "host", which configfile doesn\'t know (use "os" and "profiles")',
    )
    expect(usable(b).files).toEqual([])
    expect(usable(b).invalidEntries).toEqual([
      'entry #1 is ignored: "when.os" must be "macos" or "linux", or a list of them',
      'entry #2 is ignored: "when" is empty (use "os" and "profiles")',
      'entry #3 is ignored: "when" must be an object, such as { "os": "macos" }',
      'entry #4 is ignored: "when.profiles" must be a profile name (letters, digits, ".", "_" and "-"), or a list of them',
      'entry #5 is ignored: "when.os" must be "macos" or "linux", or a list of them',
    ])
  })

  it('deploys no conditional entry when no machine is given', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/m/x')
    await sandbox.write(
      'home/dotfiles/files/m/configfile.module.json',
      settings([
        { source_path: 'x', target_path: '~/.x', deploy: 'global', when: { os: 'linux' } },
      ]),
    )

    const [module] = (await modulesOf(sandbox)).modules

    expect(usable(module).files).toEqual([])
    expect(usable(module).elsewhere[0]?.reason).toBe('no machine to check "when" against')
  })

  it('says why an entry is for no system when the module and the entry disagree', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/files/m/x')
    await sandbox.write(
      'home/dotfiles/files/m/configfile.module.json',
      JSON.stringify({
        when: { os: 'macos' },
        files: [{ source_path: 'x', target_path: '~/.x', deploy: 'global', when: { os: 'linux' } }],
      }),
    )

    const [module] = await loadFor(sandbox, { os: 'linux', profiles: [] })

    expect(usable(module).notHere).toBe('for macos; this machine: linux')
    const [mac] = await loadFor(sandbox, { os: 'macos', profiles: [] })
    expect(usable(mac).elsewhere[0]?.reason).toBe(
      'for no system: the module and the entry name others',
    )
  })
})
