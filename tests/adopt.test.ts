import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, readFile, symlink } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { isAncestor, repositoryKey } from '../src/working-copy.ts'

import {
  createRemote,
  createSandbox,
  createWorkingCopy,
  git,
  readHistory,
  runCli,
  type Sandbox,
} from './helpers.ts'

function gitText(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function setUp() {
  const sandbox = await createSandbox()
  const repo = await createWorkingCopy(sandbox)
  return { sandbox, ...repo }
}

/** Whether configfile recorded the target as its copy. */
async function isRecordedCopy(sandbox: Sandbox, target: string): Promise<boolean> {
  if (!existsSync(path.join(sandbox.home, '.configfile/state.json'))) return false
  const state = (await readJson(path.join(sandbox.home, '.configfile/state.json'))) as {
    targets: Record<string, { deployed: { copy?: unknown } | null }>
  }
  return state.targets[target]?.deployed?.copy != null
}

describe('modules adopt', () => {
  it("commits a file into a new module, pushes it, and keeps it as configfile's copy", async () => {
    const { sandbox, remote, work } = await setUp()
    const zshrc = await sandbox.write('home/.zshrc', 'export EDITOR=vim\n')

    const result = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      work,
    ])

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(await readFile(path.join(remote, 'files/zsh/zshrc'), 'utf8')).toBe('export EDITOR=vim\n')
    expect(await readJson(path.join(remote, 'files/zsh/settings.json'))).toEqual({
      $schema: 'https://docs.configfile.sh/schemas/settings.json',
      files: [{ source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' }],
    })
    expect(gitText(remote, 'log', '-1', '--format=%s%n%an')).toBe('Adopt ~/.zshrc\ntest')
    expect(await readFile(path.join(sandbox.repo, 'files/zsh/zshrc'), 'utf8')).toBe(
      'export EDITOR=vim\n',
    )
    expect(await readFile(zshrc, 'utf8')).toBe('export EDITOR=vim\n')
    expect(await isRecordedCopy(sandbox, zshrc)).toBe(true)
    expect(result.stdout).toContain(`- ${zshrc} (configfile's copy now)`)
    expect(await readJson(path.join(sandbox.home, '.configfilerc'))).toMatchObject({
      working_copy: work,
    })

    const status = await runCli(sandbox, ['modules', 'status', 'zsh'])
    expect(status.stdout).toContain(`${zshrc} (copied)`)
    const history = await readHistory(sandbox)
    expect(history.at(-1)).toMatchObject({
      command: 'modules adopt',
      options: { module: 'zsh', paths: 1 },
      changes: expect.arrayContaining([
        { kind: 'adopted', target: zshrc, source: 'files/zsh/zshrc', folder: work },
        expect.objectContaining({ kind: 'pushed', folder: work, branch: 'main' }),
        { kind: 'recorded', target: zshrc, source: path.join(sandbox.repo, 'files/zsh/zshrc') },
      ]),
    })
  })

  it('adds to an existing module, keeping its settings as written', async () => {
    const { sandbox, remote, work } = await setUp()
    const settings =
      '{\n    "post_deploy": "setup",\n    "files": [\n        { "source_path": "zshrc", "target_path": "~/.zshrc", "deploy": "global" }\n    ]\n}\n'
    await sandbox.write('work/files/shell/settings.json', settings)
    await sandbox.write('work/files/shell/zshrc', 'zshrc')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'shell')
    git(work, 'push', '--quiet', 'origin', 'main')
    await sandbox.write('home/.config/starship/starship.toml', 'format = "$all"')
    await sandbox.write('home/.config/starship/themes/dark.toml', 'dark')
    await sandbox.configure({ working_copy: work })

    const result = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.config/starship',
      '--module',
      'shell',
      '--message',
      'Add starship',
    ])

    expect(result.stderr).toBe('')
    expect(await readFile(path.join(remote, 'files/shell/settings.json'), 'utf8')).toBe(
      '{\n    "post_deploy": "setup",\n    "files": [\n        {\n            "source_path": "zshrc",\n            "target_path": "~/.zshrc",\n            "deploy": "global"\n        },\n        {\n            "source_path": "starship",\n            "target_path": "~/.config/starship",\n            "deploy": "global"\n        }\n    ]\n}\n',
    )
    expect(await readFile(path.join(remote, 'files/shell/starship/themes/dark.toml'), 'utf8')).toBe(
      'dark',
    )
    expect(gitText(remote, 'log', '-1', '--format=%s')).toBe('Add starship')
    expect(await isRecordedCopy(sandbox, path.join(sandbox.home, '.config/starship'))).toBe(true)
  })

  it('names files with --as, and refuses names already taken', async () => {
    const { sandbox, remote, work } = await setUp()
    await sandbox.write('home/.zshrc', 'one')
    await sandbox.write('home/.config/zsh/zshrc', 'two')
    await sandbox.configure({ working_copy: work })

    const twice = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '~/.config/zsh/zshrc',
      '-m',
      'zsh',
    ])
    const first = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])
    const taken = await runCli(sandbox, ['modules', 'adopt', '~/.config/zsh/zshrc', '-m', 'zsh'])
    const named = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.config/zsh/zshrc',
      '-m',
      'zsh',
      '--as',
      'zshrc-xdg',
    ])
    const asTwo = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/a',
      '~/b',
      '-m',
      'zsh',
      '--as',
      'x',
    ])

    expect(twice).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Two files would be named zshrc'),
    })
    expect(first.code).toBe(0)
    expect(taken.stderr).toContain(
      'Module files/zsh already has zshrc: choose another name with --as.',
    )
    expect(named.code).toBe(0)
    expect(await readFile(path.join(remote, 'files/zsh/zshrc-xdg'), 'utf8')).toBe('two')
    expect(asTwo.stderr).toContain('--as names one file')
  })

  it('refuses a working copy with changes that are not committed', async () => {
    const { sandbox, remote, work } = await setUp()
    await sandbox.write('home/.zshrc', 'zshrc')
    await sandbox.write('work/notes.txt', 'draft')

    const result = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      work,
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `${work} has changes that are not committed (notes.txt): commit, stash or remove them`,
    )
    expect(existsSync(path.join(work, 'files/zsh'))).toBe(false)
    expect(gitText(remote, 'log', '--format=%s')).toBe('first')
    // Nothing worked: the working copy is not remembered.
    expect(await readJson(path.join(sandbox.home, '.configfilerc'))).not.toHaveProperty(
      'working_copy',
    )
  })

  it('brings a working copy that is behind up to date, and refuses one that diverged', async () => {
    const { sandbox, remote, work, commitInRemote } = await setUp()
    await sandbox.write('home/.zshrc', 'zshrc')
    await sandbox.write('home/.vimrc', 'vimrc')
    await sandbox.configure({ working_copy: work })
    await commitInRemote('README.md', 'readme')

    const behind = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])
    await commitInRemote('LICENSE', 'license')
    await sandbox.write('work/other.txt', 'other')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'other')
    const diverged = await runCli(sandbox, ['modules', 'adopt', '~/.vimrc', '-m', 'vim'])

    expect(behind.code).toBe(0)
    expect(behind.stdout).toContain(`Brought ${work} up to date (1 commit).`)
    expect(gitText(remote, 'log', '--format=%s')).toBe(
      'change LICENSE\nAdopt ~/.zshrc\nchange README.md\nfirst',
    )
    expect(diverged.code).toBe(1)
    expect(diverged.stderr).toContain(`${work} and origin/main have diverged`)
    expect(existsSync(path.join(work, 'files/vim'))).toBe(false)
  })

  it('refuses a folder that is not a clone of the dotfiles repository', async () => {
    const { sandbox } = await setUp()
    await sandbox.write('home/.zshrc', 'zshrc')
    const other = path.join(sandbox.root, 'other')
    await sandbox.write('other/README.md', 'other')
    git(other, 'init', '--quiet')
    git(other, 'remote', 'add', 'origin', 'https://example.com/someone/else.git')

    const result = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      other,
    ])
    const plain = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      sandbox.cwd,
    ])
    const mirror = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      sandbox.repo,
    ])
    const none = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])

    expect(result.stderr).toContain(`${other} is not a clone of your dotfiles repository`)
    expect(plain.stderr).toContain(`${sandbox.cwd} is not a git repository`)
    expect(mirror.stderr).toContain("is configfile's copy of your dotfiles repository")
    expect(none.stderr).toContain('Give your working copy of the dotfiles repository with --into')
  })

  it('refuses what cannot be adopted', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    await sandbox.write('home/.config/tool/.git/HEAD', 'ref')
    await sandbox.write('home/real', 'real')
    await symlink(path.join(sandbox.home, 'real'), path.join(sandbox.home, '.link'))

    const adopt = (target: string) => runCli(sandbox, ['modules', 'adopt', target, '-m', 'misc'])

    expect((await adopt('~/missing')).stderr).toContain(
      `${path.join(sandbox.home, 'missing')} does not exist.`,
    )
    expect((await adopt('~/.link')).stderr).toContain('is a symbolic link')
    expect((await adopt('~/.config/tool')).stderr).toContain('holds a git repository')
    expect((await adopt(path.join(work, 'files'))).stderr).toContain('is inside your working copy')
    expect((await adopt('~')).stderr).toContain("holds configfile's copy of the repository")
    expect((await adopt(sandbox.root)).stderr).toContain('holds your working copy')
    expect(
      (await runCli(sandbox, ['modules', 'adopt', '~/real', '-m', 'Not Valid'])).stderr,
    ).toContain('"Not Valid" cannot name a new module')
  })

  it('refuses a file configfile already deploys', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    await sandbox.write('home/.zshrc', 'zshrc')
    expect((await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])).code).toBe(0)

    const again = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'shell'])

    expect(again.stderr).toContain(
      `${path.join(sandbox.home, '.zshrc')} is already deployed by configfile.`,
    )
  })

  it('shows what it would do with --dry-run, changing nothing', async () => {
    const { sandbox, remote, work } = await setUp()
    const zshrc = await sandbox.write('home/.zshrc', 'zshrc')

    const result = await runCli(sandbox, [
      'modules',
      'adopt',
      '-n',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      work,
    ])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `Would add to module zsh, in ${work}:\n- ${zshrc} (as files/zsh/zshrc)`,
    )
    expect(existsSync(path.join(work, 'files/zsh'))).toBe(false)
    expect(gitText(remote, 'log', '--format=%s')).toBe('first')
    expect(existsSync(path.join(sandbox.home, '.configfile/state.json'))).toBe(false)
  })

  it('commits without pushing with --no-push; update pushes it and keeps the file', async () => {
    const { sandbox, remote, work } = await setUp()
    const zshrc = await sandbox.write('home/.zshrc', 'zshrc')

    const adopted = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      work,
      '--no-push',
    ])
    expect(adopted.code).toBe(0)
    expect(adopted.stdout).toContain('Push it, or run "configfile update"')
    expect(gitText(remote, 'log', '--format=%s')).toBe('first')
    expect(existsSync(path.join(sandbox.home, '.configfile/state.json'))).toBe(false)

    const updated = await runCli(sandbox, ['update'])

    expect(updated.stderr).toBe('')
    expect(updated.stdout).toContain(`Pushed main from ${work} to origin.`)
    expect(updated.stdout).toContain(`- ${zshrc} (configfile's copy now)`)
    expect(gitText(remote, 'log', '-1', '--format=%s')).toBe('Adopt ~/.zshrc')
    expect(await isRecordedCopy(sandbox, zshrc)).toBe(true)
  })

  it('keeps the commit and records nothing when the push fails', async () => {
    const { sandbox, remote, work } = await setUp()
    const zshrc = await sandbox.write('home/.zshrc', 'zshrc')
    await sandbox.write('remote/.git/hooks/pre-receive', '#!/bin/sh\nexit 1\n', 0o755)

    const result = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      work,
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `Committed ${zshrc} into files/zsh in ${work}. It was not pushed:`,
    )
    expect(gitText(work, 'log', '-1', '--format=%s')).toBe('Adopt ~/.zshrc')
    expect(gitText(remote, 'log', '--format=%s')).toBe('first')
    expect(existsSync(path.join(sandbox.home, '.configfile/state.json'))).toBe(false)

    // The next update tries again, and warns when it cannot.
    const updated = await runCli(sandbox, ['update'])
    expect(updated.code).toBe(0)
    expect(updated.stderr).toContain(`Cannot push your working copy (${work})`)
  })

  it('restores the settings.json of an existing module when the commit fails', async () => {
    const { sandbox, work } = await setUp()
    const settings = '{\n\t"files": []\n}\n'
    await sandbox.write('work/files/shell/settings.json', settings)
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'shell')
    await sandbox.write('home/.config/starship/starship.toml', 'toml')
    await sandbox.write('work/.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n', 0o755)

    const result = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.config/starship',
      '-m',
      'shell',
      '--into',
      work,
    ])

    expect(result.stderr).toContain('Nothing was adopted: git commit failed')
    expect(result.stderr).not.toContain('could not be undone')
    expect(await readFile(path.join(work, 'files/shell/settings.json'), 'utf8')).toBe(settings)
    expect(existsSync(path.join(work, 'files/shell/starship'))).toBe(false)
    expect(gitText(work, 'status', '--porcelain')).toBe('')
  })

  it('removes what it wrote when the commit fails', async () => {
    const { sandbox, remote, work } = await setUp()
    await sandbox.write('home/.zshrc', 'zshrc')
    await sandbox.write('work/.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n', 0o755)

    const result = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      work,
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Nothing was adopted: git commit failed')
    expect(existsSync(path.join(work, 'files/zsh'))).toBe(false)
    expect(gitText(work, 'status', '--porcelain')).toBe('')
    expect(gitText(remote, 'log', '--format=%s')).toBe('first')
  })
})

