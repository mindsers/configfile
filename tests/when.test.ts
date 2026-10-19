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
  runCli,
  type Sandbox,
} from './helpers.ts'

/** A module, with a file named after it deployed to `~/.<name>`. */
async function writeModule(
  sandbox: Sandbox,
  name: string,
  { when, files, hooks = {} }: { when?: unknown; files?: unknown[]; hooks?: object } = {},
) {
  await sandbox.write(`home/dotfiles/files/${name}/${name}`, name)
  await sandbox.write(
    `home/dotfiles/files/${name}/settings.json`,
    JSON.stringify({
      ...(when !== undefined && { when }),
      ...hooks,
      files: files ?? [{ source_path: name, target_path: `~/.${name}`, deploy: 'global' }],
    }),
  )
}

/** A script that appends its name and the profiles it was given to `~/ran.txt`. */
async function writeScript(sandbox: Sandbox, name: string) {
  await sandbox.write(
    `home/dotfiles/scripts/${name}.sh`,
    `#!/bin/sh\necho "${name} $CONFIGFILE_PROFILES" >> "$CONFIGFILE_REPO/../ran.txt"\n`,
    0o755,
  )
}

async function ran(sandbox: Sandbox): Promise<string> {
  return readFile(path.join(sandbox.home, 'ran.txt'), 'utf8').catch(() => '')
}

async function setUp(profiles: string[] = []) {
  const sandbox = await createSandbox()
  await sandbox.configure({ profiles })
  await writeModule(sandbox, 'zsh')
  await writeModule(sandbox, 'aws', {
    when: { profiles: 'work' },
    hooks: { post_deploy: 'setup' },
  })
  await writeScript(sandbox, 'setup')
  return sandbox
}

const home = (sandbox: Sandbox, file: string) => path.join(sandbox.home, file)

describe('modules for some machines', () => {
  it('deploys only the modules for this machine, and runs only their scripts', async () => {
    const sandbox = await setUp()

    const all = await runCli(sandbox, ['modules', 'deploy', '--all'])
    const named = await runCli(sandbox, ['modules', 'deploy', 'aws'])

    expect(all.code).toBe(0)
    expect(all.stdout).toContain('Not for this machine, skipped: aws.')
    expect(existsSync(home(sandbox, '.zsh'))).toBe(true)
    expect(existsSync(home(sandbox, '.aws'))).toBe(false)
    expect(named).toMatchObject({ code: 0, stderr: '' })
    expect(named.stdout).toContain(
      'aws: not for this machine (for profile "work"; this machine has no profile), skipped.',
    )
    expect(await ran(sandbox)).toBe('')
  })

  it('deploys them on a machine with the profile, and gives the profiles to scripts', async () => {
    const sandbox = await setUp(['work', 'admin'])

    const result = await runCli(sandbox, ['modules', 'deploy', 'aws'])

    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(await readFile(home(sandbox, '.aws'), 'utf8')).toBe('aws')
    expect(await ran(sandbox)).toBe('setup work,admin\n')
  })

  it('skips the entries for other machines inside a module', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/code/settings.json.mac', 'mac')
    await writeModule(sandbox, 'code', {
      files: [
        {
          source_path: 'code',
          target_path: '~/.config/Code/User/settings.json',
          deploy: 'global',
          when: { os: 'linux' },
        },
        {
          source_path: 'settings.json.mac',
          target_path: '~/Library/Application Support/Code/User/settings.json',
          deploy: 'global',
          when: { os: 'macos' },
        },
      ],
    })

    const planned = await runCli(sandbox, ['modules', 'deploy', '-n', 'code'])
    const deployed = await runCli(sandbox, ['modules', 'deploy', 'code'])
    const status = await runCli(sandbox, ['modules', 'status', 'code'])

    const mac = home(sandbox, 'Library/Application Support/Code/User/settings.json')
    expect(planned.stdout).toContain(
      `- ${mac} (not for this machine: for macos; this machine: linux)`,
    )
    expect(deployed.code).toBe(0)
    expect(await readFile(home(sandbox, '.config/Code/User/settings.json'), 'utf8')).toBe('code')
    expect(existsSync(mac)).toBe(false)
    expect(status.stdout).toContain(
      `  ${mac} (not for this machine: for macos; this machine: linux)`,
    )
  })

  it('lists and shows what each module is for', async () => {
    const sandbox = await setUp()

    const list = await runCli(sandbox, ['modules', 'list'])
    const status = await runCli(sandbox, ['modules', 'status'])
    const named = await runCli(sandbox, ['modules', 'status', 'aws'])

    expect(list.stdout).toContain('- aws (for profile "work", not this machine; post_deploy)')
    expect(list.stdout).toContain('- zsh\n')
    expect(status.stdout).not.toContain('aws:')
    expect(status.stdout).toContain(
      'Not for this machine: aws ("configfile modules status <module>" says why).',
    )
    expect(named.stdout).toBe(
      'aws:\n  not for this machine (for profile "work"; this machine has no profile)\n',
    )
  })

  it('warns about a profile of this machine that no module uses', async () => {
    const sandbox = await setUp(['wrok'])

    const status = await runCli(sandbox, ['modules', 'status'])

    expect(status.stderr).toContain(
      `No module is for profile "wrok" (in ${home(sandbox, '.configfilerc')}): the repository uses "work".`,
    )
  })
})

