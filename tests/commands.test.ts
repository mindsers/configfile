import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { COMMANDS } from '../src/history.ts'
import { buildProgram } from '../src/program.ts'
import {
  createContext,
  createRemote,
  createSandbox,
  git,
  readHistory,
  runCli,
  type Sandbox,
} from './helpers.ts'

async function withModule(sandbox: Sandbox) {
  await sandbox.configure()
  await sandbox.write('home/dotfiles/files/zsh/zshrc', 'zshrc')
  await sandbox.write('home/dotfiles/files/zsh/a', 'repo a')
  await sandbox.write('home/dotfiles/files/zsh/b', 'repo b')
  await sandbox.write('home/dotfiles/files/zsh/parked', 'parked')
  await sandbox.write('home/dotfiles/files/zsh/forgotten', 'forgotten')
  await sandbox.write(
    'home/dotfiles/files/zsh/settings.json',
    JSON.stringify({
      files: [
        { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
        { source_path: 'a', target_path: 'a', deploy: 'local' },
        { source_path: 'b', target_path: 'b', deploy: 'local' },
        { source_path: 'parked', target_path: '~/.parked', deploy: 'none' },
        { source_path: 'forgotten', target_path: '~/.forgotten' },
      ],
    }),
  )
}

function exitPromptError() {
  const error = new Error('User force closed the prompt')
  error.name = 'ExitPromptError'
  return error
}

describe('without configuration', () => {
  it.each([
    ['modules', 'list'],
    ['modules', 'deploy', 'zsh'],
    ['scripts', 'list'],
    ['scripts', 'run', 'setup'],
  ])('"%s %s" asks to run init and exits with 1', async (...args) => {
    const sandbox = await createSandbox()

    const result = await runCli(sandbox, args)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Run "configfile init" first.')
    expect(result.stdout).toBe('')
  })
})

describe('modules', () => {
  it('lists modules, also as the default subcommand and through aliases', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    for (const args of [['modules', 'list'], ['modules'], ['m', 'l']]) {
      const result = await runCli(sandbox, args)
      expect(result).toMatchObject({ code: 0, stdout: '1 module found.\n- zsh\n' })
    }
  })

  it('links global files', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    const result = await runCli(sandbox, ['modules', 'deploy', 'zsh'])

    expect(result.code).toBe(0)
    expect(await readlink(path.join(sandbox.home, '.zshrc'))).toBe(
      path.join(sandbox.repo, 'files/zsh/zshrc'),
    )
    expect(existsSync(path.join(sandbox.cwd, 'a'))).toBe(false)
  })

  it('never deploys "deploy": "none" files, and warns about files without a strategy', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    for (const args of [
      ['modules', 'deploy', 'zsh'],
      ['modules', 'deploy', '--local', 'zsh'],
    ]) {
      const result = await runCli(sandbox, args)

      expect(result.code).toBe(0)
      expect(result.stderr).toContain(
        'zsh: "forgotten" was not deployed because no deployment strategy is defined.',
      )
      expect(result.stderr).not.toContain('parked')
    }

    expect(existsSync(path.join(sandbox.home, '.zshrc'))).toBe(true)
    expect(existsSync(path.join(sandbox.cwd, 'a'))).toBe(true)
    expect(existsSync(path.join(sandbox.home, '.parked'))).toBe(false)
    expect(existsSync(path.join(sandbox.home, '.forgotten'))).toBe(false)
  })

  it('keeps deploying after a conflict and then asks about it', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('cwd/a', 'mine')

    const result = await runCli(sandbox, ['modules', 'deploy', '--local', 'zsh'], [false])

    expect(result.code).toBe(0)
    expect(result.asked).toEqual([
      `${path.join(sandbox.cwd, 'a')} already exists. Replace it (the current one is moved to .old)?`,
    ])
    // The question comes after the other files are deployed.
    expect(result.stdout.indexOf('/b (deployed)')).toBeGreaterThan(-1)
    expect(result.stdout.indexOf('/b (deployed)')).toBeLessThan(
      result.stdout.indexOf('/a (already exists, skipped)'),
    )
    expect(await readFile(path.join(sandbox.cwd, 'a'), 'utf8')).toBe('mine')
    expect(await readFile(path.join(sandbox.cwd, 'b'), 'utf8')).toBe('repo b')
    expect(existsSync(path.join(sandbox.home, '.zshrc'))).toBe(false)
  })

  it('overwrites a conflicting local file when the user agrees', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('cwd/a', 'mine')

    const result = await runCli(sandbox, ['m', 'd', '-l', 'zsh'], [true])

    expect(result.code).toBe(0)
    expect(await readFile(path.join(sandbox.cwd, 'a'), 'utf8')).toBe('repo a')
    expect(await readFile(path.join(sandbox.cwd, 'a.old'), 'utf8')).toBe('mine')
  })

  it('replaces conflicting local files without asking with --force', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('cwd/a', 'mine')

    const result = await runCli(sandbox, ['modules', 'deploy', '-l', '--force', 'zsh'])

    expect(result).toMatchObject({ code: 0, asked: [] })
    expect(await readFile(path.join(sandbox.cwd, 'a'), 'utf8')).toBe('repo a')
    expect(await readFile(path.join(sandbox.cwd, 'a.old'), 'utf8')).toBe('mine')
  })

  it('without a terminal, skips every conflict, deploys the rest and fails with a hint', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('cwd/a', 'mine')
    await sandbox.write('cwd/b', 'mine too')
    await sandbox.write('home/dotfiles/files/zsh/c', 'repo c')
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      JSON.stringify({
        files: ['a', 'b', 'c'].map(name => ({
          source_path: name,
          target_path: name,
          deploy: 'local',
        })),
      }),
    )

    const result = await runCli(sandbox, ['m', 'd', '-l', 'zsh'], [], { interactive: false })

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('/a (already exists, skipped)')
    expect(result.stdout).toContain('/b (already exists, skipped)')
    expect(result.stderr).toContain('2 files already existed. Use --force to replace them.')
    expect(await readFile(path.join(sandbox.cwd, 'c'), 'utf8')).toBe('repo c')
    expect(await readFile(path.join(sandbox.cwd, 'a'), 'utf8')).toBe('mine')
  })

  it('keeps deployed files when Ctrl+C is pressed at a conflict question', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('cwd/a', 'mine')

    const result = await runCli(sandbox, ['m', 'd', '-l', 'zsh'], [exitPromptError()])

    expect(result.code).toBe(130)
    expect(await readFile(path.join(sandbox.cwd, 'a'), 'utf8')).toBe('mine')
    expect(await readFile(path.join(sandbox.cwd, 'b'), 'utf8')).toBe('repo b')
  })

  it('moves an existing file aside on first deploy, and is idempotent afterwards', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('home/.zshrc', 'mine')

    const first = await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    expect(first.code).toBe(0)
    expect(first.stdout).toContain(`(deployed, previous file moved to ${sandbox.home}/.zshrc.old)`)
    expect(await readFile(path.join(sandbox.home, '.zshrc.old'), 'utf8')).toBe('mine')

    const second = await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('.zshrc (already up to date)')
    expect(existsSync(path.join(sandbox.home, '.zshrc.old.1'))).toBe(false)
  })

  it('deploys every module without asking with --all', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    const result = await runCli(sandbox, ['modules', 'deploy', '--all'])

    expect(result).toMatchObject({ code: 0, asked: [] })
    expect(existsSync(path.join(sandbox.home, '.zshrc'))).toBe(true)
    expect((await runCli(sandbox, ['m', 'd', '--all', 'zsh'])).stderr).toContain('not both')
  })

  it('without a terminal and without module names, asks for names or --all', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    const result = await runCli(sandbox, ['modules', 'deploy'], [], { interactive: false })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Pass module names, or --all')
  })

  it('refuses to deploy a module whose settings.json is broken', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('home/dotfiles/files/broken/settings.json', '{')

    const listed = await runCli(sandbox, ['modules', 'list'])
    expect(listed.stdout).toContain('- broken (ignored: settings.json is not valid JSON')

    const named = await runCli(sandbox, ['modules', 'deploy', 'broken'])
    expect(named.code).toBe(1)
    expect(named.stderr).toContain(
      'Module "broken" cannot be deployed: settings.json is not valid JSON',
    )

    const all = await runCli(sandbox, ['modules', 'deploy', '--all'])
    expect(all.code).toBe(1)
    expect(all.stderr).toContain('Module "broken" was not deployed')
    expect(existsSync(path.join(sandbox.home, '.zshrc'))).toBe(true)
  })

  it('asks before deploying every module', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    const declined = await runCli(sandbox, ['modules', 'deploy'], [false])
    expect(declined).toMatchObject({ code: 0, asked: [expect.stringContaining('Deploy all')] })
    expect(existsSync(path.join(sandbox.home, '.zshrc'))).toBe(false)

    const accepted = await runCli(sandbox, ['modules', 'deploy'], [true])
    expect(accepted.code).toBe(0)
    expect(existsSync(path.join(sandbox.home, '.zshrc'))).toBe(true)
  })

  it('rejects unknown modules before deploying anything', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    const result = await runCli(sandbox, ['modules', 'deploy', 'zsh', 'nope'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown module: nope')
    expect(existsSync(path.join(sandbox.home, '.zshrc'))).toBe(false)
  })

  it('reports files that fail and exits with 1', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write(
      'home/dotfiles/files/broken/settings.json',
      JSON.stringify({ files: [{ source_path: 'missing', target_path: '~/x', deploy: 'global' }] }),
    )

    const result = await runCli(sandbox, ['modules', 'deploy', 'broken'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('does not exist')
    expect(result.stderr).toContain('1 file, module or settings entry failed.')
  })

  it('exits with 130 when a prompt is cancelled with Ctrl+C', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    const result = await runCli(sandbox, ['modules', 'deploy'], [exitPromptError()])

    expect(result.code).toBe(130)
    expect(result.stdout).toContain('Cancelled.')
  })
})

