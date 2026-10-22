import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createMirror,
  createRemote,
  createSandbox,
  createWorkingCopy,
  git,
  readHistory,
  runCli,
  type Sandbox,
} from './helpers.ts'

/** A script that appends its hook and the machine's profiles to `~/ran.txt`. */
const RECORDING = 'echo "$CONFIGFILE_HOOK $CONFIGFILE_PROFILES" >> "$CONFIGFILE_REPO/../ran.txt"\n'

/** What the scripts recorded, next to the repository (`~/dotfiles`, or `~/.configfile/dotfiles` after init). */
async function ran(sandbox: Sandbox, folder = ''): Promise<string> {
  return readFile(path.join(sandbox.home, folder, 'ran.txt'), 'utf8').catch(() => '')
}

/** A mirror whose remote names `script` as its post_update script, with `content`. */
async function withPostUpdate(content = RECORDING, script = 'scripts/brew.sh') {
  const sandbox = await createSandbox()
  const mirror = await createMirror(sandbox)
  await mirror.commitInRemote(script, content)
  await mirror.commitInRemote('configfile.repository.json', '{ "post_update": "brew" }')
  return { sandbox, ...mirror }
}

describe('post_update', () => {
  it('runs after update when the remote moved, and only then', async () => {
    const { sandbox, commitInRemote } = await withPostUpdate()

    const first = await runCli(sandbox, ['update'])
    const unchanged = await runCli(sandbox, ['update'])
    await commitInRemote('README.md', 'readme')
    const skipped = await runCli(sandbox, ['update', '--no-hooks'])
    await commitInRemote('LICENSE', 'license')
    const again = await runCli(sandbox, ['update'])

    expect(first.code).toBe(0)
    expect(first.stdout).toContain('Running "brew", the post_update script of the repository…')
    expect(unchanged.stdout).not.toContain('Running "brew"')
    expect(skipped.stdout).not.toContain('Running "brew"')
    expect(again.code).toBe(0)
    expect(await ran(sandbox)).toBe('post_update \npost_update \n')
    const history = await readHistory(sandbox)
    expect(history.at(-2)?.options).toEqual({ hooks: false })
    expect(history.at(-1)?.changes).toContainEqual(
      expect.objectContaining({ kind: 'script', name: 'brew', hook: 'post_update', exitCode: 0 }),
    )
    expect((await runCli(sandbox, ['history', '-n', '1'])).stdout).toContain(
      'brew  exit 0  (post_update of the repository)',
    )
  })

  it('fails, once synced, when its script fails or does not exist', async () => {
    const failing = await withPostUpdate('exit 3\n')
    const missing = await withPostUpdate(RECORDING, 'scripts/other.sh')

    const failed = await runCli(failing.sandbox, ['update'])
    const notFound = await runCli(missing.sandbox, ['update'])

    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain(
      'The post_update script of the repository, "brew", exited with code 3.',
    )
    expect(failed.stderr).toContain(
      'The repository is synced, but its post_update script did not run to the end: once ' +
        'fixed, run it with "configfile scripts run brew".',
    )
    expect(existsSync(path.join(failing.sandbox.repo, 'scripts/brew.sh'))).toBe(true)
    expect(notFound.code).toBe(1)
    expect(notFound.stderr).toContain(
      'The post_update script of the repository, "brew", is not in scripts/.',
    )
  })

  it('skips a script made for other systems only', async () => {
    const { sandbox } = await withPostUpdate(RECORDING, 'scripts/brew.macos.sh')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'The post_update script of the repository, "brew", has no version for linux, skipped.',
    )
    expect(await ran(sandbox)).toBe('')
  })

  it('is not run by modules adopt, which also syncs', async () => {
    const sandbox = await createSandbox()
    const { work } = await createWorkingCopy(sandbox)
    await sandbox.configure({ working_copy: work })
    await sandbox.write('work/scripts/brew.sh', RECORDING)
    await sandbox.write('work/configfile.repository.json', '{ "post_update": "brew" }')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'post_update')
    await sandbox.write('home/.zshrc', 'zshrc')

    const result = await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', '-m', 'zsh'])

    expect(result.code).toBe(0)
    expect(await ran(sandbox)).toBe('')
  })
})