describe('modules adopt, more refusals', () => {
  it('refuses a working copy on another branch, and lists many changes briefly', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    await sandbox.write('home/.zshrc', 'zshrc')
    git(work, 'switch', '--quiet', '-c', 'topic')
    const branch = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])
    git(work, 'switch', '--quiet', '--detach')
    const detached = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])
    git(work, 'switch', '--quiet', 'main')
    for (let index = 0; index < 12; index++) await sandbox.write(`work/draft-${index}.txt`)
    const dirty = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])

    expect(branch.stderr).toContain(
      `${work} is on branch topic, and configfile follows main: run "git -C ${work} switch main"`,
    )
    expect(detached.stderr).toContain(`${work} is on no branch`)
    expect(dirty.stderr).toContain('draft-7.txt and 2 more): commit, stash or remove them')
  })

  it('lists the new name of a renamed file among the changes', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    await sandbox.write('home/.zshrc', 'zshrc')
    git(work, 'mv', 'files/.gitkeep', 'files/.keep')

    const result = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])

    expect(result.stderr).toContain('has changes that are not committed (files/.keep):')
  })

  it('refuses modules and names that cannot be used', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    await sandbox.write('work/files/broken/settings.json', '{')
    await sandbox.write('work/files/plain/notes.txt', 'notes')
    await sandbox.write(
      'work/files/vim/settings.json',
      JSON.stringify({
        files: [{ source_path: 'vimrc', target_path: '~/.vimrc', deploy: 'global' }],
      }),
    )
    await sandbox.write('work/files/vim/vimrc', 'vimrc')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'modules')
    git(work, 'push', '--quiet', 'origin', 'main')
    await sandbox.write('home/.zshrc', 'zshrc')
    await sandbox.write('home/.vimrc', 'vimrc')
    await sandbox.write('home/settings.json', '{}')
    await sandbox.write('root/etc/tool.conf', 'tool')

    const adopt = async (...args: string[]) =>
      (await runCli(sandbox, ['modules', 'adopt', ...args])).stderr

    expect(await adopt('~/.zshrc', '-m', 'broken')).toContain(
      'Module "broken" cannot be used: settings.json is not valid JSON',
    )
    // It may deploy the file already: nothing is adopted until it is fixed.
    expect(await adopt('~/.zshrc', '-m', 'zsh')).toContain(
      'Module "broken" cannot be used (settings.json is not valid JSON',
    )
    await sandbox.write('work/files/broken/settings.json', '{ "files": [] }')
    git(work, 'commit', '--quiet', '-am', 'fix broken')
    expect(await adopt('~/.zshrc', '-m', 'plain')).toContain(
      'plain exists and is not a module (it has no settings.json).',
    )
    expect(await adopt('~/.vimrc', '-m', 'editors')).toContain('Module vim already deploys')
    expect(await adopt('~/.zshrc', '-m', 'zsh', '--as', '..')).toContain(
      '".." cannot name a file of the module.',
    )
    expect(await adopt('~/settings.json', '-m', 'zsh')).toContain('would be named settings.json')
    expect(await adopt(path.join(sandbox.root, 'root/etc'), '-m', 'zsh', '-n')).toBe('')
  })

  it('writes the target of a file outside the home folder as an absolute path', async () => {
    const { sandbox, remote, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    const outside = await sandbox.write('etc/tool.conf', 'tool')
    await sandbox.write('home/.toolrc', 'toolrc')

    const result = await runCli(sandbox, ['modules', 'adopt', outside, '~/.toolrc', '-m', 'tool'])

    expect(result.stderr).toBe('')
    expect(await readJson(path.join(remote, 'files/tool/settings.json'))).toMatchObject({
      files: [
        { source_path: 'tool.conf', target_path: outside },
        { source_path: 'toolrc', target_path: '~/.toolrc' },
      ],
    })
    expect(gitText(remote, 'log', '-1', '--format=%s')).toBe(
      `Adopt ${path.relative(sandbox.home, outside)} and ~/.toolrc`,
    )
  })

  it('says what it would do without pushing', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.write('home/.zshrc', 'zshrc')

    const result = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      work,
      '-n',
      '--no-push',
    ])

    expect(result.stdout).toContain('Would commit them, without pushing.')
  })

  it('warns when the file changed before configfile could keep it', async () => {
    const { sandbox, work } = await setUp()
    const zshrc = await sandbox.write('home/.zshrc', 'zshrc')
    // Changes the file once it is committed, as an editor saving it meanwhile would.
    await sandbox.write(
      'work/.git/hooks/post-commit',
      `#!/bin/sh
echo edited > '${zshrc}'
`,
      0o755,
    )

    const result = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.zshrc',
      '-m',
      'zsh',
      '--into',
      work,
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(
      `${zshrc} is not the repository's version, so configfile left it as it is: ` +
        '"configfile modules deploy zsh" would move it to .old',
    )
    expect(await isRecordedCopy(sandbox, zshrc)).toBe(false)
  })
})