describe('previewing another machine', () => {
  it('shows what status and a dry run would do with another system and profiles', async () => {
    const sandbox = await setUp()

    const status = await runCli(sandbox, [
      'modules',
      'status',
      '--profile',
      'work',
      '--os',
      'macos',
    ])
    const planned = await runCli(sandbox, ['modules', 'deploy', '-n', '--all', '--profile', 'work'])

    expect(status.stdout).toContain('As a machine running macos, with profile "work":')
    expect(status.stdout).toContain(`aws:\n  ${home(sandbox, '.aws')} (not deployed)`)
    expect(planned.stdout).toContain(`- ${home(sandbox, '.aws')} (would be copied)`)
    expect(existsSync(home(sandbox, '.aws'))).toBe(false)
  })

  it('only previews: deploy refuses the options without --dry-run, and checks them', async () => {
    const sandbox = await setUp()

    const deploy = await runCli(sandbox, ['modules', 'deploy', 'aws', '--profile', 'work'])
    const os = await runCli(sandbox, ['modules', 'status', '--os', 'windows'])
    const name = await runCli(sandbox, ['modules', 'status', '--profile', 'my work'])
    const typo = await runCli(sandbox, ['modules', 'status', '--profile', 'wrok'])

    expect(deploy.code).toBe(1)
    expect(deploy.stderr).toContain(
      '--os and --profile only preview another machine: add --dry-run.',
    )
    expect(existsSync(home(sandbox, '.aws'))).toBe(false)
    expect(os.stderr).toContain('--os must be macos or linux, not "windows".')
    expect(name.stderr).toContain('"my work" is not a profile name')
    expect(typo.stderr).toContain('No module is for profile "wrok": the repository uses "work".')
  })
})

