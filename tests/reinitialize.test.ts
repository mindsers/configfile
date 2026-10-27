import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createSandbox, git, gitSetting, readHistory, runCli, type Sandbox } from './helpers.ts'

/**
 * A repository in `<sandbox>/<name>` whose module zsh deploys `~/.zshrc`,
 * with `settings` added to the module's settings.
 */
async function repository(sandbox: Sandbox, name: string, settings: object = {}) {
  const folder = path.join(sandbox.root, name)
  await sandbox.write(`${name}/files/zsh/zshrc`, `${name}\n`)
  await sandbox.write(
    `${name}/files/zsh/configfile.module.json`,
    JSON.stringify({
      files: [
        { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
        { source_path: 'zshrc', target_path: 'project.conf', deploy: 'local' },
      ],
      ...settings,
    }),
  )
  await sandbox.write(`${name}/scripts/fail.sh`, '#!/bin/sh\nexit 3\n', 0o755)
  git(sandbox.root, 'init', '--quiet', folder)
  git(folder, 'add', '.')
  git(folder, 'commit', '--quiet', '-m', 'first')
  return folder
}

/** configfile set up from `<sandbox>/old`, with `~/.zshrc` deployed over the user's own. */
async function deployed(settings: object = {}, initArgs: string[] = []) {
  const sandbox = await createSandbox()
  const old = await repository(sandbox, 'old', settings)
  const fresh = await repository(sandbox, 'new')
  await sandbox.write('home/.zshrc', 'mine\n')
  const init = await runCli(sandbox, ['init', '--repo', old, '--no-hooks', ...initArgs])
  expect(init.code, init.stderr).toBe(0)
  const deploy = await runCli(sandbox, ['modules', 'deploy', '--all'])
  expect(deploy.code, deploy.stderr).toBe(0)
  return { sandbox, old, fresh }
}

const own = (sandbox: Sandbox) => path.join(sandbox.home, '.configfile')
const mirror = (sandbox: Sandbox) => path.join(own(sandbox), 'dotfiles')
const rc = (sandbox: Sandbox) => path.join(sandbox.home, '.configfilerc')
const zshrc = (sandbox: Sandbox) => readFile(path.join(sandbox.home, '.zshrc'), 'utf8')
const state = (sandbox: Sandbox) => path.join(own(sandbox), 'state.json')
const readConfig = async (sandbox: Sandbox) => JSON.parse(await readFile(rc(sandbox), 'utf8'))
const remoteOf = (folder: string) =>
  execFileSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: folder,
    encoding: 'utf8',
  }).trim()

