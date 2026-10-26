import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listModules, listScripts } from '../src/repository.ts'
import { starterFiles } from '../src/starter.ts'

import { createRemote, createSandbox, git, readHistory, runCli, type Sandbox } from './helpers.ts'

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
  // The CLI commits as the user: tests run without the developer's git settings.
  vi.stubEnv('GIT_AUTHOR_NAME', 'test')
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.com')
  vi.stubEnv('GIT_COMMITTER_NAME', 'test')
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.com')
})

/** An empty repository that accepts pushes, in `<sandbox>/remote.git`, on branch `main`. */
function emptyRemote(sandbox: Sandbox): string {
  const remote = path.join(sandbox.root, 'remote.git')
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote])
  return remote
}

async function setUp() {
  const sandbox = await createSandbox()
  const remote = emptyRemote(sandbox)
  const work = path.join(sandbox.root, 'work')
  const mirror = path.join(sandbox.home, '.configfile/dotfiles')
  return { sandbox, remote, work, mirror }
}

const readConfig = async (sandbox: Sandbox) =>
  JSON.parse(await readFile(path.join(sandbox.home, '.configfilerc'), 'utf8'))

describe('init with an empty repository', () => {
  it('sets it up in the working copy with --new-repository: commits, pushes and syncs', async () => {
    const { sandbox, remote, work, mirror } = await setUp()

    const result = await runCli(
      sandbox,
      ['init', '--repo', remote, '--new-repository', '--working-copy', work],
      [],
      { interactive: false },
    )

    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).not.toContain('Warning')
    expect(result.stdout).toContain(`Set up a new dotfiles repository in ${work}`)
    expect(gitText(remote, 'log', '--format=%s', 'main')).toBe('Start a dotfiles repository')
    expect(gitText(remote, 'log', '--format=%an', 'main')).toBe('test')
    expect(gitText(work, 'ls-files').split('\n')).toEqual(STARTER)
    expect(gitText(work, 'ls-files', '--stage', 'scripts/hello.sh')).toMatch(/^100755 /)
    // The working copy follows the remote; the mirror is synced.
    expect(gitText(work, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main')
    expect(gitText(mirror, 'rev-parse', 'HEAD')).toBe(gitText(remote, 'rev-parse', 'main'))
    expect((await readConfig(sandbox)).working_copy).toBe(work)
    const kinds = (await readHistory(sandbox)).flatMap(line => line.changes.map(c => c.kind))
    expect(kinds).toEqual(expect.arrayContaining(['cloned', 'pushed', 'synced']))

    const modules = await runCli(sandbox, ['modules', 'list'])
    expect(modules.stdout).toContain('- example')
    const update = await runCli(sandbox, ['update'])
    expect(update.code, update.stderr).toBe(0)
  })

  it('lets modules adopt add files right after', async () => {
    const { sandbox, remote, work } = await setUp()
    await runCli(
      sandbox,
      ['init', '--repo', remote, '--new-repository', '--working-copy', work],
      [],
      {
        interactive: false,
      },
    )
    await sandbox.write('home/.zshrc', 'export EDITOR=vim\n')

    const result = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])

    expect(result.code, result.stderr).toBe(0)
    expect(gitText(remote, 'show', 'main:files/zsh/zshrc')).toBe('export EDITOR=vim')
  })

  it('asks in a terminal, then where the working copy goes', async () => {
    const { sandbox, remote, work } = await setUp()

    const result = await runCli(sandbox, ['init', '--repo', remote, '--no-hooks'], [true, work])

    expect(result.code, result.stderr).toBe(0)
    expect(result.asked).toEqual([
      `${remote} is empty. Set up a new dotfiles repository in it?`,
      'Your working copy (the clone where you edit your dotfiles):',
    ])
    expect(gitText(remote, 'log', '--format=%s', 'main')).toBe('Start a dotfiles repository')
  })

  it('uses ~/dotfiles without a terminal when no working copy is given', async () => {
    const { sandbox, remote } = await setUp()

    const result = await runCli(sandbox, ['init', '--repo', remote, '--new-repository'], [], {
      interactive: false,
    })

    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(path.join(sandbox.home, 'dotfiles/README.md'))).toBe(true)
  })

  it('asks again when the folder cannot be the working copy', async () => {
    const { sandbox, remote, work, mirror } = await setUp()
    await sandbox.write('taken/notes.txt', 'mine')

    const result = await runCli(
      sandbox,
      ['init', '--repo', remote],
      [true, path.join(sandbox.root, 'taken'), mirror, work],
    )

    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain('is not empty and is not a git repository')
    expect(result.stderr).toContain("is configfile's copy of your dotfiles repository")
    expect(await readFile(path.join(sandbox.root, 'taken/notes.txt'), 'utf8')).toBe('mine')
    expect(existsSync(path.join(work, 'README.md'))).toBe(true)
  })

  it('only says the repository is empty when the answer is no', async () => {
    const { sandbox, remote, work } = await setUp()

    const result = await runCli(sandbox, ['init', '--repo', remote], [false])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('Nothing was set up: push a first commit to it')
    expect(existsSync(work)).toBe(false)
    expect(gitText(remote, 'for-each-ref')).toBe('')
  })

  it('warns without a terminal, and sets nothing up, unless --new-repository is given', async () => {
    const { sandbox, remote } = await setUp()

    const result = await runCli(sandbox, ['init', '--repo', remote], [], { interactive: false })

    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain(
      `${remote} is empty: push a first commit to it from your own clone, then run ` +
        '"configfile update", or set it up with "configfile init --force --new-repository".',
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
    const remote = await createRemote(sandbox)

    const result = await runCli(sandbox, ['init', '--repo', remote, '--new-repository'], [], {
      interactive: false,
    })

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('The repository is not empty: there is no new repository')
    expect(existsSync(path.join(sandbox.home, 'dotfiles'))).toBe(false)
  })

  it('does not offer it when the remote got commits after the mirror was cloned', async () => {
    const { sandbox, remote, mirror } = await setUp()
    git(sandbox.root, 'clone', '--quiet', remote, mirror)
    const other = path.join(sandbox.root, 'other')
    git(sandbox.root, 'clone', '--quiet', remote, other)
    await sandbox.write('other/files/.gitkeep')
    git(other, 'add', '.')
    git(other, 'commit', '--quiet', '-m', 'first')
    git(other, 'push', '--quiet', 'origin', 'main')

    const result = await runCli(sandbox, ['init', '--repo', remote, '--no-hooks'])

    expect(result.code, result.stderr).toBe(0)
    expect(result.asked).toEqual([])
  })

  it('uses an existing clone without commits, on the branch the mirror follows', async () => {
    const { sandbox, remote, work } = await setUp()
    // Started with git init on another branch, the remote added by hand.
    execFileSync('git', ['init', '--quiet', '--initial-branch=master', work])
    git(work, 'remote', 'add', 'upstream', remote)
    await sandbox.write('work/notes.txt', 'not for the repository')

    const result = await runCli(
      sandbox,
      ['init', '--repo', remote, '--new-repository', '--working-copy', work],
      [],
      { interactive: false },
    )

    expect(result.code, result.stderr).toBe(0)
    expect(gitText(work, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(gitText(work, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('upstream/main')
    expect(gitText(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n')).toEqual(STARTER)
    expect(gitText(work, 'status', '--porcelain')).toBe('?? notes.txt')
  })

  it('refuses a clone that already has commits, or another repository', async () => {
    const { sandbox, remote, work } = await setUp()
    const elsewhere = await createRemote(sandbox)
    git(sandbox.root, 'clone', '--quiet', elsewhere, work)

    const other = await runCli(
      sandbox,
      ['init', '--repo', remote, '--new-repository', '--working-copy', work],
      [],
      { interactive: false },
    )
    expect(other.code).toBe(1)
    expect(other.stderr).toContain(`but ${work} is not a clone of ${remote}`)

    git(work, 'remote', 'add', 'mine', remote)
    const committed = await runCli(
      sandbox,
      ['init', '--force', '--repo', remote, '--new-repository', '--working-copy', work],
      [],
      { interactive: false },
    )
    expect(committed.code).toBe(1)
    expect(committed.stderr).toContain(`${work} already has commits`)
    expect(gitText(remote, 'for-each-ref')).toBe('')
  })

  it('fails before writing anything when git does not know who commits', async () => {
    const { sandbox, remote, work } = await setUp()
    vi.stubEnv('GIT_AUTHOR_NAME', undefined)
    vi.stubEnv('GIT_AUTHOR_EMAIL', undefined)
    vi.stubEnv('GIT_COMMITTER_NAME', undefined)
    vi.stubEnv('GIT_COMMITTER_EMAIL', undefined)
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'user.useConfigOnly')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true')

    const result = await runCli(
      sandbox,
      ['init', '--repo', remote, '--new-repository', '--working-copy', work],
      [],
      { interactive: false },
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('configfile is configured')
    expect(result.stderr).toContain('git does not know who you are')
    expect(existsSync(work)).toBe(false)
  })

  it('keeps the commit and says how to push it when the push is refused', async () => {
    const { sandbox, remote, work } = await setUp()
    await writeFile(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    })

    const result = await runCli(
      sandbox,
      ['init', '--repo', remote, '--new-repository', '--working-copy', work],
      [],
      { interactive: false },
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `the new repository is committed in ${work}, but it was not pushed`,
    )
    expect(result.stderr).toContain(`git -C ${work} push --set-upstream origin main`)
    expect(gitText(work, 'log', '--format=%s')).toBe('Start a dotfiles repository')
    expect((await readConfig(sandbox)).working_copy).toBe(work)
  })
})

describe('update with an empty repository', () => {
  it('says it is empty, instead of suggesting to clone it again', async () => {
    const { sandbox, remote } = await setUp()
    await runCli(sandbox, ['init', '--repo', remote, '--no-new-repository'])

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Your dotfiles repository is empty.')
    expect(result.stderr).not.toContain('to clone the repository again')
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