describe('files that are no longer for this machine', () => {
  it('are listed apart, warned about, and undeployed on request', async () => {
    const sandbox = await setUp(['work'])
    await runCli(sandbox, ['modules', 'deploy', '--all'])
    await sandbox.configure({ profiles: ['personal'] })

    const status = await runCli(sandbox, ['modules', 'status'])
    const planned = await runCli(sandbox, ['modules', 'undeploy', '--removed', '-n'])
    const undeployed = await runCli(sandbox, ['modules', 'undeploy', '--removed'])

    expect(status.stdout).toContain(
      `No longer for this machine (unless "profiles" in ${home(sandbox, '.configfilerc')} is ` +
        'wrong, run "configfile modules undeploy --removed"):\n' +
        `  ${home(sandbox, '.aws')} (for profile "work"; this machine: "personal"; copied)`,
    )
    expect(status.stdout).not.toContain('No longer deployed by the repository')
    expect(planned.stdout).toContain(`- ${home(sandbox, '.aws')} (would be removed)`)
    expect(undeployed.code).toBe(0)
    expect(existsSync(home(sandbox, '.aws'))).toBe(false)
    expect(existsSync(home(sandbox, '.zsh'))).toBe(true)
  })

  it('are undeployed with their module when it is named, without its scripts', async () => {
    const sandbox = await setUp(['work'])
    await writeModule(sandbox, 'aws', {
      when: { profiles: 'work' },
      hooks: { pre_undeploy: 'setup' },
    })
    await runCli(sandbox, ['modules', 'deploy', 'aws'])
    await sandbox.configure()

    const planned = await runCli(sandbox, ['modules', 'undeploy', 'aws', '-n'])
    const undeployed = await runCli(sandbox, ['modules', 'undeploy', 'aws'])
    const again = await runCli(sandbox, ['modules', 'undeploy', 'aws'])

    expect(planned.stdout).toContain('Files of aws (not for this machine) would be undeployed:')
    expect(undeployed.stdout).toContain('Undeploying the files of aws (not for this machine)…')
    expect(existsSync(home(sandbox, '.aws'))).toBe(false)
    expect(await ran(sandbox)).toBe('')
    expect(again.stdout).toContain(
      'aws is not for this machine (for profile "work"; this machine has no profile): nothing is deployed for it.',
    )
  })
})

describe('update', () => {
  it('warns about the files no longer for this machine', async () => {
    const sandbox = await createSandbox()
    const { commitInRemote } = await createMirror(sandbox)
    await commitInRemote('files/aws/aws', 'aws')
    await commitInRemote(
      'files/aws/settings.json',
      JSON.stringify({
        when: { profiles: 'work' },
        files: [{ source_path: 'aws', target_path: '~/.aws', deploy: 'global' }],
      }),
    )
    await sandbox.configure({ profiles: ['work'] })
    await runCli(sandbox, ['update'])
    await runCli(sandbox, ['modules', 'deploy', 'aws'])
    await sandbox.configure({ profiles: ['personal'] })

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(
      `1 deployed file is no longer for this machine: ${home(sandbox, '.aws')} (for profile ` +
        `"work"; this machine: "personal"). If "profiles" in ${home(sandbox, '.configfilerc')} ` +
        'is right, run "configfile modules undeploy --removed" to remove it.',
    )
    expect(result.stderr).not.toContain('no longer deployed by the repository')
  })
})