describe('modules adopt, after the review', () => {
  it('adopts nothing that git ignores', async () => {
    const { sandbox, remote, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    await sandbox.write('work/.gitignore', '*.local\n')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'ignore')
    await sandbox.write('home/.npmrc.local', 'registry')

    const result = await runCli(sandbox, ['modules', 'adopt', '~/.npmrc.local', '-m', 'npm'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Nothing was adopted: git ignores files/npm/npmrc.local')
    expect(existsSync(path.join(work, 'files/npm'))).toBe(false)
    expect(gitText(work, 'status', '--porcelain')).toBe('')
    expect(gitText(remote, 'log', '--format=%s')).toBe('first')
  })

  it('refuses a path inside, or holding, what configfile or a module deploys', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    await sandbox.write('home/.config/nvim/init.lua', 'init')
    await sandbox.write('home/.config/git/config', 'config')
    expect((await runCli(sandbox, ['modules', 'adopt', '~/.config/nvim', '-m', 'nvim'])).code).toBe(
      0,
    )
    await sandbox.write(
      'work/files/git/settings.json',
      JSON.stringify({
        files: [{ source_path: 'git', target_path: '~/.config/git', deploy: 'global' }],
      }),
    )
    await sandbox.write('work/files/git/git/config', 'config')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'git')

    const adopt = async (target: string) =>
      (await runCli(sandbox, ['modules', 'adopt', target, '-m', 'misc'])).stderr
    const home = (file: string) => path.join(sandbox.home, file)

    expect(await adopt('~/.config/nvim/init.lua')).toContain(
      `${home('.config/nvim/init.lua')} is inside ${home('.config/nvim')}, which configfile deploys.`,
    )
    expect(await adopt('~/.config')).toContain(
      `${home('.config')} holds ${home('.config/nvim')}, which configfile deploys.`,
    )
    expect(await adopt('~/.config/git/config')).toContain(
      `${home('.config/git/config')} overlaps ${home('.config/git')}, which module git deploys.`,
    )
  })

  it('keeps a file adopted with --no-push and pushed by hand', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    const zshrc = await sandbox.write('home/.zshrc', 'zshrc')
    await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh', '--no-push'])
    git(work, 'push', '--quiet', 'origin', 'main')

    const result = await runCli(sandbox, ['update'])

    expect(result.stdout).not.toContain('Pushed')
    expect(result.stdout).toContain(`- ${zshrc} (configfile's copy now)`)
  })

  it('says when a file adopted with --no-push changed before update', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    const zshrc = await sandbox.write('home/.zshrc', 'zshrc')
    await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh', '--no-push'])
    await sandbox.write('home/.zshrc', 'edited since')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(
      `${zshrc} is not the repository's version, so configfile left it as it is`,
    )
    expect(await readFile(zshrc, 'utf8')).toBe('edited since')
  })

  it("keeps nothing from commits that are not on the working copy's branch", async () => {
    const { sandbox, work, commitInRemote } = await setUp()
    await sandbox.configure({ working_copy: work })
    const zshrc = await sandbox.write('home/.zshrc', 'zshrc')
    await commitInRemote('files/zsh/zshrc', 'zshrc')
    await commitInRemote(
      'files/zsh/settings.json',
      JSON.stringify({
        files: [{ source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' }],
      }),
    )

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(await isRecordedCopy(sandbox, zshrc)).toBe(false)
  })

  it('says nothing about a working copy that is only behind the remote', async () => {
    const { sandbox, work, commitInRemote } = await setUp()
    await sandbox.configure({ working_copy: work })
    await commitInRemote('README.md', 'readme')
    git(work, 'fetch', '--quiet')

    const result = await runCli(sandbox, ['update'])

    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('Pushed')
  })
})