describe('init, when configfile is already set up', () => {
  it('undeploys everything, deletes the setup, and sets it up from the new repository', async () => {
    const { sandbox, fresh } = await deployed()
    const config = await readConfig(sandbox)
    await sandbox.configure({
      ...config,
      working_copy: path.join(sandbox.root, 'work'),
      profiles: ['work'],
      history_max_size: '5MB',
    })

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])

    expect(result.code, result.stderr).toBe(0)
    // The lock stays, untouched: releasing it said nothing.
    expect(result.stderr).toBe('')
    expect(await zshrc(sandbox)).toBe('mine\n')
    expect(existsSync(path.join(sandbox.home, '.zshrc.old'))).toBe(false)
    expect(remoteOf(mirror(sandbox))).toBe(fresh)
    // A fresh configuration: nothing of the previous one is kept.
    expect(await readConfig(sandbox)).toEqual({ repo_url: fresh, folder_path: mirror(sandbox) })
    expect(existsSync(path.join(own(sandbox), 'state.json'))).toBe(false)
    // The history starts again, with this run: the configuration is deleted last.
    const history = await readHistory(sandbox)
    expect(history).toHaveLength(1)
    const changes = history[0]?.changes ?? []
    expect(changes[0]).toEqual({
      kind: 'removed',
      target: path.join(sandbox.home, '.zshrc'),
      backup: { path: path.join(sandbox.home, '.zshrc.old'), status: 'restored' },
    })
    expect(changes.slice(-3)).toEqual([
      { kind: 'deleted', path: rc(sandbox) },
      { kind: 'cloned', repository: fresh, folder: mirror(sandbox) },
      { kind: 'configured', file: rc(sandbox) },
    ])
    expect(changes).toContainEqual({ kind: 'deleted', path: mirror(sandbox) })
    expect(changes).toContainEqual({ kind: 'deleted', path: state(sandbox) })
    expect(result.stdout).toContain(
      `Deleted the previous setup: what ${own(sandbox)} held and ${rc(sandbox)}.`,
    )
    const shown = await runCli(sandbox, ['history'])
    expect(shown.stdout).toMatch(/deleted +\S*\.configfilerc\n/)
  })

  it('asks first in a terminal, and changes nothing when the answer is no', async () => {
    const { sandbox, old, fresh } = await deployed()

    const result = await runCli(sandbox, ['init', '--repo', fresh], [false])

    expect(result.code).toBe(0)
    expect(result.asked).toEqual([
      'configfile is already set up. Set it up again? It undeploys the files it deployed (your ' +
        `previous files come back), then deletes what ${own(sandbox)} holds (its copy of the repository, ` +
        `its history and the changes it saved) and ${rc(sandbox)} (its configuration), and ` +
        'clones the repository again.',
    ])
    expect(result.stdout).toContain('Nothing changed.')
    expect(await zshrc(sandbox)).toBe('old\n')
    expect(remoteOf(mirror(sandbox))).toBe(old)
  })

  it('needs --force without a terminal', async () => {
    const { sandbox, old, fresh } = await deployed()

    const result = await runCli(sandbox, ['init', '--repo', fresh], [], { interactive: false })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'Also pass: --force (configfile is already set up, and --force sets it up again).',
    )
    expect(await zshrc(sandbox)).toBe('old\n')
    expect(remoteOf(mirror(sandbox))).toBe(old)
  })

  it('changes nothing when the repository cannot be reached', async () => {
    const { sandbox, old } = await deployed()
    // A folder, but not a repository.
    const unreachable = path.join(sandbox.root, 'cwd')

    const result = await runCli(sandbox, ['init', '--force', '--repo', unreachable])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `${unreachable} cannot be reached, so configfile was not set up again: nothing changed.`,
    )
    expect(await zshrc(sandbox)).toBe('old\n')
    expect((await readConfig(sandbox)).repo_url).toBe(old)
    expect(existsSync(state(sandbox))).toBe(true)
  })

  it('refuses a new folder that holds something, before undeploying anything', async () => {
    const { sandbox, fresh } = await deployed()
    await sandbox.write('home/taken/notes.txt', 'mine')

    const result = await runCli(sandbox, [
      'init',
      '--force',
      '--repo',
      fresh,
      '--folder',
      '~/taken',
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`${path.join(sandbox.home, 'taken')} is not empty`)
    expect(await zshrc(sandbox)).toBe('old\n')
    expect(existsSync(rc(sandbox))).toBe(true)
  })

  it("refuses configfile's own folder, which it does not delete", async () => {
    const { sandbox, fresh } = await deployed()

    const result = await runCli(sandbox, [
      'init',
      '--force',
      '--repo',
      fresh,
      '--folder',
      own(sandbox),
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`${own(sandbox)} is not empty`)
    expect(await zshrc(sandbox)).toBe('old\n')
  })

  it('refuses to clone from the folder it is about to delete', async () => {
    const { sandbox, old } = await deployed()

    const result = await runCli(sandbox, ['init', '--force', '--repo', mirror(sandbox)])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `${mirror(sandbox)} is deleted when configfile is set up again, before the repository is cloned`,
    )
    expect(await zshrc(sandbox)).toBe('old\n')
    expect(remoteOf(mirror(sandbox))).toBe(old)
  })

  it('refuses a working copy inside the folder it deletes', async () => {
    const { sandbox, fresh } = await deployed()
    const work = path.join(own(sandbox), 'work')
    await sandbox.configure({ ...(await readConfig(sandbox)), working_copy: work })

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `Your working copy, ${work}, is inside ${own(sandbox)}, which setting configfile up again deletes.`,
    )
    expect(await zshrc(sandbox)).toBe('old\n')
  })

  it('undeploys from the record when the clone is gone', async () => {
    const { sandbox, fresh } = await deployed()
    await rm(mirror(sandbox), { recursive: true })

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])

    expect(result.code, result.stderr).toBe(0)
    // Without the scripts, the record is used anyway: no warning.
    expect(result.stderr).toBe('')
    expect(await zshrc(sandbox)).toBe('mine\n')
    expect(remoteOf(mirror(sandbox))).toBe(fresh)
  })

  it('stops before deleting anything when a script fails, and skips scripts with --no-hooks', async () => {
    const { sandbox, old, fresh } = await deployed({ pre_undeploy: 'fail' })

    const failed = await runCli(sandbox, ['init', '--force', '--repo', fresh])

    expect(failed.code).not.toBe(0)
    expect(failed.stderr).toContain(
      'configfile was not set up again: nothing was deleted, but the files undeployed so far ' +
        'stay undeployed',
    )
    expect(failed.stderr).toContain('with --no-hooks, it undeploys from its record')
    // init has no --keep-going.
    expect(failed.stderr).not.toContain('--keep-going')
    expect(await zshrc(sandbox)).toBe('old\n')
    expect(remoteOf(mirror(sandbox))).toBe(old)
    expect((await readConfig(sandbox)).repo_url).toBe(old)
    expect(existsSync(state(sandbox))).toBe(true)

    const skipped = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])

    expect(skipped.code, skipped.stderr).toBe(0)
    expect(await zshrc(sandbox)).toBe('mine\n')
    expect(remoteOf(mirror(sandbox))).toBe(fresh)
  })

  it('deletes a clone it made in another folder', async () => {
    const { sandbox, fresh } = await deployed({}, ['--folder', '~/clone'])
    const clone = path.join(sandbox.home, 'clone')

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])

    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(clone)).toBe(false)
    expect((await readHistory(sandbox))[0]?.changes).toContainEqual({
      kind: 'deleted',
      path: clone,
    })
    expect(remoteOf(mirror(sandbox))).toBe(fresh)
  })

  it('leaves local copies in place, and says so', async () => {
    const { sandbox, fresh } = await deployed()
    const local = await runCli(sandbox, ['modules', 'deploy', '--local', 'zsh'])
    expect(local.code, local.stderr).toBe(0)

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      '1 local copy made in project folders stays: configfile no longer tracks it.',
    )
    expect(await readFile(path.join(sandbox.cwd, 'project.conf'), 'utf8')).toBe('old\n')
  })

  it('does not count the history of a first init that failed', async () => {
    const sandbox = await createSandbox()
    const fresh = await repository(sandbox, 'new')
    const failed = await runCli(sandbox, ['init', '--repo', path.join(sandbox.root, 'cwd')])
    expect(failed.code).not.toBe(0)
    expect(existsSync(path.join(own(sandbox), 'history.jsonl'))).toBe(true)
    expect(existsSync(mirror(sandbox))).toBe(false)

    const result = await runCli(sandbox, ['init', '--repo', fresh, '--no-hooks'], [], {
      interactive: false,
    })

    expect(result.code, result.stderr).toBe(0)
    expect(remoteOf(mirror(sandbox))).toBe(fresh)
  })

  it('warns when the configuration cannot be read, and undeploys from the record', async () => {
    const { sandbox, fresh } = await deployed()
    await writeFile(rc(sandbox), '{ broken')

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain('The scripts of the modules are not run: ')
    expect(await zshrc(sandbox)).toBe('mine\n')
  })

  it('undeploys from the record when the clone lost its .git', async () => {
    const { sandbox, fresh } = await deployed()
    await rm(path.join(mirror(sandbox), '.git'), { recursive: true })

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])

    expect(result.code, result.stderr).toBe(0)
    expect(await zshrc(sandbox)).toBe('mine\n')
    expect(remoteOf(mirror(sandbox))).toBe(fresh)
  })

  it('undeploys a link from the record when the clone is gone', async () => {
    const { sandbox, fresh } = await deployed({
      files: [{ source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global', method: 'link' }],
    })
    await rm(mirror(sandbox), { recursive: true })

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain(
      `The scripts of the modules are not run: ${mirror(sandbox)} is missing.`,
    )
    expect(await zshrc(sandbox)).toBe('mine\n')
  })

  it('stops on a module it cannot read, and undeploys from the record with --no-hooks', async () => {
    const { sandbox, fresh } = await deployed()
    await writeFile(path.join(mirror(sandbox), 'files/zsh/configfile.module.json'), '{ broken')

    const failed = await runCli(sandbox, ['init', '--force', '--repo', fresh])

    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('with --no-hooks, it undeploys from its record')
    expect(await zshrc(sandbox)).toBe('old\n')

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])

    expect(result.code, result.stderr).toBe(0)
    expect(await zshrc(sandbox)).toBe('mine\n')
    expect(remoteOf(mirror(sandbox))).toBe(fresh)
  })

  it('keeps a copy changed on this machine, and says it no longer tracks it', async () => {
    const { sandbox, fresh } = await deployed()
    await sandbox.write('home/.zshrc', 'edited\n')

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh])

    expect(result.code, result.stderr).toBe(0)
    expect(await zshrc(sandbox)).toBe('edited\n')
    expect(existsSync(path.join(sandbox.home, '.zshrc.old'))).toBe(true)
    expect(result.stdout.match(/\(kept: /g)).toHaveLength(1)
    expect(result.stdout).toContain(
      '1 file changed on this machine stays: configfile no longer tracks it.',
    )
    const changes = (await readHistory(sandbox))[0]?.changes ?? []
    expect(changes.filter(change => change.kind === 'kept')).toHaveLength(1)
  })

  it('counts as set up with only its deployment record', async () => {
    const { sandbox, fresh } = await deployed()
    await rm(rc(sandbox))

    const refused = await runCli(sandbox, ['init', '--repo', fresh], [], { interactive: false })
    expect(refused.code).toBe(1)
    expect(await zshrc(sandbox)).toBe('old\n')

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh])

    expect(result.code, result.stderr).toBe(0)
    expect(await zshrc(sandbox)).toBe('mine\n')
  })

  it('keeps a clone marked only in the global git settings', async () => {
    const { sandbox, fresh } = await deployed({}, ['--folder', '~/clone'])
    const clone = path.join(sandbox.home, 'clone')
    git(clone, 'config', '--unset', 'configfile.clone')
    gitSetting('configfile.clone', 'true')

    try {
      const result = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])

      expect(result.code, result.stderr).toBe(0)
      expect(existsSync(clone)).toBe(true)
      expect(result.stdout).toContain(`${clone} is kept: configfile cannot tell it cloned it.`)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('deletes its configuration last, so that a failed deletion can be finished', async () => {
    const { sandbox, fresh } = await deployed({}, ['--folder', '~/clone'])
    const clone = path.join(sandbox.home, 'clone')
    const locked = path.join(clone, 'files', 'zsh')
    await chmod(locked, 0o555)

    let failed: Awaited<ReturnType<typeof runCli>>
    try {
      failed = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])
    } finally {
      await chmod(locked, 0o755)
    }

    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain(`Cannot delete ${clone}`)
    expect(failed.stderr).toContain(
      'Every file configfile deployed is undeployed, and its configuration is kept',
    )
    expect(await zshrc(sandbox)).toBe('mine\n')
    expect(existsSync(rc(sandbox))).toBe(true)

    const result = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])

    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(clone)).toBe(false)
    expect(remoteOf(mirror(sandbox))).toBe(fresh)
  })

  it('says the setup is deleted when the clone fails after it', async () => {
    const { sandbox, fresh } = await deployed()
    // Its references can be read, but nothing can be cloned from it.
    await rm(path.join(fresh, '.git', 'objects'), { recursive: true })
    await mkdir(path.join(fresh, '.git', 'objects'))

    const failed = await runCli(sandbox, ['init', '--force', '--repo', fresh, '--no-hooks'])

    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain(
      'The previous setup was deleted first: once fixed, run "configfile init" again',
    )
    expect(await zshrc(sandbox)).toBe('mine\n')
    expect(existsSync(rc(sandbox))).toBe(false)
    expect(existsSync(mirror(sandbox))).toBe(false)

    const other = path.join(sandbox.root, 'old')
    const result = await runCli(sandbox, ['init', '--repo', other, '--no-hooks'], [], {
      interactive: false,
    })
    expect(result.code, result.stderr).toBe(0)
  })

  it('clones again into the folder of the clone it made', async () => {
    const { sandbox, fresh } = await deployed({}, ['--folder', '~/clone'])
    const clone = path.join(sandbox.home, 'clone')

    const result = await runCli(sandbox, [
      'init',
      '--force',
      '--repo',
      fresh,
      '--folder',
      '~/clone',
      '--no-hooks',
    ])

    expect(result.code, result.stderr).toBe(0)
    expect(remoteOf(clone)).toBe(fresh)
  })
})