describe('the "profiles" setting', () => {
  it('must be a list of profile names', async () => {
    const sandbox = await setUp()
    await sandbox.configure({ profiles: 'work' })

    const result = await runCli(sandbox, ['modules', 'list'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('"profiles" must be a list of profile names')
  })
})

describe('init and profiles', () => {
  async function remoteWithProfiles(sandbox: Sandbox) {
    const remote = await createRemote(sandbox)
    await sandbox.write('remote/files/aws/aws', 'aws')
    await sandbox.write(
      'remote/files/aws/settings.json',
      JSON.stringify({ when: { profiles: ['work', 'client'] }, files: [] }),
    )
    git(remote, 'add', '.')
    git(remote, 'commit', '--quiet', '-m', 'aws')
    return remote
  }
  const savedProfiles = async (sandbox: Sandbox) =>
    JSON.parse(await readFile(home(sandbox, '.configfilerc'), 'utf8')).profiles

  it('saves the profiles given with --profile, and warns about unknown ones', async () => {
    const sandbox = await createSandbox()
    const remote = await remoteWithProfiles(sandbox)

    const result = await runCli(
      sandbox,
      ['init', '--repo', remote, '--profile', 'work', '--profile', 'laptop'],
      [],
      { interactive: false },
    )

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(
      'No module is for profile "laptop" yet: the repository uses "client", "work".',
    )
    expect(await savedProfiles(sandbox)).toEqual(['work', 'laptop'])
  })

  it('asks for the profiles when the repository uses some, refusing unknown names', async () => {
    const sandbox = await createSandbox()
    const remote = await remoteWithProfiles(sandbox)

    const result = await runCli(sandbox, ['init', '--repo', remote], ['work, wrok', 'work, client'])

    expect(result.code).toBe(0)
    expect(result.asked).toEqual([
      'Profiles of this machine (client, work; separate them with commas, or leave empty):',
      'Profiles of this machine (client, work; separate them with commas, or leave empty):',
    ])
    expect(result.refused).toEqual([
      'No module is for profile "wrok": the repository uses "client", "work".',
    ])
    expect(await savedProfiles(sandbox)).toEqual(['work', 'client'])
  })

  it('asks nothing when the repository uses no profile, and refuses invalid names', async () => {
    const sandbox = await createSandbox()
    const remote = await createRemote(sandbox)

    const plain = await runCli(sandbox, ['init', '--repo', remote])
    const invalid = await runCli(sandbox, ['init', '--force', '--repo', remote, '--profile', 'a b'])

    expect(plain).toMatchObject({ code: 0, asked: [] })
    expect(await savedProfiles(sandbox)).toBeUndefined()
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toContain('"a b" is not a profile name')
  })
})

describe('adopt --os and --profile', () => {
  async function setUpAdopt(profiles: string[] = ['work']) {
    const sandbox = await createSandbox()
    const { remote, work } = await createWorkingCopy(sandbox)
    await sandbox.configure({ working_copy: work, profiles })
    return { sandbox, remote, work }
  }
  const settingsOf = async (remote: string, module: string) =>
    JSON.parse(await readFile(path.join(remote, `files/${module}/settings.json`), 'utf8'))

  it('writes "when" on the module it creates, or on the entries it adds', async () => {
    const { sandbox, remote } = await setUpAdopt()
    await sandbox.write('home/.aws/config', 'config')
    await sandbox.write('home/.kube/config', 'kube')

    const created = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.aws',
      '-m',
      'cloud',
      '--os',
      'linux',
      '--profile',
      'work',
    ])
    const added = await runCli(sandbox, [
      'modules',
      'adopt',
      '~/.kube',
      '-m',
      'cloud',
      '--profile',
      'work',
    ])

    expect(created.stderr).toBe('')
    expect(added.stderr).toBe('')
    expect(await settingsOf(remote, 'cloud')).toEqual({
      $schema: 'https://docs.configfile.sh/schemas/settings.json',
      when: { os: 'linux', profiles: 'work' },
      files: [
        { source_path: 'aws', target_path: '~/.aws', deploy: 'global' },
        {
          source_path: 'kube',
          target_path: '~/.kube',
          deploy: 'global',
          when: { profiles: 'work' },
        },
      ],
    })
    expect(added.stdout).toContain(`- ${home(sandbox, '.kube')} (configfile's copy now)`)
  })

  it('refuses conditions and modules that leave this machine out', async () => {
    const { sandbox, work } = await setUpAdopt(['personal'])
    await sandbox.write('home/.zshrc', 'zshrc')
    await sandbox.write(
      'work/files/aws/settings.json',
      JSON.stringify({
        when: { profiles: 'work' },
        files: [{ source_path: 'config', target_path: '~/.zshrc', deploy: 'global' }],
      }),
    )
    await sandbox.write('work/files/aws/config', 'config')
    git(work, 'add', '.')
    git(work, 'commit', '--quiet', '-m', 'aws')

    const adopt = async (...args: string[]) =>
      (await runCli(sandbox, ['modules', 'adopt', '~/.zshrc', ...args])).stderr

    expect(await adopt('-m', 'zsh', '--os', 'macos')).toContain(
      'The files come from this machine, which --os and --profile leave out (for macos; this machine: linux)',
    )
    expect(await adopt('-m', 'zsh', '--profile', 'work')).toContain('leave out (for profile "work"')
    expect(await adopt('-m', 'zsh', '--os', 'windows')).toContain('--os must be "macos" or "linux"')
    expect(await adopt('-m', 'aws')).toContain(
      'Module "aws" is not for this machine (for profile "work"; this machine: "personal")',
    )
    // Deployed by aws on work machines only, but adopting it would clash there.
    expect(await adopt('-m', 'zsh')).toContain('Module aws already deploys')
  })
})