describe('modules adopt, a folder with ignored files', () => {
  it("keeps the folder as configfile's copy, and never touches the ignored files", async () => {
    const { sandbox, remote, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    await sandbox.write('work/.gitignore', 'lazy-lock.json\n')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'ignore')
    git(work, 'push', '--quiet', 'origin', 'main')
    const nvim = path.join(sandbox.home, '.config/nvim')
    await sandbox.write('home/.config/nvim/init.lua', 'init')
    await sandbox.write('home/.config/nvim/lazy-lock.json', 'lock')

    const adopted = await runCli(sandbox, ['modules', 'adopt', '~/.config/nvim', '-m', 'nvim'])
    const deployed = await runCli(sandbox, ['modules', 'deploy', 'nvim'])

    expect(adopted.stderr).toBe('')
    expect(adopted.stdout).toContain(`- ${nvim} (configfile's copy now)`)
    expect(existsSync(path.join(remote, 'files/nvim/nvim/init.lua'))).toBe(true)
    expect(existsSync(path.join(remote, 'files/nvim/nvim/lazy-lock.json'))).toBe(false)
    expect(await isRecordedCopy(sandbox, nvim)).toBe(true)
    expect(deployed.code).toBe(0)
    expect(await readFile(path.join(nvim, 'lazy-lock.json'), 'utf8')).toBe('lock')
    expect(existsSync(`${nvim}.old`)).toBe(false)
  })
})