describe('modules status, dry run and undeploy', () => {
  it('shows the state of each file', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    const before = await runCli(sandbox, ['modules', 'status'])
    expect(before.code).toBe(0)
    expect(before.stdout).toBe(
      `zsh:\n  ${sandbox.home}/.zshrc (not deployed)\n  forgotten (no deployment strategy)\n`,
    )

    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    const after = await runCli(sandbox, ['m', 'st', 'zsh'])
    expect(after.stdout).toContain(`${sandbox.home}/.zshrc (deployed)`)

    await sandbox.write('cwd/a', 'edited')
    const local = await runCli(sandbox, ['modules', 'status', '--local'])
    expect(local.stdout).toContain(`${sandbox.cwd}/a (not deployed: a file is in the way)`)
    expect(local.stdout).toContain(`${sandbox.cwd}/b (not deployed)`)
  })

  it('shows what a deployment would do without changing anything', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('home/.zshrc', 'mine')

    const result = await runCli(sandbox, ['modules', 'deploy', '--dry-run', 'zsh'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `${sandbox.home}/.zshrc (would be linked, the existing file moved to ${sandbox.home}/.zshrc.old)`,
    )
    expect(await readFile(path.join(sandbox.home, '.zshrc'), 'utf8')).toBe('mine')

    await sandbox.write('cwd/a', 'mine')
    const local = await runCli(sandbox, ['m', 'd', '-n', '-l', 'zsh'], [], { interactive: false })
    expect(local.stdout).toContain(
      '/a (already exists: would be skipped (use --force to replace it))',
    )
    expect(local.stdout).toContain('/b (would be copied)')
    expect(existsSync(path.join(sandbox.cwd, 'b'))).toBe(false)
  })

  it('undeploys: removes links, restores backups and keeps what it did not deploy', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('home/.zshrc', 'mine')
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])

    const dryRun = await runCli(sandbox, ['modules', 'undeploy', '-n', 'zsh'])
    expect(dryRun.stdout).toContain(`(would be removed, ${sandbox.home}/.zshrc.old restored)`)
    expect((await lstat(path.join(sandbox.home, '.zshrc'))).isSymbolicLink()).toBe(true)

    const result = await runCli(sandbox, ['modules', 'undeploy', 'zsh'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`(removed, ${sandbox.home}/.zshrc.old restored)`)
    expect(await readFile(path.join(sandbox.home, '.zshrc'), 'utf8')).toBe('mine')

    const again = await runCli(sandbox, ['modules', 'undeploy', 'zsh'])
    expect(again.stdout).toContain('(kept: the file there was not deployed by configfile)')
    expect(await readFile(path.join(sandbox.home, '.zshrc'), 'utf8')).toBe('mine')
  })

  it('undeploys local copies unless they were modified', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await runCli(sandbox, ['modules', 'deploy', '--local', 'zsh'])
    await sandbox.write('cwd/a', 'edited')

    const result = await runCli(sandbox, ['m', 'u', '-l', 'zsh'])

    expect(result.code).toBe(0)
    expect(await readFile(path.join(sandbox.cwd, 'a'), 'utf8')).toBe('edited')
    expect(existsSync(path.join(sandbox.cwd, 'b'))).toBe(false)
  })

  it('asks before undeploying every module, and needs --all without a terminal', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])

    const declined = await runCli(sandbox, ['modules', 'undeploy'], [false])
    expect(declined).toMatchObject({ code: 0, asked: [expect.stringContaining('Undeploy all')] })

    const nonInteractive = await runCli(sandbox, ['modules', 'undeploy'], [], {
      interactive: false,
    })
    expect(nonInteractive.stderr).toContain('or --all to undeploy every module')

    await runCli(sandbox, ['modules', 'undeploy', '--all'])
    expect(existsSync(path.join(sandbox.home, '.zshrc'))).toBe(false)
  })

  it('only restores the backups it made, recorded in ~/.configfile/state.json', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('home/.zshrc', 'mine')
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])

    const state = JSON.parse(
      await readFile(path.join(sandbox.home, '.configfile/state.json'), 'utf8'),
    )
    const zshrc = path.join(sandbox.home, '.zshrc')
    expect(state).toEqual({
      version: 2,
      targets: {
        [zshrc]: {
          target: zshrc,
          deployed: {
            strategy: 'global',
            source: path.join(sandbox.repo, 'files/zsh/zshrc'),
            identity: { dev: expect.any(Number), ino: expect.any(Number) },
            entry: {
              module: 'files/zsh',
              source: 'zshrc',
              target: '~/.zshrc',
              folder: sandbox.home,
            },
          },
          backups: [
            {
              path: `${zshrc}.old`,
              identity: { dev: expect.any(Number), ino: expect.any(Number) },
              kind: 'file',
              modified: expect.any(Number),
            },
          ],
        },
      },
    })

    await runCli(sandbox, ['modules', 'undeploy', 'zsh'])
    // A .old file made by hand is left alone.
    await sandbox.write('home/.zshrc.old', 'made by hand')
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    const result = await runCli(sandbox, ['modules', 'undeploy', 'zsh'])

    expect(result.stdout).toContain(
      `${sandbox.home}/.zshrc (removed, ${sandbox.home}/.zshrc.old.1 restored)`,
    )
    expect(await readFile(path.join(sandbox.home, '.zshrc'), 'utf8')).toBe('mine')
    expect(await readFile(path.join(sandbox.home, '.zshrc.old'), 'utf8')).toBe('made by hand')
  })

  it('fails when settings entries of the selected modules are invalid, after deploying the rest', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      JSON.stringify({
        files: [
          { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
          { source_path: 'a', deploy: 'global' },
        ],
      }),
    )
    await sandbox.write(
      'home/dotfiles/files/other/settings.json',
      JSON.stringify({ files: [{ source_path: 'x', deploy: 'global' }] }),
    )

    const result = await runCli(sandbox, ['modules', 'deploy', 'zsh'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('zsh: entry #2 is ignored: "target_path" is missing.')
    expect(result.stderr).not.toContain('other:')
    expect(result.stderr).toContain('1 file, module or settings entry failed.')
    expect(existsSync(path.join(sandbox.home, '.zshrc'))).toBe(true)
  })

  it('gives a dry run the exit code of the real run', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('cwd/a', 'mine')

    const result = await runCli(sandbox, ['m', 'd', '-n', '-l', 'zsh'], [], { interactive: false })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('1 file already existed. Use --force to replace them.')
  })

  it.skipIf(process.getuid?.() === 0)(
    'keeps showing the status after a file that cannot be checked',
    async () => {
      const sandbox = await createSandbox()
      await sandbox.configure()
      await sandbox.write('home/dotfiles/files/a/f', 'f')
      await sandbox.write(
        'home/dotfiles/files/a/settings.json',
        JSON.stringify({
          files: [{ source_path: 'f', target_path: '~/locked/f', deploy: 'global' }],
        }),
      )
      await sandbox.write('home/dotfiles/files/b/g', 'g')
      await sandbox.write(
        'home/dotfiles/files/b/settings.json',
        JSON.stringify({ files: [{ source_path: 'g', target_path: '~/.g', deploy: 'global' }] }),
      )
      await mkdir(path.join(sandbox.home, 'locked'))
      await chmod(path.join(sandbox.home, 'locked'), 0o000)

      try {
        const result = await runCli(sandbox, ['modules', 'status'])

        expect(result.code).toBe(0)
        expect(result.stdout).toContain(`${sandbox.home}/locked/f (cannot be checked:`)
        expect(result.stdout).toContain(`b:\n  ${sandbox.home}/.g (not deployed)`)
      } finally {
        await chmod(path.join(sandbox.home, 'locked'), 0o755)
      }
    },
  )

  it('deploys a repository written for configfile 0.3.1 (list format)', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/zsh/zshrc', 'zshrc')
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      JSON.stringify([{ source_path: 'zshrc', target_path: '~/.zshrc', global: true }]),
    )

    const result = await runCli(sandbox, ['modules', 'deploy', 'zsh'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('settings.json is a list (configfile 0.3 format)')
    expect(await readlink(path.join(sandbox.home, '.zshrc'))).toBe(
      path.join(sandbox.repo, 'files/zsh/zshrc'),
    )
  })

  it('never lets a source outside the module be deployed or undeployed', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/Documents/thesis.txt', 'years of work')
    await sandbox.write(
      'home/dotfiles/files/evil/settings.json',
      JSON.stringify({
        files: [{ source_path: '../../../Documents', target_path: '~/Documents', deploy: 'local' }],
      }),
    )

    const undeploy = await runCli(sandbox, ['modules', 'undeploy', '--local', 'evil'])

    expect(undeploy.code).toBe(1)
    expect(undeploy.stderr).toContain('must name a file or folder inside the module folder')
    expect(await readFile(path.join(sandbox.home, 'Documents/thesis.txt'), 'utf8')).toBe(
      'years of work',
    )
  })

  it('refuses a tampered state file before changing anything', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('home/.ssh/id_rsa', 'PRIVATE KEY')
    const zshrc = path.join(sandbox.home, '.zshrc')
    await sandbox.write(
      'home/.configfile/state.json',
      JSON.stringify({
        version: 2,
        targets: {
          [zshrc]: {
            target: zshrc,
            deployed: null,
            backups: [{ path: path.join(sandbox.home, '.ssh/id_rsa'), identity: null, kind: null }],
          },
        },
      }),
    )

    const result = await runCli(sandbox, ['modules', 'undeploy', 'zsh'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is not a valid configfile state file')
    expect(await readFile(path.join(sandbox.home, '.ssh/id_rsa'), 'utf8')).toBe('PRIVATE KEY')
  })

  it('refuses a state file whose deployed record is malformed', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    const zshrc = path.join(sandbox.home, '.zshrc')
    await sandbox.write(
      'home/.configfile/state.json',
      JSON.stringify({
        version: 2,
        targets: {
          [zshrc]: {
            target: zshrc,
            deployed: { strategy: 'global', source: 42, identity: { dev: 1, ino: 2 } },
            backups: [],
          },
        },
      }),
    )

    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is not a valid configfile state file')
  })

  it('shows control characters from settings.json as escapes', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write(
      'home/dotfiles/files/a/settings.json',
      JSON.stringify({
        files: [{ source_path: 'x\u001b]0;HIJACK\u0007\rfake', target_path: 't' }],
      }),
    )

    const result = await runCli(sandbox, ['modules', 'status', 'a'])

    const controls = [...result.stdout].filter(c => c !== '\n' && c.charCodeAt(0) < 0x20)
    expect(controls).toEqual([])
    expect(result.stdout).toContain('x\\x1b]0;HIJACK\\x07\\rfake (no deployment strategy)')
  })

  it('stacks two modules deployed to the same target, and unwinds them', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    for (const name of ['a', 'b']) {
      await sandbox.write(`home/dotfiles/files/${name}/x`, name)
      await sandbox.write(
        `home/dotfiles/files/${name}/settings.json`,
        JSON.stringify({ files: [{ source_path: 'x', target_path: '~/.x', deploy: 'global' }] }),
      )
    }
    await sandbox.write('home/.x', 'original')
    const target = path.join(sandbox.home, '.x')

    await runCli(sandbox, ['modules', 'deploy', 'a'])
    const deployB = await runCli(sandbox, ['modules', 'deploy', 'b'])
    expect(deployB.stdout).toContain(`(deployed, previous file moved to ${target}.old.1)`)
    expect((await runCli(sandbox, ['modules', 'status', 'a'])).stdout).toContain(
      '(not deployed: a link is in the way)',
    )

    await runCli(sandbox, ['modules', 'undeploy', 'b'])
    expect(await readlink(target)).toBe(path.join(sandbox.repo, 'files/a/x'))
    await runCli(sandbox, ['modules', 'undeploy', 'a'])
    expect(await readFile(target, 'utf8')).toBe('original')
  })

  it('refuses to copy a folder containing a link loop', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/l/d/file', 'x')
    await symlink('.', path.join(sandbox.repo, 'files/l/d/loop'))
    await sandbox.write(
      'home/dotfiles/files/l/settings.json',
      JSON.stringify({ files: [{ source_path: 'd', target_path: 'd', deploy: 'local' }] }),
    )

    const result = await runCli(sandbox, ['modules', 'deploy', '--local', 'l'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('makes a loop')
    expect(existsSync(path.join(sandbox.cwd, 'd'))).toBe(false)
  })

  it('keeps unknown keys of the state file', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write(
      'home/.configfile/state.json',
      JSON.stringify({ version: 2, targets: {}, custom: 1 }),
    )

    await runCli(sandbox, ['modules', 'deploy', 'zsh'])

    const state = JSON.parse(
      await readFile(path.join(sandbox.home, '.configfile/state.json'), 'utf8'),
    )
    expect(state.custom).toBe(1)
  })

  it('keeps a local copy an editor saved through a new file', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await runCli(sandbox, ['modules', 'deploy', '--local', 'zsh'])
    // Editors such as vim save by writing a new file and renaming it over the old one.
    await sandbox.write('cwd/a.tmp', 'edited')
    await rename(path.join(sandbox.cwd, 'a.tmp'), path.join(sandbox.cwd, 'a'))

    const result = await runCli(sandbox, ['modules', 'undeploy', '--local', 'zsh'])

    expect(result.code).toBe(0)
    expect(await readFile(path.join(sandbox.cwd, 'a'), 'utf8')).toBe('edited')
    expect(existsSync(path.join(sandbox.cwd, 'b'))).toBe(false)
  })

  it('warns about the deprecated "global" key', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      JSON.stringify({ files: [{ source_path: 'zshrc', target_path: '~/.zshrc', global: true }] }),
    )

    const result = await runCli(sandbox, ['modules', 'deploy', 'zsh'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('"global": true | false is deprecated')
    expect(existsSync(path.join(sandbox.home, '.zshrc'))).toBe(true)
  })
})