describe('post_init', () => {
  /** A remote whose repository names `script` as its post_init script. */
  async function remoteWithPostInit(content = RECORDING) {
    const sandbox = await createSandbox()
    const remote = await createRemote(sandbox)
    await sandbox.write('remote/scripts/setup.sh', content)
    await sandbox.write('remote/configfile.repository.json', '{ "post_init": "setup" }')
    git(remote, 'add', '.')
    git(remote, 'commit', '--quiet', '-m', 'post_init')
    return { sandbox, remote }
  }

  it('asks in a terminal before running it, on every init', async () => {
    const { sandbox, remote } = await remoteWithPostInit()

    const accepted = await runCli(sandbox, ['init', '--repo', remote], [true])
    const declined = await runCli(sandbox, ['init', '--force', '--repo', remote], [false])
    const again = await runCli(sandbox, ['init', '--force', '--repo', remote], [true])

    expect(accepted.code).toBe(0)
    expect(accepted.asked).toEqual(['Run "setup", the post_init script of the repository?'])
    expect(declined.stdout).toContain(
      'The post_init script was not run: run it with "configfile scripts run setup" when you want.',
    )
    expect(again.code).toBe(0)
    // The first run, and the re-run of the reused repository.
    expect(await ran(sandbox, '.configfile')).toBe('post_init \npost_init \n')
  })

  it('runs without a terminal only with --hooks, and never with --no-hooks', async () => {
    const { sandbox, remote } = await remoteWithPostInit()
    const init = (...args: string[]) =>
      runCli(sandbox, ['init', '--force', '--repo', remote, ...args], [], { interactive: false })

    const quiet = await init()
    const never = await runCli(sandbox, ['init', '--force', '--repo', remote, '--no-hooks'])
    const hooks = await init('--hooks', '--profile', 'work')

    expect(quiet.code).toBe(0)
    expect(quiet.stdout).toContain(
      'The repository names a post_init script, "setup", not run without a terminal: run it ' +
        'with "configfile scripts run setup" when you want, or use "configfile init --hooks".',
    )
    expect(never).toMatchObject({ code: 0, asked: [] })
    expect(hooks.code).toBe(0)
    expect(await ran(sandbox, '.configfile')).toBe('post_init work\n')
    const history = await readHistory(sandbox)
    expect(history.at(-1)?.options).toMatchObject({ hooks: true })
    expect((await runCli(sandbox, ['history', '-n', '1'])).stdout).toContain('--hooks')
  })

  it('fails when its script fails, once configfile is configured', async () => {
    const { sandbox, remote } = await remoteWithPostInit('exit 2\n')

    const result = await runCli(sandbox, ['init', '--repo', remote, '--hooks'], [], {
      interactive: false,
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `configfile is configured (${path.join(sandbox.home, '.configfilerc')}), but the ` +
        'post_init script of the repository did not run to the end',
    )
    expect(existsSync(path.join(sandbox.home, '.configfilerc'))).toBe(true)
  })
})

describe('modules status and the repository scripts', () => {
  it('lists them, saying when one cannot run here', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/zsh/configfile.module.json', '{ "files": [] }')
    await sandbox.write('home/dotfiles/scripts/brew.sh', RECORDING)
    await sandbox.write(
      'home/dotfiles/configfile.repository.json',
      '{ "post_update": "brew", "post_init": "setup" }',
    )

    const result = await runCli(sandbox, ['modules', 'status'])

    expect(result.stdout).toContain(
      'Repository scripts: post_update "brew", post_init "setup" (not found in scripts/)',
    )
  })
})