describe('update with a working copy', () => {
  it('pushes the commits the remote lacks before syncing', async () => {
    const { sandbox, remote, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    await sandbox.write('work/files/vim/settings.json', '{ "files": [] }')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'vim')

    const result = await runCli(sandbox, ['update'])
    const again = await runCli(sandbox, ['update'])

    expect(result.stdout).toContain(`Pushed main from ${work} to origin.`)
    expect(gitText(remote, 'log', '-1', '--format=%s')).toBe('vim')
    expect(existsSync(path.join(sandbox.repo, 'files/vim/settings.json'))).toBe(true)
    expect(again.stdout).not.toContain('Pushed')
  })

  it('records only the identical targets of the entries the pushed commits add', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.configure({ working_copy: work })
    const same = await sandbox.write('home/.same', 'same')
    const changed = await sandbox.write('home/.changed', 'mine')
    const linked = await sandbox.write('home/.linked', 'linked')
    await sandbox.write('work/files/misc/same', 'same')
    await sandbox.write('work/files/misc/changed', 'theirs')
    await sandbox.write('work/files/misc/linked', 'linked')
    await sandbox.write(
      'work/files/misc/settings.json',
      JSON.stringify({
        files: [
          { source_path: 'same', target_path: '~/.same', deploy: 'global' },
          { source_path: 'changed', target_path: '~/.changed', deploy: 'global' },
          { source_path: 'linked', target_path: '~/.linked', deploy: 'global', method: 'link' },
        ],
      }),
    )
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'misc')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(await isRecordedCopy(sandbox, same)).toBe(true)
    expect(await isRecordedCopy(sandbox, changed)).toBe(false)
    expect(await isRecordedCopy(sandbox, linked)).toBe(false)
  })

  it('warns and still syncs when the working copy cannot be used', async () => {
    const { sandbox, commitInRemote } = await setUp()
    await sandbox.configure({ working_copy: path.join(sandbox.root, 'gone') })
    await commitInRemote('README.md', 'readme')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(
      `Cannot use your working copy (${path.join(sandbox.root, 'gone')})`,
    )
    expect(existsSync(path.join(sandbox.repo, 'README.md'))).toBe(true)
  })

  it('does not push a branch that diverged from the remote', async () => {
    const { sandbox, work, commitInRemote } = await setUp()
    await sandbox.configure({ working_copy: work })
    await commitInRemote('README.md', 'readme')
    git(work, 'fetch', '--quiet')
    await sandbox.write('work/other.txt', 'other')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'other')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('main has diverged from origin/main')
  })
})

