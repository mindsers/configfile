import { existsSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readlink, stat, symlink } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createRemote, createSandbox, git, runCli, type Sandbox } from './helpers.js'

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
          },
          backups: [
            {
              path: `${zshrc}.old`,
              identity: { dev: expect.any(Number), ino: expect.any(Number) },
              kind: 'file',
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

    const result = await runCli(sandbox, ['init'], [remote, '~/dotfiles'])

    expect(result.code).toBe(0)
    expect(existsSync(path.join(sandbox.repo, 'files/.gitkeep'))).toBe(true)
    expect(await readConfig(sandbox)).toEqual({ repo_url: remote, folder_path: sandbox.repo })
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

    const result = await runCli(sandbox, ['init'], [true, remote, '~/dotfiles'])

    expect(result.code).toBe(0)
    expect(result.asked).toHaveLength(3)
    expect((await readConfig(sandbox)).repo_url).toBe(remote)
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

    const result = await runCli(sandbox, ['init'], ['url', exitPromptError()])

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
  it('pulls the dotfiles repository', async () => {
    const sandbox = await createSandbox()
    const remote = await createRemote(sandbox)
    git(sandbox.root, 'clone', '--quiet', remote, sandbox.repo)
    await sandbox.configure()

    await sandbox.write('remote/files/new-file', 'new')
    git(remote, 'add', '.')
    git(remote, 'commit', '--quiet', '-m', 'second')

    const result = await runCli(sandbox, ['update'])

    expect(result.code).toBe(0)
    expect(await readFile(path.join(sandbox.repo, 'files/new-file'), 'utf8')).toBe('new')
  })

  it('refuses to merge when the histories diverged (fast-forward only)', async () => {
    const sandbox = await createSandbox()
    const remote = await createRemote(sandbox)
    git(sandbox.root, 'clone', '--quiet', remote, sandbox.repo)
    await sandbox.configure()
    await sandbox.write('remote/files/remote-change', 'remote')
    git(remote, 'add', '.')
    git(remote, 'commit', '--quiet', '-m', 'remote')
    await sandbox.write('home/dotfiles/files/local-change', 'local')
    git(sandbox.repo, 'add', '.')
    git(sandbox.repo, 'commit', '--quiet', '-m', 'local')

    // Without --ff-only, this configuration would let git pull create a merge commit.
    const gitConfig = {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'pull.rebase',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'user.name',
      GIT_CONFIG_VALUE_1: 'test',
      GIT_CONFIG_KEY_2: 'user.email',
      GIT_CONFIG_VALUE_2: 'test@example.com',
    }
    Object.assign(process.env, gitConfig)
    try {
      const result = await runCli(sandbox, ['update'])

      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('git pull failed')
      expect(existsSync(path.join(sandbox.repo, 'files/remote-change'))).toBe(false)
    } finally {
      for (const key of Object.keys(gitConfig)) delete process.env[key]
    }
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