describe('files the repository no longer deploys', () => {
  /** A module with two global files, deployed over an existing ~/.aliases. */
  async function withDeployedModule(sandbox: Sandbox) {
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/zsh/zshrc', 'zshrc')
    await sandbox.write('home/dotfiles/files/zsh/aliases', 'aliases')
    await writeSettings(sandbox, 'zsh', [
      { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
      { source_path: 'aliases', target_path: '~/.aliases', deploy: 'global' },
    ])
    await sandbox.write('home/.aliases', 'mine')
    expect((await runCli(sandbox, ['modules', 'deploy', 'zsh'])).code).toBe(0)
    return {
      aliases: path.join(sandbox.home, '.aliases'),
      zshrc: path.join(sandbox.home, '.zshrc'),
    }
  }

  const writeSettings = (sandbox: Sandbox, module: string, files: unknown) =>
    sandbox.write(`home/dotfiles/files/${module}/settings.json`, JSON.stringify({ files }))

  it('lists, then undeploys a removed entry and restores what it replaced', async () => {
    const sandbox = await createSandbox()
    const { aliases, zshrc } = await withDeployedModule(sandbox)
    await writeSettings(sandbox, 'zsh', [
      { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
    ])
    await rm(path.join(sandbox.repo, 'files/zsh/aliases'))

    const status = await runCli(sandbox, ['modules', 'status'])
    const dryRun = await runCli(sandbox, ['modules', 'undeploy', '--removed', '--dry-run'])
    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed'])

    expect(status.stdout).toContain(
      `No longer deployed by the repository (run "configfile modules undeploy --removed"):\n` +
        `  ${aliases} (deployed, but its source is missing from the repository)\n`,
    )
    expect(dryRun.stdout).toContain(`- ${aliases} (would be removed, ${aliases}.old restored)\n`)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`- ${aliases} (removed, ${aliases}.old restored)\n`)
    expect(result.stdout).not.toContain(zshrc)
    expect(await readFile(aliases, 'utf8')).toBe('mine')
    expect(await readlink(zshrc)).toBe(path.join(sandbox.repo, 'files/zsh/zshrc'))
    expect((await runCli(sandbox, ['modules', 'status'])).stdout).not.toContain('No longer')

    const [, undeployed] = await readHistory(sandbox)
    expect(undeployed).toMatchObject({
      command: 'modules undeploy',
      options: { modules: [], removed: true },
      changes: [
        {
          kind: 'removed',
          target: aliases,
          backup: { path: `${aliases}.old`, status: 'restored' },
        },
      ],
    })
  })

  it('undeploys them with --all, also when their module was deleted', async () => {
    const sandbox = await createSandbox()
    const { aliases, zshrc } = await withDeployedModule(sandbox)
    await sandbox.write('home/dotfiles/files/git/gitconfig', 'git')
    await writeSettings(sandbox, 'git', [
      { source_path: 'gitconfig', target_path: '~/.gitconfig', deploy: 'global' },
    ])
    await rm(path.join(sandbox.repo, 'files/zsh'), { recursive: true })

    const result = await runCli(sandbox, ['modules', 'undeploy', '--all'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`- ${aliases} (removed, ${aliases}.old restored)`)
    expect(result.stdout).toContain(`- ${zshrc} (removed)`)
    expect(await readFile(aliases, 'utf8')).toBe('mine')
    expect(existsSync(zshrc)).toBe(false)
  })

  it('undeploys them when all modules are chosen at the question', async () => {
    const sandbox = await createSandbox()
    const { aliases } = await withDeployedModule(sandbox)
    await writeSettings(sandbox, 'zsh', [
      { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
    ])

    const result = await runCli(sandbox, ['modules', 'undeploy'], [true])

    expect(result.code).toBe(0)
    expect(await readFile(aliases, 'utf8')).toBe('mine')
  })

  it('counts an entry set to "deploy": "none" as no longer deployed', async () => {
    const sandbox = await createSandbox()
    const { aliases } = await withDeployedModule(sandbox)
    await writeSettings(sandbox, 'zsh', [
      { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
      { source_path: 'aliases', target_path: '~/.aliases', deploy: 'none' },
    ])

    const status = await runCli(sandbox, ['modules', 'status'])
    await runCli(sandbox, ['modules', 'undeploy', '--removed'])

    expect(status.stdout).toContain(`  ${aliases} (deployed)\n`)
    expect(await readFile(aliases, 'utf8')).toBe('mine')
  })

  it('counts a changed target as no longer deployed at the old one', async () => {
    const sandbox = await createSandbox()
    const { aliases } = await withDeployedModule(sandbox)
    await writeSettings(sandbox, 'zsh', [
      { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
      { source_path: 'aliases', target_path: '~/.zsh_aliases', deploy: 'global' },
    ])

    await runCli(sandbox, ['modules', 'undeploy', '--removed'])

    expect(await readFile(aliases, 'utf8')).toBe('mine')
  })

  it.each([
    ['whose settings.json is broken', '{'],
    [
      'with an invalid entry',
      JSON.stringify({
        files: [
          { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
          { source_path: 'aliases', deploy: 'global' },
        ],
      }),
    ],
    [
      'with an entry without strategy',
      JSON.stringify({
        files: [
          { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
          { source_path: 'aliases', target_path: '~/.aliases' },
        ],
      }),
    ],
  ])('never counts the files of a module %s as removed', async (_, settings) => {
    const sandbox = await createSandbox()
    const { aliases } = await withDeployedModule(sandbox)
    await sandbox.write('home/dotfiles/files/zsh/settings.json', settings)

    const status = await runCli(sandbox, ['modules', 'status'])
    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed'])
    const all = await runCli(sandbox, ['modules', 'undeploy', '--all'])

    expect(status.stdout).not.toContain('No longer deployed')
    expect(status.stdout).toContain(
      `configfile cannot tell whether the repository still deploys them:\n  ${aliases} (`,
    )
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`${aliases} was not checked: `)
    expect(result.stdout).not.toContain(`- ${aliases}`)
    expect(all.stdout).not.toContain(`- ${aliases}`)
    expect(await readlink(aliases)).toBe(path.join(sandbox.repo, 'files/zsh/aliases'))
  })

  it('never counts the files of a module that was not loaded as removed', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/zsh!/aliases', 'aliases')
    await writeSettings(sandbox, 'zsh!', [
      { source_path: 'aliases', target_path: '~/.aliases', deploy: 'global' },
    ])
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    // Same module name: "zsh!" is now ignored, with a warning.
    await sandbox.write('home/dotfiles/files/zsh/zshrc', 'zshrc')
    await writeSettings(sandbox, 'zsh', [
      { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
    ])

    const status = await runCli(sandbox, ['modules', 'status'])
    await runCli(sandbox, ['modules', 'undeploy', '--all'])

    expect(status.stderr).toContain('is ignored: another module is already named "zsh"')
    expect(status.stdout).not.toContain('No longer deployed')
    expect(await readlink(path.join(sandbox.home, '.aliases'))).toBe(
      path.join(sandbox.repo, 'files/zsh!/aliases'),
    )
  })

  it('keeps a removed local copy whose source is gone: it cannot be compared', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/web/editorconfig', 'root = true')
    await writeSettings(sandbox, 'web', [
      { source_path: 'editorconfig', target_path: '.editorconfig', deploy: 'local' },
    ])
    await runCli(sandbox, ['modules', 'deploy', '--local', 'web'])
    await writeSettings(sandbox, 'web', [])
    await rm(path.join(sandbox.repo, 'files/web/editorconfig'))

    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed', '--local'])

    expect(result.stdout).toContain(
      `- ${path.join(sandbox.cwd, '.editorconfig')} (kept: its source is missing from the repository, so it cannot be compared; configfile no longer tracks it)`,
    )
    expect(existsSync(path.join(sandbox.cwd, '.editorconfig'))).toBe(true)
    // It is the user's file now: no more warnings about it.
    const again = await runCli(sandbox, ['modules', 'undeploy', '--removed', '--local'])
    expect(again.stdout).toContain('Every deployed local file is still deployed by the repository.')
  })

  it('undeploys removed local copies of the current folder only, unless modified', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/web/editorconfig', 'root = true')
    await sandbox.write('home/dotfiles/files/web/prettierrc', '{}')
    await writeSettings(sandbox, 'web', [
      { source_path: 'editorconfig', target_path: '.editorconfig', deploy: 'local' },
      { source_path: 'prettierrc', target_path: '.prettierrc', deploy: 'local' },
    ])
    const other = path.join(sandbox.root, 'other')
    await mkdir(other)
    await runCli(sandbox, ['modules', 'deploy', '--local', 'web'])
    await runCli(sandbox, ['modules', 'deploy', '--local', 'web'], [], { cwd: other })
    await sandbox.write('cwd/.prettierrc', '{ "semi": false }')
    await writeSettings(sandbox, 'web', [])

    const status = await runCli(sandbox, ['modules', 'status', '--local'])
    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed', '--local'])

    expect(status.stdout).toContain(`  ${path.join(sandbox.cwd, '.editorconfig')} (deployed)`)
    expect(status.stdout).not.toContain(other)
    expect(result.stdout).toContain(`- ${path.join(sandbox.cwd, '.editorconfig')} (removed)`)
    expect(result.stdout).toContain(
      `- ${path.join(sandbox.cwd, '.prettierrc')} (kept: it was modified since it was copied; configfile no longer tracks it)`,
    )
    expect(existsSync(path.join(sandbox.cwd, '.editorconfig'))).toBe(false)
    expect(existsSync(path.join(other, '.editorconfig'))).toBe(true)
  })

  it('still matches local copies after the repository moved', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/web/editorconfig', 'root = true')
    await writeSettings(sandbox, 'web', [
      { source_path: 'editorconfig', target_path: '.editorconfig', deploy: 'local' },
    ])
    await runCli(sandbox, ['modules', 'deploy', '--local', 'web'])
    const moved = path.join(sandbox.root, 'moved')
    await rename(sandbox.repo, moved)
    await sandbox.configure({ folder_path: moved })

    const status = await runCli(sandbox, ['modules', 'status', '--local'])

    expect(status.code).toBe(0)
    expect(status.stdout).not.toContain('No longer deployed')
  })

  it('keeps a link whose parent folder, a symbolic link, now leads elsewhere', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/app/apprc', 'app')
    await writeSettings(sandbox, 'app', [
      { source_path: 'apprc', target_path: '~/.cfg/apprc', deploy: 'global' },
    ])
    await mkdir(path.join(sandbox.home, 'real-a'))
    await symlink(path.join(sandbox.home, 'real-a'), path.join(sandbox.home, '.cfg'))
    await runCli(sandbox, ['modules', 'deploy', 'app'])
    // ~/.cfg moved elsewhere (Dropbox, iCloud…), its link updated.
    await rename(path.join(sandbox.home, 'real-a'), path.join(sandbox.home, 'real-b'))
    await rm(path.join(sandbox.home, '.cfg'))
    await symlink(path.join(sandbox.home, 'real-b'), path.join(sandbox.home, '.cfg'))

    const status = await runCli(sandbox, ['modules', 'status'])
    await runCli(sandbox, ['modules', 'undeploy', '--removed'])

    expect(status.stdout).not.toContain('No longer deployed')
    expect(await readlink(path.join(sandbox.home, '.cfg/apprc'))).toBe(
      path.join(sandbox.repo, 'files/app/apprc'),
    )
  })

  it('keeps a link whose target is now written with other letter case', async ({ skip }) => {
    const sandbox = await createSandbox()
    await sandbox.write('home/case-check', '')
    // Only meaningful on a case-insensitive file system (macOS by default).
    if (!existsSync(path.join(sandbox.home, 'CASE-CHECK'))) skip()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/app/apprc', 'app')
    await writeSettings(sandbox, 'app', [
      { source_path: 'apprc', target_path: '~/.apprc', deploy: 'global' },
    ])
    await runCli(sandbox, ['modules', 'deploy', 'app'])
    await writeSettings(sandbox, 'app', [
      { source_path: 'apprc', target_path: '~/.AppRc', deploy: 'global' },
    ])

    const status = await runCli(sandbox, ['modules', 'status'])

    expect(status.stdout).not.toContain('No longer deployed')
  })

  it('holds back the files of a module folder that is a broken symbolic link', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    const external = path.join(sandbox.root, 'external-work')
    await sandbox.write('external-work/workrc', 'work')
    await sandbox.write(
      'external-work/settings.json',
      JSON.stringify({
        files: [{ source_path: 'workrc', target_path: '~/.workrc', deploy: 'global' }],
      }),
    )
    await mkdir(path.join(sandbox.repo, 'files'), { recursive: true })
    await symlink(external, path.join(sandbox.repo, 'files/work'))
    await runCli(sandbox, ['modules', 'deploy', 'work'])
    // The drive is not mounted.
    await rename(external, `${external}-unmounted`)

    const status = await runCli(sandbox, ['modules', 'status'])
    const all = await runCli(sandbox, ['modules', 'undeploy', '--all'])

    expect(status.stdout).toContain(
      `  ${path.join(sandbox.home, '.workrc')} (files/work is in the repository but is not a usable module)`,
    )
    expect(all.stdout).not.toContain('.workrc (removed')
    expect(existsSync(path.join(sandbox.home, '.workrc'))).toBe(false)
    expect((await lstat(path.join(sandbox.home, '.workrc'))).isSymbolicLink()).toBe(true)
  })

  it('holds back the files of a module that is not loaded after the repository moved', async () => {
    const sandbox = await createSandbox()
    const { aliases } = await withDeployedModule(sandbox)
    const moved = path.join(sandbox.root, 'moved')
    await rename(sandbox.repo, moved)
    await sandbox.configure({ folder_path: moved })
    // A folder listed first now gives the same module name: "zsh" is ignored.
    await sandbox.write('moved/files/!zsh/settings.json', JSON.stringify({ files: [] }))

    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed'])

    expect(result.stderr).toContain('"zsh" is ignored: another module is already named "zsh"')
    expect(result.stderr).toContain(
      `${aliases} was not checked: files/zsh is in the repository but is not a usable module.`,
    )
    expect(result.stdout).not.toContain(`- ${aliases}`)
    expect((await lstat(aliases)).isSymbolicLink()).toBe(true)
  })

  it('forgets a removed file replaced by the user, and stops warning about it', async () => {
    const sandbox = await createSandbox()
    const { aliases } = await withDeployedModule(sandbox)
    await writeSettings(sandbox, 'zsh', [
      { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
    ])
    await rm(aliases)
    await sandbox.write('home/.aliases', 'my own')

    const dryRun = await runCli(sandbox, ['modules', 'undeploy', '--removed', '--dry-run'])
    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed'])
    const again = await runCli(sandbox, ['modules', 'status'])

    expect(dryRun.stdout).toContain(
      `- ${aliases} (would be kept: the file there was not deployed by configfile; configfile would stop tracking it)`,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `- ${aliases} (kept: the file there was not deployed by configfile; configfile no longer tracks it)`,
    )
    expect(await readFile(aliases, 'utf8')).toBe('my own')
    expect(again.stdout).not.toContain('No longer deployed')
    // Its backup stays recorded, untouched.
    expect(await readFile(`${aliases}.old`, 'utf8')).toBe('mine')
    const [, undeployed] = await readHistory(sandbox)
    expect(undeployed?.changes).toEqual([
      { kind: 'kept', target: aliases, reason: 'foreign', forgotten: true },
    ])
    expect((await runCli(sandbox, ['history', '-n', '1'])).stdout).toContain(
      'kept      ~/.aliases  (not deployed by configfile; configfile no longer tracks it)',
    )
  })

  it('leaves out targets deleted by hand: there is nothing to undeploy', async () => {
    const sandbox = await createSandbox()
    const { aliases } = await withDeployedModule(sandbox)
    await writeSettings(sandbox, 'zsh', [
      { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
    ])
    await rm(aliases)

    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed'])

    expect(result.stdout).toContain(
      'Every deployed global file is still deployed by the repository.',
    )
  })

  it('undeploys them with --all when no module is left, and previews it', async () => {
    const sandbox = await createSandbox()
    const { aliases, zshrc } = await withDeployedModule(sandbox)
    await rm(path.join(sandbox.repo, 'files/zsh'), { recursive: true })

    const status = await runCli(sandbox, ['modules', 'status'])
    const dryRun = await runCli(sandbox, ['modules', 'undeploy', '--all', '--dry-run'])
    expect(await readlink(zshrc)).toBe(path.join(sandbox.repo, 'files/zsh/zshrc'))
    const result = await runCli(sandbox, ['modules', 'undeploy', '--all'])

    expect(status.stdout).toContain(`No longer deployed by the repository`)
    expect(status.stdout).toContain(`  ${zshrc} (`)
    expect(dryRun.stdout).toContain(`- ${aliases} (would be removed, ${aliases}.old restored)`)
    expect(result).toMatchObject({ code: 0 })
    expect(result.stdout).toContain('Undeployment finished.')
    expect(await readFile(aliases, 'utf8')).toBe('mine')
    expect(existsSync(zshrc)).toBe(false)
  })

  it('keeps a local copy whose entry changed source but not target', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/web/editorconfig', 'root = true')
    await sandbox.write('home/dotfiles/files/web/editorconfig.ini', 'root = true')
    await writeSettings(sandbox, 'web', [
      { source_path: 'editorconfig', target_path: '.editorconfig', deploy: 'local' },
    ])
    await runCli(sandbox, ['modules', 'deploy', '--local', 'web'])
    await writeSettings(sandbox, 'web', [
      { source_path: 'editorconfig.ini', target_path: '.editorconfig', deploy: 'local' },
    ])

    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed', '--local'])

    expect(result.stdout).toContain(
      'Every deployed local file is still deployed by the repository.',
    )
    expect(existsSync(path.join(sandbox.cwd, '.editorconfig'))).toBe(true)
  })

  it('undeploys the old copy of a local entry whose target changed', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/web/editorconfig', 'root = true')
    await writeSettings(sandbox, 'web', [
      { source_path: 'editorconfig', target_path: '.editorconfig', deploy: 'local' },
    ])
    await runCli(sandbox, ['modules', 'deploy', '--local', 'web'])
    await writeSettings(sandbox, 'web', [
      { source_path: 'editorconfig', target_path: 'config/.editorconfig', deploy: 'local' },
    ])

    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed', '--local'])

    expect(result.stdout).toContain(`- ${path.join(sandbox.cwd, '.editorconfig')} (removed)`)
  })

  it('only reaches the local copies made in the current folder, not in its subfolders', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/web/editorconfig', 'root = true')
    await writeSettings(sandbox, 'web', [
      { source_path: 'editorconfig', target_path: '.editorconfig', deploy: 'local' },
    ])
    const project = path.join(sandbox.cwd, 'project')
    await mkdir(project)
    await runCli(sandbox, ['modules', 'deploy', '--local', 'web'], [], { cwd: project })
    await writeSettings(sandbox, 'web', [])

    const fromParent = await runCli(sandbox, ['modules', 'status', '--local'])
    const fromProject = await runCli(sandbox, ['modules', 'status', '--local'], [], {
      cwd: project,
    })

    expect(fromParent.stdout).not.toContain('No longer deployed')
    expect(fromProject.stdout).toContain(
      'No longer deployed by the repository (run "configfile modules undeploy --removed --local"):',
    )
  })

  it('refuses --removed with --all', async () => {
    const sandbox = await createSandbox()
    await withDeployedModule(sandbox)

    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed', '--all'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Give --all or --removed, not both')
  })

  it('refuses module names with --removed', async () => {
    const sandbox = await createSandbox()
    await withDeployedModule(sandbox)

    const result = await runCli(sandbox, ['modules', 'undeploy', '--removed', 'zsh'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Give module names or --removed, not both.')
  })
})

describe('scripts', () => {
  async function withScripts(sandbox: Sandbox) {
    await sandbox.configure()
    await sandbox.write(
      'home/dotfiles/scripts/ok',
      `#!/bin/sh\necho "$@" > "${sandbox.root}/ran"\n`,
      0o755,
    )
    await sandbox.write('home/dotfiles/scripts/fail.sh', 'exit 3\n', 0o644)
    await sandbox.write(
      'home/dotfiles/scripts/where.js',
      `require('node:fs').writeFileSync(${JSON.stringify(`${sandbox.root}/cwd.txt`)}, process.cwd())\n`,
      0o644,
    )
    await sandbox.write('home/dotfiles/scripts/plain', 'echo hi\n', 0o644)
  }

  it('lists scripts, also as the default subcommand', async () => {
    const sandbox = await createSandbox()
    await withScripts(sandbox)

    for (const args of [['scripts', 'list'], ['scripts'], ['s', 'l']]) {
      const result = await runCli(sandbox, args)
      expect(result.stdout).toBe('4 scripts found.\n- fail\n- ok\n- plain\n- where\n')
    }
  })

  it('runs an executable script with arguments given after --', async () => {
    const sandbox = await createSandbox()
    await withScripts(sandbox)

    const result = await runCli(sandbox, ['scripts', 'run', 'ok', '--', '--flag', 'value'])

    expect(result.code).toBe(0)
    expect(await readFile(path.join(sandbox.root, 'ran'), 'utf8')).toBe('--flag value\n')
  })

  it('runs non-executable .js files with node, in the current folder', async () => {
    const sandbox = await createSandbox()
    await withScripts(sandbox)

    const result = await runCli(sandbox, ['s', 'r', 'where'])

    expect(result.code).toBe(0)
    expect(await readFile(path.join(sandbox.root, 'cwd.txt'), 'utf8')).toBe(sandbox.cwd)
  })

  it('exits with the exit code of a failing script', async () => {
    const sandbox = await createSandbox()
    await withScripts(sandbox)

    const result = await runCli(sandbox, ['scripts', 'run', 'fail'])

    expect(result.code).toBe(3)
    expect(result.stderr).toContain('Script "fail" exited with code 3.')
    expect(result.stdout).not.toContain('Done')
  })

  it('runs a non-executable script with its shebang interpreter, without changing its mode', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    const script = await sandbox.write(
      'home/dotfiles/scripts/tool',
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(`${sandbox.root}/args.json`)}, JSON.stringify(process.argv.slice(2)))\n`,
      0o644,
    )

    const result = await runCli(sandbox, ['scripts', 'run', 'tool', '--', 'a', 'b c'])

    expect(result.code).toBe(0)
    expect(JSON.parse(await readFile(path.join(sandbox.root, 'args.json'), 'utf8'))).toEqual([
      'a',
      'b c',
    ])
    expect((await stat(script)).mode & 0o777).toBe(0o644)
  })

  it('reports a shebang interpreter that does not exist', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/scripts/tool', '#!/no/such/interpreter\n', 0o644)

    const result = await runCli(sandbox, ['scripts', 'run', 'tool'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'Interpreter "/no/such/interpreter" of script "tool" not found.',
    )
  })

  it('keeps stdout for the script output', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/scripts/quiet.sh', 'true\n')

    const result = await runCli(sandbox, ['scripts', 'run', 'quiet'])

    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(result.stderr).toContain('Script "quiet" finished.')
  })

  it('runs an executable program without shebang directly', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    const program = path.join(sandbox.repo, 'scripts', 'program')
    await mkdir(path.dirname(program), { recursive: true })
    await copyFile('/usr/bin/true', program)
    await chmod(program, 0o755)

    await expect(runCli(sandbox, ['scripts', 'run', 'program'])).resolves.toMatchObject({ code: 0 })
  })

  it('runs an executable .sh script without shebang with sh', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write(
      'home/dotfiles/scripts/nosb.sh',
      `echo ok > "${sandbox.root}/nosb"\n`,
      0o755,
    )

    const result = await runCli(sandbox, ['scripts', 'run', 'nosb'])

    expect(result.code).toBe(0)
    expect(await readFile(path.join(sandbox.root, 'nosb'), 'utf8')).toBe('ok\n')
  })

  it('reports the missing interpreter of an executable script', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/scripts/tool', '#!/no/such/interpreter\n', 0o755)

    const result = await runCli(sandbox, ['scripts', 'run', 'tool'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'Interpreter "/no/such/interpreter" of script "tool" not found.',
    )
  })

  it('exits with 128 + signal when the script is killed', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/scripts/killed.sh', 'kill -TERM $$\n')

    const result = await runCli(sandbox, ['scripts', 'run', 'killed'])

    expect(result.code).toBe(143)
    expect(result.stderr).toContain('exited with code 143')
  })

  it('passes arguments to .js and .sh scripts run through their interpreter', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    const script = await sandbox.write(
      'home/dotfiles/scripts/args.sh',
      `echo "$@" > "${sandbox.root}/args"\n`,
      0o644,
    )

    await runCli(sandbox, ['scripts', 'run', 'args', '--', '-x', 'y'])

    expect(await readFile(path.join(sandbox.root, 'args'), 'utf8')).toBe('-x y\n')
    expect((await stat(script)).mode & 0o777).toBe(0o644)
  })

  it('runs any file of scripts/, named up to the first dot, as 0.3 did', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write(
      'home/dotfiles/scripts/setup.macos.py',
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(`${sandbox.root}/ran`)}, 'yes')\n`,
      0o644,
    )

    const list = await runCli(sandbox, ['scripts', 'list'])
    expect(list.stdout).toBe('1 script found.\n- setup\n')

    const result = await runCli(sandbox, ['scripts', 'run', 'setup'])
    expect(result.code).toBe(0)
    expect(await readFile(path.join(sandbox.root, 'ran'), 'utf8')).toBe('yes')
  })

  it('removes its signal handlers once the script is done', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/scripts/quick.sh', 'true\n')
    const counts = () =>
      ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'].map(s => process.listenerCount(s))
    const before = counts()

    await runCli(sandbox, ['scripts', 'run', 'quick'])

    expect(counts()).toEqual(before)
  })

  it('explains how to fix a non-executable script without extension', async () => {
    const sandbox = await createSandbox()
    await withScripts(sandbox)

    const result = await runCli(sandbox, ['scripts', 'run', 'plain'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('has no shebang line')
    expect(result.stderr).toContain('chmod +x')
  })

  it('reports an unknown script', async () => {
    const sandbox = await createSandbox()
    await withScripts(sandbox)

    const result = await runCli(sandbox, ['scripts', 'run', 'nope'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Script "nope" not found.')
  })
})

describe('init', () => {
  const withRemote = createRemote

  const readConfig = async (sandbox: Sandbox) =>
    JSON.parse(await readFile(path.join(sandbox.home, '.configfilerc'), 'utf8'))

  it('clones the repository and saves the configuration', async () => {
    const sandbox = await createSandbox()
    const remote = await withRemote(sandbox)

    const result = await runCli(sandbox, ['init'], [remote])

    // Only the URL is asked: the mirror lives in configfile's own folder.
    const mirror = path.join(sandbox.home, '.configfile/dotfiles')
    expect(result).toMatchObject({ code: 0, asked: ['Dotfiles repository URL:'] })
    expect(existsSync(path.join(mirror, 'files/.gitkeep'))).toBe(true)
    expect(await readConfig(sandbox)).toEqual({ repo_url: remote, folder_path: mirror })
    expect((await stat(path.join(sandbox.home, '.configfile'))).mode & 0o777).toBe(0o700)
  })

  it('checks git before asking for the repository URL', async () => {
    const sandbox = await createSandbox()
    vi.stubEnv('PATH', '/nonexistent')

    try {
      const result = await runCli(sandbox, ['init'], ['https://example.com/dotfiles.git'])

      expect(result).toMatchObject({ code: 1, asked: [] })
      expect(result.stderr).toContain('git is not installed.')
      expect(existsSync(path.join(sandbox.home, '.configfile/dotfiles'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('checks git before asking for the URL when the folder to clone into is empty', async () => {
    const sandbox = await createSandbox()
    const empty = path.join(sandbox.root, 'empty')
    await mkdir(empty)
    vi.stubEnv('PATH', '/nonexistent')

    try {
      const result = await runCli(
        sandbox,
        ['init', '--folder', empty],
        ['https://example.com/r.git'],
      )

      expect(result).toMatchObject({ code: 1, asked: [] })
      expect(result.stderr).toContain('git is not installed.')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('works with a home folder that does not exist yet', async () => {
    const sandbox = await createSandbox()
    const remote = await createRemote(sandbox)
    await rm(sandbox.home, { recursive: true })

    const result = await runCli(sandbox, ['init', '--repo', remote])

    expect(result.code).toBe(0)
    expect(existsSync(path.join(sandbox.home, '.configfile/dotfiles/files/.gitkeep'))).toBe(true)
  })

  it('reuses an existing repository without git', async () => {
    const sandbox = await createSandbox()
    await mkdir(path.join(sandbox.repo, '.git'), { recursive: true })
    vi.stubEnv('PATH', '/nonexistent')

    try {
      const result = await runCli(sandbox, [
        'init',
        '--repo',
        'https://example.com/dotfiles.git',
        '--folder',
        sandbox.repo,
      ])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('already contains a git repository')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('can run without prompts', async () => {
    const sandbox = await createSandbox()
    const remote = await withRemote(sandbox)

    const result = await runCli(sandbox, ['init', '--repo', remote, '--folder', sandbox.repo])

    expect(result).toMatchObject({ code: 0, asked: [] })
    expect(existsSync(path.join(sandbox.repo, '.git'))).toBe(true)
  })

  it('reuses an existing clone instead of failing', async () => {
    const sandbox = await createSandbox()
    const remote = await withRemote(sandbox)

    const result = await runCli(sandbox, ['init', '--repo', 'unused', '--folder', remote])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('already contains a git repository')
    expect((await readConfig(sandbox)).folder_path).toBe(remote)
  })

  it('does not save the configuration when the folder is not usable', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/dotfiles/something')

    const result = await runCli(sandbox, ['init', '--repo', 'x', '--folder', '~/dotfiles'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is not empty')
    expect(existsSync(path.join(sandbox.home, '.configfilerc'))).toBe(false)
  })

  it('does not save the configuration when the clone fails', async () => {
    const sandbox = await createSandbox()

    const result = await runCli(sandbox, [
      'init',
      '--repo',
      path.join(sandbox.root, 'no-such-repo'),
      '--folder',
      '~/dotfiles',
    ])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('git clone failed')
    expect(existsSync(path.join(sandbox.home, '.configfilerc'))).toBe(false)
  })

  it('overwrites an existing configuration with --force, without asking', async () => {
    const sandbox = await createSandbox()
    const remote = await withRemote(sandbox)
    await sandbox.configure({ repo_url: 'old' })

    const result = await runCli(
      sandbox,
      ['init', '-f', '--repo', remote, '--folder', '~/dotfiles'],
      [],
      { interactive: false },
    )

    expect(result).toMatchObject({ code: 0, asked: [] })
    expect((await readConfig(sandbox)).repo_url).toBe(remote)
  })

  it('offers the previous values when overwriting interactively', async () => {
    const sandbox = await createSandbox()
    const remote = await withRemote(sandbox)
    await sandbox.configure({ repo_url: 'old' })

    const result = await runCli(sandbox, ['init'], [true, remote])

    expect(result.code).toBe(0)
    expect(result.asked).toHaveLength(2)
    // The existing folder_path is kept.
    expect(await readConfig(sandbox)).toEqual({ repo_url: remote, folder_path: sandbox.repo })
  })

  it.each([
    [
      'a file',
      async (sandbox: Sandbox) => void (await sandbox.write('home/dotfiles', 'x')),
      'is not a folder',
    ],
    [
      'a broken symlink',
      async (sandbox: Sandbox) => symlink(path.join(sandbox.root, 'nowhere'), sandbox.repo),
      'is a broken symbolic link',
    ],
  ])('does not save the configuration when the folder is %s', async (_, prepare, message) => {
    const sandbox = await createSandbox()
    await prepare(sandbox)

    const result = await runCli(sandbox, ['init', '--repo', 'x', '--folder', '~/dotfiles'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(message)
    expect(existsSync(path.join(sandbox.home, '.configfilerc'))).toBe(false)
  })

  it('does not save the configuration when cancelled', async () => {
    const sandbox = await createSandbox()

    const result = await runCli(sandbox, ['init'], [exitPromptError()])

    expect(result.code).toBe(130)
    expect(existsSync(path.join(sandbox.home, '.configfilerc'))).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)(
    'explains how to recover when the configuration cannot be saved',
    async () => {
      const sandbox = await createSandbox()
      const remote = await withRemote(sandbox)
      const folder = path.join(sandbox.root, 'clone')
      await chmod(sandbox.home, 0o555)

      try {
        const result = await runCli(sandbox, ['init', '--repo', remote, '--folder', folder])

        expect(result.code).toBe(1)
        expect(result.stderr).toContain('Cannot save the configuration')
        expect(result.stderr).toContain(`The repository is in ${folder}`)
        expect(existsSync(path.join(folder, '.git'))).toBe(true)
      } finally {
        await chmod(sandbox.home, 0o755)
      }
    },
  )

  it('never lets a repository URL be read as a git option', async () => {
    const sandbox = await createSandbox()
    const pwned = path.join(sandbox.root, 'pwned')

    const result = await runCli(sandbox, [
      'init',
      '--repo',
      `--upload-pack=touch ${pwned}`,
      '--folder',
      '~/dotfiles',
    ])

    expect(result.code).not.toBe(0)
    expect(existsSync(pwned)).toBe(false)
  })

  it('hides credentials of the repository URL and keeps the configuration private', async () => {
    const sandbox = await createSandbox()
    await createRemote(sandbox)
    // An existing clone is reused, so no network access is needed.
    git(sandbox.root, 'clone', '--quiet', path.join(sandbox.root, 'remote'), sandbox.repo)
    const url = 'https://user:ghp_SECRET@github.com/acme/dotfiles.git'

    const result = await runCli(sandbox, ['init', '--repo', url, '--folder', '~/dotfiles'])

    expect(result.code).toBe(0)
    expect(result.stdout + result.stderr).not.toContain('ghp_SECRET')
    expect(result.stderr).toContain('The repository URL contains credentials')
    expect((await stat(path.join(sandbox.home, '.configfilerc'))).mode & 0o777).toBe(0o600)
  })

  it('asks before overwriting an existing configuration', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure({ repo_url: 'kept' })

    const result = await runCli(sandbox, ['init'], [false])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Nothing changed.')
    expect((await readConfig(sandbox)).repo_url).toBe('kept')
  })
})

describe('update', () => {
  /** A remote, configfile's mirror of it, and a function to commit in the remote. */
  async function withMirror(sandbox: Sandbox) {
    const remote = await createRemote(sandbox)
    git(sandbox.root, 'clone', '--quiet', remote, sandbox.repo)
    await sandbox.configure()
    const commitInRemote = async (file: string, content: string) => {
      await sandbox.write(`remote/${file}`, content)
      git(remote, 'add', '.')
      git(remote, 'commit', '--quiet', '-m', `change ${file}`)
    }
    return { remote, commitInRemote }
  }

  const savedPatches = async (sandbox: Sandbox) => {
    const folder = path.join(sandbox.home, '.configfile/saved')
    return existsSync(folder) ? (await readdir(folder)).map(name => path.join(folder, name)) : []
  }

  it('syncs the mirror with the remote', async () => {
    const sandbox = await createSandbox()
    const { commitInRemote } = await withMirror(sandbox)
    await commitInRemote('files/new-file', 'new')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Synced with origin/main')
    expect(await readFile(path.join(sandbox.repo, 'files/new-file'), 'utf8')).toBe('new')
    expect(await savedPatches(sandbox)).toEqual([])
  })

  it('says when the mirror is already up to date', async () => {
    const sandbox = await createSandbox()
    await withMirror(sandbox)

    const result = await runCli(sandbox, ['update'])

    expect(result).toMatchObject({ code: 0 })
    expect(result.stdout).toContain('Already up to date with origin/main.')
  })

  it('saves local commits, edits and new files as a patch, then syncs anyway', async () => {
    const sandbox = await createSandbox()
    const { remote, commitInRemote } = await withMirror(sandbox)
    await commitInRemote('files/remote-change', 'remote')
    await sandbox.write('home/dotfiles/files/committed', 'committed locally')
    git(sandbox.repo, 'add', '.')
    git(sandbox.repo, 'commit', '--quiet', '-m', 'local commit')
    await sandbox.write('home/dotfiles/files/.gitkeep', 'edited, not committed')
    await sandbox.write('home/dotfiles/files/untracked', 'new file')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    const [patch] = await savedPatches(sandbox)
    expect(result.stderr).toContain(`had local changes: they were saved to ${patch}`)
    expect(result.stderr).toContain(`git am ${patch}`)
    // The mirror is now exactly the remote.
    expect(await readFile(path.join(sandbox.repo, 'files/remote-change'), 'utf8')).toBe('remote')
    expect(existsSync(path.join(sandbox.repo, 'files/committed'))).toBe(false)
    expect(existsSync(path.join(sandbox.repo, 'files/untracked'))).toBe(false)
    expect(await readFile(path.join(sandbox.repo, 'files/.gitkeep'), 'utf8')).toBe('')

    // The saved patch brings everything back in a working copy.
    const workingCopy = path.join(sandbox.root, 'working-copy')
    git(sandbox.root, 'clone', '--quiet', remote, workingCopy)
    git(workingCopy, 'am', '--quiet', patch ?? '')
    expect(await readFile(path.join(workingCopy, 'files/committed'), 'utf8')).toBe(
      'committed locally',
    )
    expect(await readFile(path.join(workingCopy, 'files/untracked'), 'utf8')).toBe('new file')
    expect(await readFile(path.join(workingCopy, 'files/.gitkeep'), 'utf8')).toBe(
      'edited, not committed',
    )
  })

  it('saves an edit made through a deployed link before syncing', async () => {
    const sandbox = await createSandbox()
    const { commitInRemote } = await withMirror(sandbox)
    await commitInRemote('files/zsh/zshrc', 'from remote')
    await commitInRemote(
      'files/zsh/settings.json',
      JSON.stringify({
        files: [{ source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' }],
      }),
    )
    await runCli(sandbox, ['update'])
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    await writeFile(path.join(sandbox.home, '.zshrc'), 'edited through the link')
    await commitInRemote('files/zsh/zshrc', 'newer from remote')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(await readFile(path.join(sandbox.home, '.zshrc'), 'utf8')).toBe('newer from remote')
    const [patch] = await savedPatches(sandbox)
    expect(await readFile(patch ?? '', 'utf8')).toContain('+edited through the link')
  })

  it('follows the remote default branch when the mirror has no upstream', async () => {
    const sandbox = await createSandbox()
    const { commitInRemote } = await withMirror(sandbox)
    git(sandbox.repo, 'branch', '--unset-upstream')
    await commitInRemote('files/new-file', 'new')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(await readFile(path.join(sandbox.repo, 'files/new-file'), 'utf8')).toBe('new')
  })

  it('warns about deployed files the repository no longer deploys', async () => {
    const sandbox = await createSandbox()
    const { commitInRemote } = await withMirror(sandbox)
    await commitInRemote('files/zsh/zshrc', 'zshrc')
    await commitInRemote(
      'files/zsh/settings.json',
      JSON.stringify({
        files: [{ source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' }],
      }),
    )
    await runCli(sandbox, ['update'])
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    await commitInRemote('files/zsh/settings.json', JSON.stringify({ files: [] }))

    const result = await runCli(sandbox, ['update'])
    const again = await runCli(sandbox, ['update'])

    const zshrc = path.join(sandbox.home, '.zshrc')
    const warning =
      `1 deployed file is no longer deployed by the repository: ${zshrc}. To remove it and ` +
      'restore what it replaced, run "configfile modules undeploy --removed".'
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(warning)
    // Until the file is undeployed.
    expect(again.stderr).toContain(warning)
  })

  it('names the folders of removed local copies', async () => {
    const sandbox = await createSandbox()
    const { commitInRemote } = await withMirror(sandbox)
    await commitInRemote('files/zsh/zshrc', 'zshrc')
    await commitInRemote('files/zsh/editorconfig', 'root = true')
    await commitInRemote(
      'files/zsh/settings.json',
      JSON.stringify({
        files: [
          { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
          { source_path: 'editorconfig', target_path: '.editorconfig', deploy: 'local' },
        ],
      }),
    )
    await runCli(sandbox, ['update'])
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    await runCli(sandbox, ['modules', 'deploy', '--local', 'zsh'])
    await commitInRemote('files/zsh/settings.json', JSON.stringify({ files: [] }))

    const result = await runCli(sandbox, ['update'])

    expect(result.stderr).toContain(
      `2 deployed files are no longer deployed by the repository: ${path.join(sandbox.home, '.zshrc')}, ` +
        `${path.join(sandbox.cwd, '.editorconfig')}. To remove them and restore what they replaced, ` +
        `run "configfile modules undeploy --removed", and run "configfile modules undeploy --removed --local" in ${sandbox.cwd}.`,
    )
  })

  it('checks local copies against the folder they were copied into', async () => {
    const sandbox = await createSandbox()
    const { commitInRemote } = await withMirror(sandbox)
    await commitInRemote('files/web/editorconfig', 'root = true')
    await commitInRemote(
      'files/web/settings.json',
      JSON.stringify({
        files: [{ source_path: 'editorconfig', target_path: '.editorconfig', deploy: 'local' }],
      }),
    )
    await runCli(sandbox, ['update'])
    const project = path.join(sandbox.root, 'project')
    await mkdir(project)
    await runCli(sandbox, ['modules', 'deploy', '--local', 'web'], [], { cwd: project })

    // Run from another folder: the entry still deploys project/.editorconfig.
    const result = await runCli(sandbox, ['update'])

    expect(result.stderr).not.toContain('no longer deployed')
  })

  it('still succeeds when the synced repository cannot be read', async () => {
    const sandbox = await createSandbox()
    const { remote } = await withMirror(sandbox)
    await rm(path.join(remote, 'files'), { recursive: true })
    await sandbox.write('remote/files', 'a file, not a folder')
    git(remote, 'add', '-A')
    git(remote, 'commit', '--quiet', '-m', 'no files')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('Cannot check for files the repository no longer deploys')
  })

  it('fails when the dotfiles folder is not a git repository', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/.gitkeep')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is not a git repository')
  })
})

describe('history', () => {
  it('records each change of a deployment, and its failures', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('home/.zshrc', 'mine')
    await sandbox.write('cwd/a', 'mine')
    const zshrc = path.join(sandbox.home, '.zshrc')

    await runCli(sandbox, ['m', 'd', 'zsh'])
    await runCli(sandbox, ['modules', 'deploy', '--local', 'zsh'], [], { interactive: false })

    const [global, local] = await readHistory(sandbox)
    expect(global).toMatchObject({
      command: 'modules deploy',
      options: { modules: ['zsh'] },
      cwd: sandbox.cwd,
      exitCode: 0,
      changes: [
        {
          kind: 'deployed',
          how: 'link',
          source: path.join(sandbox.repo, 'files/zsh/zshrc'),
          target: zshrc,
          backup: `${zshrc}.old`,
        },
      ],
    })
    expect(global).not.toHaveProperty('error')
    expect(local).toMatchObject({
      options: { modules: ['zsh'], local: true },
      exitCode: 1,
      error: { expected: true },
      changes: [
        { kind: 'deployed', how: 'copy', target: path.join(sandbox.cwd, 'b') },
        { kind: 'skipped', target: path.join(sandbox.cwd, 'a'), reason: 'exists' },
      ],
    })
  })

  it('records nothing for read-only commands and dry runs', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    for (const args of [
      ['modules', 'list'],
      ['modules', 'status'],
      ['modules', 'deploy', '--dry-run', 'zsh'],
      ['modules', 'undeploy', '--dry-run', 'zsh'],
      ['scripts', 'list'],
      ['history'],
    ]) {
      await runCli(sandbox, args)
    }

    await expect(readHistory(sandbox)).resolves.toEqual([])
  })

  it('records what undeploy removed, restored and kept', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('home/.zshrc', 'mine')
    await sandbox.write('cwd/a', 'mine')
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    const zshrc = path.join(sandbox.home, '.zshrc')

    await runCli(sandbox, ['modules', 'undeploy', 'zsh'])
    await runCli(sandbox, ['modules', 'undeploy', '--local', 'zsh'])

    const [, undeployGlobal, undeployLocal] = await readHistory(sandbox)
    expect(undeployGlobal?.changes).toEqual([
      { kind: 'removed', target: zshrc, backup: { path: `${zshrc}.old`, status: 'restored' } },
    ])
    expect(undeployLocal).toMatchObject({
      changes: [{ kind: 'kept', target: path.join(sandbox.cwd, 'a'), reason: 'foreign' }],
      unchanged: 1,
    })
  })

  it('records scripts without their arguments', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/scripts/setup.sh', 'exit 4\n')

    await runCli(sandbox, ['scripts', 'run', 'setup', '--', 'token=s3cr3t'])

    const [line] = await readHistory(sandbox)
    expect(line).toMatchObject({
      command: 'scripts run',
      options: { script: 'setup', argCount: 1 },
      exitCode: 4,
      changes: [{ kind: 'script', name: 'setup', exitCode: 4 }],
    })
    const raw = await readFile(path.join(sandbox.home, '.configfile/history.jsonl'), 'utf8')
    expect(raw).not.toContain('s3cr3t')
  })

  it('records syncs and the patches they saved', async () => {
    const sandbox = await createSandbox()
    const remote = await createRemote(sandbox)
    git(sandbox.root, 'clone', '--quiet', remote, sandbox.repo)
    await sandbox.configure()
    await sandbox.write('home/dotfiles/files/local-edit', 'edit')
    await sandbox.write('remote/files/new', 'new')
    git(remote, 'add', '.')
    git(remote, 'commit', '--quiet', '-m', 'new')

    const head = (cwd: string) =>
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    const before = head(sandbox.repo)
    const after = head(remote)

    await runCli(sandbox, ['update'])
    await runCli(sandbox, ['update'])

    const [first, second] = await readHistory(sandbox)
    expect(before).not.toBe(after)
    expect(first?.changes).toEqual([
      { kind: 'saved-patch', file: expect.stringContaining('/.configfile/saved/') },
      { kind: 'synced', folder: sandbox.repo, upstream: 'origin/main', from: before, to: after },
    ])
    expect(second?.changes).toEqual([
      { kind: 'synced', folder: sandbox.repo, upstream: 'origin/main', from: after, to: after },
    ])
  })

  it('records the clone made by init', async () => {
    const sandbox = await createSandbox()
    const remote = await createRemote(sandbox)

    await runCli(sandbox, ['init', '--repo', remote])

    const [line] = await readHistory(sandbox)
    expect(line?.changes).toEqual([
      {
        kind: 'cloned',
        repository: remote,
        folder: path.join(sandbox.home, '.configfile/dotfiles'),
      },
      { kind: 'configured', file: path.join(sandbox.home, '.configfilerc') },
    ])
  })

  it('records init, with the repository URL redacted', async () => {
    const sandbox = await createSandbox()
    const remote = await createRemote(sandbox)
    git(sandbox.root, 'clone', '--quiet', remote, sandbox.repo)

    await runCli(sandbox, [
      'init',
      '--repo',
      'https://me:tok@example.com/r.git',
      '--folder',
      sandbox.repo,
    ])

    const [line] = await readHistory(sandbox)
    expect(line).toMatchObject({
      command: 'init',
      options: { repo: 'https://***:***@example.com/r.git', folder: sandbox.repo },
      changes: [
        { kind: 'reused', repository: 'https://***:***@example.com/r.git', folder: sandbox.repo },
        { kind: 'configured', file: path.join(sandbox.home, '.configfilerc') },
      ],
    })
  })

  it('records unexpected errors of any command', async () => {
    const sandbox = await createSandbox()

    await runCli(sandbox, ['init'], [new Error('boom')])

    const [line] = await readHistory(sandbox)
    expect(line).toMatchObject({
      command: 'init',
      exitCode: 1,
      error: { message: 'boom', expected: false },
    })
    expect(line?.error).not.toHaveProperty('stack')
  })

  it('records the changes made before Ctrl+C', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('cwd/a', 'mine')

    await runCli(sandbox, ['m', 'd', '-l', 'zsh'], [exitPromptError()])

    const [line] = await readHistory(sandbox)
    expect(line).toMatchObject({
      exitCode: 130,
      error: { expected: true },
      changes: [{ kind: 'deployed', target: path.join(sandbox.cwd, 'b') }],
    })
  })

  it('records the failures of a deployment', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write(
      'home/dotfiles/files/zsh/settings.json',
      JSON.stringify({
        files: [
          { source_path: 'zshrc', target_path: '~/.zshrc', deploy: 'global' },
          { source_path: 'missing', target_path: '~/x', deploy: 'global' },
          { source_path: 'a', deploy: 'global' },
        ],
      }),
    )
    await sandbox.write('home/dotfiles/files/broken/settings.json', '{')

    const deployed = await runCli(sandbox, ['modules', 'deploy', '--all'])
    await runCli(sandbox, ['modules', 'deploy', 'nope'])

    expect(deployed.code).toBe(1)
    const [all, unknown] = await readHistory(sandbox)
    expect(all).toMatchObject({ options: { all: true }, exitCode: 1, error: { expected: true } })
    expect(all?.changes).toEqual(
      expect.arrayContaining([
        { kind: 'failed', module: 'broken', reason: expect.stringContaining('not valid JSON') },
        {
          kind: 'failed',
          module: 'zsh',
          reason: expect.stringContaining('"target_path" is missing'),
        },
        {
          kind: 'failed',
          target: path.join(sandbox.home, 'x'),
          reason: expect.stringContaining('does not exist'),
        },
        expect.objectContaining({ kind: 'deployed', target: path.join(sandbox.home, '.zshrc') }),
      ]),
    )
    expect(unknown).toMatchObject({
      exitCode: 1,
      error: { message: expect.stringContaining('Unknown module: nope'), expected: true },
      changes: [],
    })
  })

  it('records modules chosen at a question as --all', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)

    await runCli(sandbox, ['modules', 'deploy'], [true])

    const [line] = await readHistory(sandbox)
    expect(line?.options).toEqual({ modules: [], all: true })
  })

  it('records backups that could not be restored', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    const zshrc = path.join(sandbox.home, '.zshrc')
    await sandbox.write('home/.zshrc', 'mine')
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    await sandbox.write('home/.zshrc.old', 'changed since')
    await runCli(sandbox, ['modules', 'undeploy', 'zsh'])
    await rm(`${zshrc}.old`)
    await sandbox.write('home/.zshrc', 'mine again')
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    await rm(`${zshrc}.old`)
    await runCli(sandbox, ['modules', 'undeploy', 'zsh'])

    const lines = await readHistory(sandbox)
    expect(lines[1]?.changes).toEqual([
      { kind: 'removed', target: zshrc, backup: { path: `${zshrc}.old`, status: 'changed' } },
    ])
    expect(lines[3]?.changes).toEqual([
      { kind: 'removed', target: zshrc, backup: { path: `${zshrc}.old`, status: 'missing' } },
    ])
  })

  it('never changes the exit code when the history cannot be written', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await mkdir(path.join(sandbox.home, '.configfile/history.jsonl'), { recursive: true })

    const result = await runCli(sandbox, ['modules', 'deploy', 'zsh'])

    expect(result.code).toBe(0)
    expect(
      result.stderr.match(/could not be recorded in the history: .*history\.jsonl/g),
    ).toHaveLength(1)

    await sandbox.write('home/dotfiles/scripts/fail.sh', 'exit 4\n')
    const failing = await runCli(sandbox, ['scripts', 'run', 'fail'])
    expect(failing.code).toBe(4)
    expect(failing.stderr.match(/could not be recorded/g)).toHaveLength(1)
  })

  it('warns about an invalid size, and records with the default one', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.configure({ history_max_size: 'big' })

    const result = await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    const history = await runCli(sandbox, ['history'])

    expect(result.code).toBe(0)
    expect(result.stderr.match(/"history_max_size" .* must be a size/g)).toHaveLength(1)
    expect(await readHistory(sandbox)).toHaveLength(1)
    expect(history.stderr).toContain('"history_max_size"')
  })

  it('records nothing when the configuration cannot be read, as it may turn the history off', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('home/.configfilerc', '{"history_max_size": 0,')

    const result = await runCli(sandbox, ['modules', 'deploy', 'zsh'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('This run is not recorded in the history.')
    expect(existsSync(path.join(sandbox.home, '.configfile/history.jsonl'))).toBe(false)
  })

  it('can be turned off', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.configure({ history_max_size: 0 })

    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    const history = await runCli(sandbox, ['history'])

    expect(existsSync(path.join(sandbox.home, '.configfile/history.jsonl'))).toBe(false)
    expect(history.stdout).toContain('The history is turned off')
  })

  it('shows the history, readable or as JSON Lines', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await sandbox.write('home/.zshrc', 'mine')

    expect((await runCli(sandbox, ['history'])).stdout).toContain('No history yet.')

    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    const readable = await runCli(sandbox, ['history'])
    const last = await runCli(sandbox, ['history', '-n', '1'])
    const json = await runCli(sandbox, ['history', '--json'])

    expect(readable.code).toBe(0)
    expect(readable.stdout).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d {2}modules deploy zsh {2}ok\n {2}linked {4}~\/\.zshrc {2}\(previous file moved to ~\/\.zshrc\.old\)\n/,
    )
    expect(last.stdout).toMatch(/^\S+ \S+ {2}modules deploy zsh {2}ok\n {2}1 unchanged\n$/)
    const lines = json.stdout
      .trim()
      .split('\n')
      .map(text => JSON.parse(text))
    expect(lines.map(line => line.command)).toEqual(['modules deploy', 'modules deploy'])
    for (const limit of ['x', '0', '-1', '1.5', '0x1', '1e1']) {
      const result = await runCli(sandbox, ['history', '-n', limit])
      expect(result.code, limit).toBe(1)
    }
  })

  it('shows every kind of change, and why runs failed', async () => {
    const sandbox = await createSandbox()
    const home = (file: string) => path.join(sandbox.home, file)
    const line = (fields: Record<string, unknown>) =>
      JSON.stringify({
        v: 1,
        time: '2026-10-01T09:00:00.000Z',
        durationMs: 1,
        pid: 1,
        version: '1.0.0',
        command: 'modules deploy',
        options: {},
        cwd: sandbox.cwd,
        exitCode: 0,
        changes: [],
        unchanged: 0,
        ...fields,
      })
    await sandbox.write(
      'home/.configfile/history.jsonl',
      `${[
        line({
          options: { modules: ['zsh', 'git'], local: true, force: true },
          exitCode: 1,
          error: { message: '1 file, module or settings entry failed.', expected: true },
          changes: [
            {
              kind: 'deployed',
              how: 'link',
              source: '/s',
              target: home('.a'),
              backup: home('.a.old'),
            },
            { kind: 'deployed', how: 'copy', source: '/s', target: '/work/b' },
            { kind: 'skipped', target: '/work/c', reason: 'exists' },
            { kind: 'failed', target: home('x'), reason: 'EACCES' },
            { kind: 'failed', module: 'git', reason: 'settings.json has no "files" list' },
          ],
          unchanged: 2,
        }),
        line({
          command: 'modules undeploy',
          options: { modules: [], all: true, removed: true },
          changes: [
            {
              kind: 'removed',
              target: home('.a'),
              backup: { path: home('.a.old'), status: 'restored' },
            },
            {
              kind: 'removed',
              target: home('.b'),
              backup: { path: home('.b.old'), status: 'missing' },
            },
            {
              kind: 'removed',
              target: home('.c'),
              backup: { path: home('.c.old'), status: 'changed' },
            },
            { kind: 'removed', target: home('.d'), leftover: home('.d.tmp') },
            { kind: 'kept', target: home('.e'), reason: 'foreign' },
            { kind: 'kept', target: home('.f'), reason: 'modified' },
            { kind: 'kept', target: home('.g'), reason: 'identical' },
            { kind: 'kept', target: home('.h'), reason: 'source-missing' },
            { kind: 'future-kind' },
          ],
          truncated: 3,
        }),
        line({
          command: 'update',
          changes: [
            { kind: 'saved-patch', file: home('.configfile/saved/p.patch') },
            {
              kind: 'synced',
              folder: home('.configfile/dotfiles'),
              upstream: 'origin/main',
              from: '7d0289a1f',
              to: '1217e91aa',
            },
          ],
        }),
        line({
          command: 'update',
          changes: [
            {
              kind: 'synced',
              folder: home('.configfile/dotfiles'),
              upstream: 'origin/main',
              from: 'abc',
              to: 'abc',
            },
          ],
        }),
        line({
          command: 'scripts run',
          options: { script: 'setup', argCount: 2 },
          exitCode: 3,
          error: { message: 'Script "setup" exited with code 3.', expected: true },
          changes: [{ kind: 'script', name: 'setup', file: '/s/setup.sh', exitCode: 3 }],
        }),
        line({
          command: 'init',
          options: { repo: 'https://***@host/r.git' },
          changes: [
            {
              kind: 'cloned',
              repository: 'https://***@host/r.git',
              folder: home('.configfile/dotfiles'),
            },
            { kind: 'configured', file: home('.configfilerc') },
          ],
        }),
        line({
          command: 'init',
          options: { folder: '/dotfiles' },
          changes: [{ kind: 'reused', repository: 'git@host:r.git', folder: '/dotfiles' }],
        }),
        line({ command: null, exitCode: 1, error: { message: 'boom', expected: false } }),
      ].join('\n')}\n`,
    )

    const result = await runCli(sandbox, ['history'])

    expect(result.code).toBe(0)
    expect(result.stdout.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d/gm, 'TIME')).toBe(
      [
        'TIME  modules deploy zsh git --local --force  exit 1',
        '  linked    ~/.a  (previous file moved to ~/.a.old)',
        '  copied    /work/b',
        '  skipped   /work/c  (it already existed)',
        '  failed    ~/x  EACCES',
        '  failed    module git  settings.json has no "files" list',
        '  2 unchanged',
        '  error     1 file, module or settings entry failed.',
        '',
        'TIME  modules undeploy --all --removed  ok',
        '  removed   ~/.a  (~/.a.old restored)',
        '  removed   ~/.b  (its backup ~/.b.old no longer existed)',
        '  removed   ~/.c  (its backup ~/.c.old had changed, not restored)',
        '  removed   ~/.d  (left at ~/.d.tmp)',
        '  kept      ~/.e  (not deployed by configfile)',
        '  kept      ~/.f  (modified since it was copied)',
        '  kept      ~/.g  (not copied by configfile)',
        '  kept      ~/.h  (its source was missing)',
        '  …and 1 change this configfile cannot show',
        '  …and 3 more changes',
        '',
        'TIME  update  ok',
        '  saved     local changes to ~/.configfile/saved/p.patch',
        '  synced    ~/.configfile/dotfiles  with origin/main (7d0289a → 1217e91)',
        '',
        'TIME  update  ok',
        '  synced    ~/.configfile/dotfiles  (already up to date with origin/main)',
        '',
        'TIME  scripts run setup (2 arguments)  exit 3',
        '  script    setup  exit 3',
        '  error     Script "setup" exited with code 3.',
        '',
        'TIME  init --repo https://***@host/r.git  ok',
        '  cloned    https://***@host/r.git into ~/.configfile/dotfiles',
        '  saved     configuration ~/.configfilerc',
        '',
        'TIME  init --folder /dotfiles  ok',
        '  reused    /dotfiles for git@host:r.git',
        '',
        'TIME  (unknown command)  exit 1',
        '  crashed   boom',
        '',
      ].join('\n'),
    )
  })

  it('skips damaged lines and lines of a newer format instead of failing', async () => {
    const sandbox = await createSandbox()
    await withModule(sandbox)
    await runCli(sandbox, ['modules', 'deploy', 'zsh'])
    const file = path.join(sandbox.home, '.configfile/history.jsonl')
    const newer = JSON.stringify({ v: 2, time: 'later' })
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}not json\n{"v":1,"time":"2026-01-01T00:00:00.000Z","changes":[]}\n${newer}\n`,
    )

    const readable = await runCli(sandbox, ['history'])
    const json = await runCli(sandbox, ['history', '--json'])

    expect(readable.code).toBe(0)
    expect(readable.stdout).toContain('modules deploy zsh  ok')
    expect(readable.stderr).toContain('2 damaged lines of the history skipped.')
    expect(readable.stderr).toContain('1 line written by a newer configfile skipped.')
    expect(json.code).toBe(0)
    expect(json.stdout.trim().split('\n').at(-1)).toBe(newer)
    // Reading the history never records anything.
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(4)
  })

  it('classifies every command, and only them, as recorded or read-only', async () => {
    const sandbox = await createSandbox()
    const leaves: string[] = []
    const walk = (command: ReturnType<typeof buildProgram>, prefix: string[]) => {
      for (const child of command.commands) {
        const path = [...prefix, child.name()]
        if (child.commands.length === 0) leaves.push(path.join(' '))
        else walk(child, path)
      }
    }
    walk(buildProgram(createContext(sandbox)), [])

    expect(leaves.sort()).toEqual(Object.keys(COMMANDS).sort())
  })
})

describe('program', () => {
  it('prints the version', async () => {
    const sandbox = await createSandbox()
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

    const result = await runCli(sandbox, ['--version'])

    expect(result).toMatchObject({ code: 0, stdout: `${pkg.version}\n` })
  })

  it('reports unexpected errors without a stack trace', async () => {
    const sandbox = await createSandbox()

    const result = await runCli(sandbox, ['init'], [new Error('boom')])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unexpected error: boom')
    expect(result.stderr).toContain('DEBUG=1')
    expect(result.stderr).not.toContain('    at ')
  })

  it('exits with 1 on an unknown command', async () => {
    const sandbox = await createSandbox()

    const result = await runCli(sandbox, ['nope'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("unknown command 'nope'")
  })
})