describe('repositoryKey', () => {
  it('matches the URLs of one repository, whatever the protocol and user', async () => {
    const keys = await Promise.all(
      [
        'https://github.com/me/dotfiles.git',
        'https://token@GitHub.com/me/dotfiles/',
        'ssh://git@github.com/me/dotfiles',
        'git@github.com:me/dotfiles.git',
        'github.com:/me/dotfiles',
      ].map(url => repositoryKey(url, '/')),
    )
    expect(new Set(keys)).toEqual(new Set(['github.com/me/dotfiles']))
    expect(await repositoryKey('https://github.com/me/other.git', '/')).toBe('github.com/me/other')
  })

  it('matches local repositories by their real path', async () => {
    const sandbox = await createSandbox()
    const remote = await createRemote(sandbox)
    await symlink(remote, path.join(sandbox.root, 'alias'))

    expect(await repositoryKey('../alias/', sandbox.home)).toBe(`file:${remote}`)
    expect(await repositoryKey(`file://${remote}`, '/')).toBe(`file:${remote}`)
    expect(await repositoryKey('/no/such/repo.git', '/')).toBe('file:/no/such/repo.git')
    expect(await repositoryKey('custom::address', '/')).toBe('custom::address')
  })
})

describe('the working_copy setting', () => {
  it('is saved by init --working-copy', async () => {
    const sandbox = await createSandbox()
    const remote = await createRemote(sandbox)

    const result = await runCli(
      sandbox,
      ['init', '--repo', remote, '--working-copy', '~/src/dotfiles'],
      [],
      { interactive: false },
    )

    expect(result.code).toBe(0)
    expect(await readJson(path.join(sandbox.home, '.configfilerc'))).toMatchObject({
      repo_url: remote,
      working_copy: path.join(sandbox.home, 'src/dotfiles'),
    })
  })

  it('must be a path', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure({ working_copy: 42 })

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('"working_copy" must be the path of a folder.')
  })
})

