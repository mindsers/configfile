import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findEmptyRemote } from '../src/commands/new-repository.ts'
import { listModules, listScripts } from '../src/repository.ts'
import { starterFiles } from '../src/starter.ts'

import {
  createMirror,
  createSandbox,
  git,
  gitSetting,
  readHistory,
  runCli,
  type Sandbox,
} from './helpers.ts'

function gitText(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const STARTER = [
  'README.md',
  'configfile.repository.json',
  'files/example/configfile.module.json',
  'files/example/example.conf',
  'scripts/hello.sh',
]

beforeEach(() => {
  // The CLI commits as the user, and tests have no git settings (vitest.config.ts): give them
  // an identity.
  vi.stubEnv('GIT_AUTHOR_NAME', 'test')
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.com')
  vi.stubEnv('GIT_COMMITTER_NAME', 'test')
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.com')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Leaves git without any identity of the user's: it would guess one. */
function forgetIdentity() {
  for (const name of ['NAME', 'EMAIL']) {
    vi.stubEnv(`GIT_AUTHOR_${name}`, undefined)
    vi.stubEnv(`GIT_COMMITTER_${name}`, undefined)
  }
}

/** An empty repository that accepts pushes, in `<sandbox>/remote.git`, on branch `main`. */
async function emptyRemote(sandbox: Sandbox): Promise<string> {
  const remote = path.join(sandbox.root, 'remote.git')
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote])
  // Not every git installs hooks/ from its templates.
  await mkdir(path.join(remote, 'hooks'), { recursive: true })
  return remote
}

async function setUp() {
  const sandbox = await createSandbox()
  const remote = await emptyRemote(sandbox)
  const work = path.join(sandbox.root, 'work')
  const mirror = path.join(sandbox.home, '.configfile/dotfiles')
  return { sandbox, remote, work, mirror }
}

/** A clone of `remote` started by hand (git init, then git remote add), with no commit. */
function startedClone(work: string, remote: string, branch = 'master') {
  execFileSync('git', ['init', '--quiet', `--initial-branch=${branch}`, work])
  git(work, 'remote', 'add', 'origin', remote)
}

const readConfig = async (sandbox: Sandbox) =>
  JSON.parse(await readFile(path.join(sandbox.home, '.configfilerc'), 'utf8'))

const init = (sandbox: Sandbox, args: string[], answers: Array<boolean | string> = []) =>
  runCli(sandbox, ['init', ...args], answers, { interactive: answers.length > 0 })

describe('init with an empty repository', () => {
  it('sets it up in the working copy with --new-repository: commits, pushes and syncs', async () => {
    const { sandbox, remote, work, mirror } = await setUp()

    const result = await init(sandbox, [
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(`Set up a new dotfiles repository in ${work}`)
    expect(gitText(remote, 'log', '--format=%s', 'main')).toBe('Start a dotfiles repository')
    expect(gitText(remote, 'log', '--format=%an', 'main')).toBe('test')
    expect(gitText(work, 'ls-files').split('\n')).toEqual(STARTER)
    expect(gitText(work, 'ls-files', '--stage', 'scripts/hello.sh')).toMatch(/^100755 /)
    // The working copy follows the remote; the mirror is synced.
    expect(gitText(work, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main')
    expect(gitText(mirror, 'rev-parse', 'HEAD')).toBe(gitText(remote, 'rev-parse', 'main'))
    expect((await readConfig(sandbox)).working_copy).toBe(work)
    const changes = (await readHistory(sandbox)).flatMap(line => line.changes)
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'cloned', folder: work }))
    expect(changes).toContainEqual({
      kind: 'pushed',
      folder: work,
      branch: 'main',
      from: null,
      to: gitText(remote, 'rev-parse', 'main'),
    })

    const modules = await runCli(sandbox, ['modules', 'list'])
    expect(modules.stdout).toContain('- example')
    const update = await runCli(sandbox, ['update'])
    expect(update.code, update.stderr).toBe(0)
  })

  it('lets modules adopt add files right after', async () => {
    const { sandbox, remote, work } = await setUp()
    await init(sandbox, ['--repo', remote, '--new-repository', '--working-copy', work])
    await sandbox.write('home/.zshrc', 'export EDITOR=vim\n')

    const result = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])

    expect(result.code, result.stderr).toBe(0)
    expect(gitText(remote, 'show', 'main:files/zsh/zshrc')).toBe('export EDITOR=vim')
  })

  it('asks in a terminal, then where the working copy goes', async () => {
    const { sandbox, remote, work } = await setUp()

    const result = await init(sandbox, ['--repo', remote, '--no-hooks'], [true, work])

    expect(result.code, result.stderr).toBe(0)
    expect(result.asked).toEqual([
      `${remote} is empty. Set up a new dotfiles repository in it?`,
      'Your working copy (the clone where you edit your dotfiles):',
    ])
    expect(gitText(remote, 'log', '--format=%s', 'main')).toBe('Start a dotfiles repository')
  })

  it('asks only what --working-copy and --new-repository leave open', async () => {
    const first = await setUp()
    const confirmOnly = await init(
      first.sandbox,
      ['--repo', first.remote, '--working-copy', first.work],
      [true],
    )
    expect(confirmOnly.code, confirmOnly.stderr).toBe(0)
    expect(confirmOnly.asked).toEqual([
      `${first.remote} is empty. Set up a new dotfiles repository in it?`,
    ])

    const second = await setUp()
    const folderOnly = await init(
      second.sandbox,
      ['--repo', second.remote, '--new-repository'],
      [second.work],
    )
    expect(folderOnly.code, folderOnly.stderr).toBe(0)
    expect(folderOnly.asked).toEqual([
      'Your working copy (the clone where you edit your dotfiles):',
    ])
  })

  it('uses ~/dotfiles without a terminal when no working copy is given or saved', async () => {
    const { sandbox, remote } = await setUp()
    const folder = path.join(sandbox.home, 'dotfiles')

    const result = await init(sandbox, ['--repo', remote, '--new-repository'])

    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(path.join(folder, 'README.md'))).toBe(true)
    expect((await readConfig(sandbox)).working_copy).toBe(folder)
    expect(gitText(folder, 'rev-parse', 'HEAD')).toBe(gitText(remote, 'rev-parse', 'main'))
  })

  it('sets it up in the same working copy with the command it gives', async () => {
    const { sandbox, remote, work } = await setUp()
    const first = await init(sandbox, ['--repo', remote, '--working-copy', work])
    const command = `configfile init --force --repo ${remote} --new-repository --working-copy ${work}`
    expect(first.stderr).toContain(`or set it up with "${command}".`)
    expect((await readConfig(sandbox)).working_copy).toBe(work)

    const result = await init(sandbox, command.split(' ').slice(2))

    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(path.join(work, 'README.md'))).toBe(true)
    expect(existsSync(path.join(sandbox.home, 'dotfiles'))).toBe(false)
  })

  it('asks again when the folder cannot be the working copy', async () => {
    const { sandbox, remote, work, mirror } = await setUp()
    await sandbox.write('taken/notes.txt', 'mine')

    const result = await init(
      sandbox,
      ['--repo', remote],
      [true, path.join(sandbox.root, 'taken'), mirror, work],
    )

    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain('is not empty and is not a git repository. Choose another')
    expect(result.stderr).toContain("is configfile's copy of your dotfiles repository")
    expect(await readFile(path.join(sandbox.root, 'taken/notes.txt'), 'utf8')).toBe('mine')
    expect(existsSync(path.join(work, 'README.md'))).toBe(true)
  })

  it('refuses a folder given with --working-copy that cannot be used, and does not save it', async () => {
    const { sandbox, remote } = await setUp()
    const taken = await sandbox.write('taken/notes.txt', 'mine')

    const result = await init(
      sandbox,
      ['--repo', remote, '--working-copy', path.dirname(taken)],
      [true],
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('configfile is configured')
    expect(result.stderr).toContain(
      `Choose another folder: configfile init --force --repo ${remote} --new-repository ` +
        '--working-copy <folder>',
    )
    expect((await readConfig(sandbox)).working_copy).toBeUndefined()
  })

  it('refuses a folder inside configfile’s copy, also through a symbolic link', async () => {
    const { sandbox, remote, mirror } = await setUp()
    await symlink(sandbox.home, path.join(sandbox.root, 'link'))

    for (const folder of [
      path.join(mirror, 'work'),
      path.join(sandbox.root, 'link/.configfile/dotfiles/work'),
    ]) {
      const result = await init(sandbox, [
        '--force',
        '--repo',
        remote,
        '--new-repository',
        '--working-copy',
        folder,
      ])

      expect(result.code, folder).toBe(1)
      expect(result.stderr).toContain(`${folder} is inside configfile's copy`)
    }
    expect(existsSync(path.join(mirror, 'work'))).toBe(false)
  })

  it('only says the repository is empty when the answer is no', async () => {
    const { sandbox, remote } = await setUp()

    const result = await init(sandbox, ['--repo', remote], [false])

    expect(result.code, result.stderr).toBe(0)
    expect(result.asked).toHaveLength(1)
    expect(result.stdout).toContain('Nothing was set up: push a first commit to it')
    expect(existsSync(path.join(sandbox.home, 'dotfiles'))).toBe(false)
    expect(gitText(remote, 'for-each-ref')).toBe('')
  })

  it('warns without a terminal, and sets nothing up, unless --new-repository is given', async () => {
    const { sandbox, remote } = await setUp()

    const result = await init(sandbox, ['--repo', remote])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain(
      `${remote} is empty: push a first commit to it from your own clone, then run ` +
        '"configfile update", or set it up with ' +
        `"configfile init --force --repo ${remote} --new-repository".`,
    )
    expect(existsSync(path.join(sandbox.home, 'dotfiles'))).toBe(false)
  })

  it('neither asks nor sets up with --no-new-repository', async () => {
    const { sandbox, remote } = await setUp()

    const result = await runCli(sandbox, ['init', '--repo', remote, '--no-new-repository'])

    expect(result.code, result.stderr).toBe(0)
    expect(result.asked).toEqual([])
    expect(result.stdout).toContain(`${remote} is empty: push a first commit to it`)
  })

  it('says there is nothing to set up when the repository is not empty', async () => {
    const sandbox = await createSandbox()
    const { remote } = await createMirror(sandbox)
    await rm(path.join(sandbox.home, '.configfilerc'))

    const result = await init(sandbox, ['--repo', remote, '--new-repository'])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('The repository is not empty: there is no new repository')
    expect(existsSync(path.join(sandbox.home, 'dotfiles/README.md'))).toBe(false)
  })

  it('does not offer it when set up again after the remote got commits', async () => {
    const { sandbox, remote, mirror } = await setUp()
    git(sandbox.root, 'clone', '--quiet', remote, mirror)
    const other = path.join(sandbox.root, 'other')
    git(sandbox.root, 'clone', '--quiet', remote, other)
    await sandbox.write('other/files/.gitkeep')
    git(other, 'add', '.')
    git(other, 'commit', '--quiet', '-m', 'first')
    git(other, 'push', '--quiet', 'origin', 'main')

    const result = await runCli(sandbox, ['init', '--force', '--repo', remote, '--no-hooks'])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.asked).toEqual([])
    expect(gitText(mirror, 'rev-parse', 'HEAD')).toBe(gitText(remote, 'rev-parse', 'main'))
  })

  it('fails with --new-repository when it cannot tell whether the repository is empty', async () => {
    const { sandbox, remote } = await setUp()
    // git clone does not use it; asking the remote afterwards fails.
    const uploadPack = await sandbox.write(
      'upload-pack',
      "#!/bin/sh\necho 'fatal: no network' >&2\nexit 1\n",
      0o755,
    )
    gitSetting('remote.origin.uploadpack', uploadPack)

    const asked = await init(sandbox, ['--repo', remote, '--new-repository'])
    expect(asked.code).toBe(1)
    expect(asked.stderr).toContain('but whether the repository is empty cannot be told')
    expect(asked.stderr).toContain(
      `run "configfile init --force --repo ${remote} --new-repository"`,
    )

    const unset = await init(sandbox, ['--force', '--repo', remote])
    expect(unset.code, unset.stderr).toBe(0)
    expect(unset.stderr).toContain('Setting up a new repository is not offered')
  })

  it('cannot tell whether a clone without a remote is empty', async () => {
    const { sandbox } = await setUp()
    const folder = path.join(sandbox.root, 'alone')
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', folder])

    await expect(findEmptyRemote(folder)).rejects.toThrow(`${folder} has no remote "origin"`)
  })

  it('uses an existing clone without commits, on the branch the mirror follows', async () => {
    const { sandbox, remote, work } = await setUp()
    // Started with git init on another branch, the remote added by hand.
    execFileSync('git', ['init', '--quiet', '--initial-branch=master', work])
    git(work, 'remote', 'add', 'upstream', remote)
    await sandbox.write('work/notes.txt', 'not for the repository')

    const result = await init(sandbox, [
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(`${work} is now on main, the branch configfile follows`)
    expect(gitText(work, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(gitText(work, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('upstream/main')
    expect(gitText(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n')).toEqual(STARTER)
    expect(gitText(work, 'status', '--porcelain')).toBe('?? notes.txt')
  })

  it('refuses a clone that already has commits, or another repository', async () => {
    const { sandbox, remote, work } = await setUp()
    const elsewhere = await createMirror(await createSandbox())
    git(sandbox.root, 'clone', '--quiet', elsewhere.remote, work)

    const other = await init(sandbox, [
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])
    expect(other.code).toBe(1)
    expect(other.stderr).toContain(`but ${work} is not a clone of ${remote}.`)
    expect((await readConfig(sandbox)).working_copy).toBeUndefined()

    git(work, 'remote', 'add', 'mine', remote)
    const committed = await init(sandbox, [
      '--force',
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])
    expect(committed.code).toBe(1)
    expect(committed.stderr).toContain(`${work} already has commits`)
    expect(gitText(remote, 'for-each-ref')).toBe('')
  })

  it('refuses a clone that has a starter file, or something in its way', async () => {
    const { sandbox, remote, work } = await setUp()
    startedClone(work, remote)
    await sandbox.write('work/README.md', 'mine')

    const readme = await init(sandbox, [
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])
    expect(readme.code).toBe(1)
    expect(readme.stderr).toContain(`${work} already has README.md.`)
    expect(await readFile(path.join(work, 'README.md'), 'utf8')).toBe('mine')
    expect(existsSync(path.join(work, 'configfile.repository.json'))).toBe(false)

    // A file where the starter needs a folder: asked again in a terminal.
    await rm(path.join(work, 'README.md'))
    await sandbox.write('work/files', 'a file')
    const other = path.join(sandbox.root, 'other')
    const blocked = await init(sandbox, ['--force', '--repo', remote], [true, work, other])
    expect(blocked.code, blocked.stderr).toBe(0)
    expect(blocked.stderr).toContain(
      `${work} has something in the way of files/example/configfile.module.json`,
    )
    expect(blocked.stderr).not.toContain('Unexpected error')
    expect(existsSync(path.join(other, 'README.md'))).toBe(true)
    expect(gitText(remote, 'for-each-ref')).not.toBe('')
  })

  it('never commits with an identity git guesses, and runs again once one is set', async () => {
    const { sandbox, remote, work } = await setUp()
    forgetIdentity()

    const result = await init(sandbox, [
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('configfile is configured')
    expect(result.stderr).toContain('git has no name and email of yours to commit with')
    const command = `configfile init --force --repo ${remote} --new-repository --working-copy ${work}`
    expect(result.stderr).toContain(`then run "${command}"`)
    // Cloned and remembered, nothing written in it.
    expect(gitText(work, 'remote')).toBe('origin')
    expect(existsSync(path.join(work, 'README.md'))).toBe(false)
    expect((await readConfig(sandbox)).working_copy).toBe(work)

    vi.stubEnv('GIT_AUTHOR_NAME', 'Me')
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'me@example.com')
    vi.stubEnv('GIT_COMMITTER_NAME', 'Me')
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'me@example.com')
    // The command it gives sets it up in the same working copy.
    const again = await init(sandbox, command.split(' ').slice(2))
    expect(again.code, again.stderr).toBe(0)
    expect(gitText(remote, 'log', '--format=%an', 'main')).toBe('Me')
    expect(existsSync(path.join(work, 'README.md'))).toBe(true)
  })

  it('takes the identity from the settings git uses in the working copy', async () => {
    const { sandbox, remote, work } = await setUp()
    forgetIdentity()
    const personal = await sandbox.write(
      'personal.gitconfig',
      '[user]\n\tname = Personal\n\temail = personal@example.com\n',
    )
    const global = await sandbox.write(
      'global.gitconfig',
      `[includeIf "gitdir:${work}/"]\n\tpath = ${personal}\n`,
    )
    vi.stubEnv('GIT_CONFIG_GLOBAL', global)

    const result = await init(sandbox, [
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])

    expect(result.code, result.stderr).toBe(0)
    expect(gitText(remote, 'log', '--format=%an <%ae>', 'main')).toBe(
      'Personal <personal@example.com>',
    )
  })

  it('pushes to the remote a clone names otherwise (clone.defaultRemoteName)', async () => {
    const { sandbox, remote, work } = await setUp()
    gitSetting('clone.defaultRemoteName', 'upstream')

    const result = await init(sandbox, [
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])

    expect(result.code, result.stderr).toBe(0)
    expect(gitText(work, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('upstream/main')
    expect(gitText(remote, 'log', '--format=%s', 'main')).toBe('Start a dotfiles repository')
  })

  it('leaves the clone as it was when the commit fails, so that init can run again', async () => {
    const { sandbox, remote, work } = await setUp()
    startedClone(work, remote)
    await mkdir(path.join(work, '.git/hooks'), { recursive: true })
    const hook = path.join(work, '.git/hooks/pre-commit')
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    const result = await init(sandbox, [
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('but the new repository could not be committed: git commit')
    const command = `configfile init --force --repo ${remote} --new-repository --working-copy ${work}`
    expect(result.stderr).toContain(`${work} is as it was: once fixed, run "${command}"`)
    expect(gitText(work, 'symbolic-ref', '--short', 'HEAD')).toBe('master')
    expect(gitText(work, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(existsSync(path.join(work, 'files'))).toBe(false)
    expect(gitText(remote, 'for-each-ref')).toBe('')

    await rm(hook)
    const again = await init(sandbox, command.split(' ').slice(2))
    expect(again.code, again.stderr).toBe(0)
    expect(existsSync(path.join(work, 'README.md'))).toBe(true)
  })

  it.skipIf(process.getuid?.() === 0)(
    'removes the files it wrote when one cannot be written',
    async () => {
      const { sandbox, remote, work } = await setUp()
      startedClone(work, remote)
      await mkdir(path.join(work, 'scripts'))
      await chmod(path.join(work, 'scripts'), 0o555)

      const result = await init(sandbox, [
        '--repo',
        remote,
        '--new-repository',
        '--working-copy',
        work,
      ])
      await chmod(path.join(work, 'scripts'), 0o755)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('EACCES')
      expect(result.stderr).toContain(`${work} is as it was`)
      expect(existsSync(path.join(work, 'README.md'))).toBe(false)
      expect(existsSync(path.join(work, 'files'))).toBe(false)
      // There before: kept.
      expect(existsSync(path.join(work, 'scripts'))).toBe(true)
    },
  )

  it('keeps the commit and says how to push it when the push is refused', async () => {
    const { sandbox, remote, work } = await setUp()
    await writeFile(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    })

    const result = await init(sandbox, [
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `the new repository is committed in ${work}, but it was not pushed`,
    )
    expect(result.stderr).toContain(`git -C ${work} push --set-upstream origin main`)
    expect(gitText(work, 'log', '--format=%s')).toBe('Start a dotfiles repository')
    expect((await readConfig(sandbox)).working_copy).toBe(work)
  })

  it('says the repository is pushed when only the sync fails', async () => {
    const { sandbox, remote, work } = await setUp()
    // git clone does not use it: the remote is reached once (is it empty?), then no more.
    const marker = path.join(sandbox.root, 'reached')
    const uploadPack = await sandbox.write(
      'upload-pack',
      `#!/bin/sh\nif [ -e '${marker}' ]; then echo 'fatal: no network' >&2; exit 1; fi\n` +
        `touch '${marker}'\nexec git upload-pack "$@"\n`,
      0o755,
    )
    gitSetting('remote.origin.uploadpack', uploadPack)

    const result = await init(sandbox, [
      '--repo',
      remote,
      '--new-repository',
      '--working-copy',
      work,
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `and the new repository is pushed from ${work}, but configfile's copy of it could not ` +
        'be synced',
    )
    expect(result.stderr).toContain('Run "configfile update".')
    expect(gitText(remote, 'log', '--format=%s', 'main')).toBe('Start a dotfiles repository')

    // Only the failing upload-pack goes: the identity stays.
    vi.stubEnv('GIT_CONFIG_COUNT', '0')
    const update = await runCli(sandbox, ['update'])
    expect(update.code, update.stderr).toBe(0)
  })
})

describe('update and adopt with an empty repository', () => {
  it('update says it is empty, instead of suggesting to clone it again', async () => {
    const { sandbox, remote, work } = await setUp()
    git(sandbox.root, 'clone', '--quiet', remote, work)
    await init(sandbox, ['--repo', remote, '--working-copy', work, '--no-new-repository'])

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'Your dotfiles repository is empty. Push a first commit to it from your own clone, or ' +
        'set it up with "configfile init --force --repo <url> --new-repository"',
    )
    // The working copy has nothing to push yet: no warning about it.
    expect(result.stderr).not.toContain('Cannot use your working copy')
    expect(result.stderr).not.toContain('to clone the repository again')
  })

  it('works once a first commit is pushed: adopt asks to sync first, update syncs', async () => {
    const { sandbox, remote, work } = await setUp()
    git(sandbox.root, 'clone', '--quiet', remote, work)
    await init(sandbox, ['--repo', remote, '--working-copy', work, '--no-new-repository'])
    await sandbox.write('work/files/.gitkeep')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'first')
    git(work, 'push', '--quiet', 'origin', 'main')
    await sandbox.write('home/.zshrc', 'export EDITOR=vim\n')

    const early = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])
    expect(early.code).toBe(1)
    expect(early.stderr).toContain(
      'has no commit yet: run "configfile update" first, which syncs it.',
    )

    const update = await runCli(sandbox, ['update'])
    expect(update.code, update.stderr).toBe(0)
    expect(update.stderr).toBe('')

    const adopt = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])
    expect(adopt.code, adopt.stderr).toBe(0)
  })

  it('still says when the mirror follows no remote branch', async () => {
    const sandbox = await createSandbox()
    const { remote } = await createMirror(sandbox)
    await rm(sandbox.repo, { recursive: true })
    await runCli(sandbox, ['init', '--repo', remote, '--folder', sandbox.repo, '--force'])
    git(sandbox.repo, 'branch', '--unset-upstream')
    // Otherwise a recent git sets origin/HEAD again when it fetches.
    git(sandbox.repo, 'config', 'remote.origin.followRemoteHEAD', 'never')
    git(sandbox.repo, 'remote', 'set-head', 'origin', '--delete')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('follows no remote branch')
    expect(result.stderr).not.toContain('empty')
  })
})

describe('starterFiles', () => {
  const readSchema = async (name: string) =>
    JSON.parse(await readFile(new URL(`../docs/public/schemas/${name}`, import.meta.url), 'utf8'))

  it('makes a repository configfile reads without a warning, and the schemas accept', async () => {
    const sandbox = await createSandbox()
    for (const file of starterFiles('git@github.com:me/dotfiles.git')) {
      const target = path.join(sandbox.repo, file.path)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, file.content)
    }
    const warn = vi.fn()

    const modules = await listModules(sandbox.repo, { ...sandbox, warn })
    const { scripts } = await listScripts(sandbox.repo, null, 'linux', { warn })

    expect(warn).not.toHaveBeenCalled()
    expect(modules).toMatchObject([
      { name: 'example', error: null, files: [], invalidEntries: [], undecided: [] },
    ])
    expect(scripts.map(script => script.name)).toEqual(['hello'])
    const ajv = new Ajv2020({ allErrors: true })
    const read = async (file: string) =>
      JSON.parse(await readFile(path.join(sandbox.repo, file), 'utf8'))
    const module = ajv.compile(await readSchema('module.json'))
    const repository = ajv.compile(await readSchema('repository.json'))
    expect(module(await read('files/example/configfile.module.json'))).toBe(true)
    expect(repository(await read('configfile.repository.json'))).toBe(true)
  })

  it('never writes credentials of the URL in the README', () => {
    const readme = starterFiles('https://me:token@github.com/me/dotfiles.git').find(
      file => file.path === 'README.md',
    )

    expect(readme?.content).toContain('configfile init --repo https://github.com/me/dotfiles.git')
    expect(readme?.content).not.toContain('token')
  })
})