describe('modules adopt and update, round 2', () => {
  it('keeps a file adopted with --no-push even when another machine pushed on top', async () => {
    const { sandbox, work, commitInRemote } = await setUp()
    await sandbox.configure({ working_copy: work })
    const zshrc = await sandbox.write('home/.zshrc', 'zshrc')
    await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh', '--no-push'])
    git(work, 'push', '--quiet', 'origin', 'main')
    await commitInRemote('README.md', 'from another machine')

    const result = await runCli(sandbox, ['update'])

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(`- ${zshrc} (configfile's copy now)`)
  })

  it('lists what it could not undo when the rollback fails', async () => {
    const { sandbox, work } = await setUp()
    await sandbox.write('home/.zshrc', 'zshrc')
    await sandbox.write(
      'work/.git/hooks/pre-commit',
      '#!/bin/sh\nchmod 555 files/zsh\nexit 1\n',
      0o755,
    )
    try {
      const result = await runCli(sandbox, [
        'modules',
        'adopt',
        '~/.zshrc',
        '-m',
        'zsh',
        '--into',
        work,
      ])

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Nothing was adopted: git commit failed')
      expect(result.stderr).toContain(
        `These could not be undone: removing ${path.join(work, 'files/zsh/zshrc')}`,
      )
      expect(result.stderr).toContain(`Check "git -C ${work} status".`)
    } finally {
      await chmod(path.join(work, 'files/zsh'), 0o755)
    }
  })

  it('goes on when the working copy cannot be remembered', async () => {
    const { sandbox, remote, work } = await setUp()
    await sandbox.write('home/.zshrc', 'zshrc')
    // ~/.configfilerc is replaced through a file written next to it.
    await chmod(sandbox.home, 0o555)
    try {
      const result = await runCli(sandbox, [
        'modules',
        'adopt',
        '~/.zshrc',
        '-m',
        'zsh',
        '--into',
        work,
      ])

      expect(result.stderr).toContain('Cannot remember your working copy:')
      expect(gitText(remote, 'log', '-1', '--format=%s')).toBe('Adopt ~/.zshrc')
    } finally {
      await chmod(sandbox.home, 0o755)
    }
  })

  it('fails when git cannot tell whether a commit is an ancestor', async () => {
    const { remote } = await setUp()

    await expect(isAncestor(remote, 'HEAD', 'HEAD')).resolves.toBe(true)
    await expect(isAncestor(remote, '0'.repeat(40), 'HEAD')).rejects.toThrow(
      'git merge-base failed',
    )
  })
})
