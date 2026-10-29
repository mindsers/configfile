import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createSandbox, type Sandbox } from './helpers.ts'

// Built by tests/global-setup.ts before the test run.
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

/**
 * The command that runs configfile as users do: the built package, or the
 * standalone binary named by CONFIGFILE_BINARY (tools/build-binary.ts).
 */
function command(args: string[]): [string, string[]] {
  const binary = process.env.CONFIGFILE_BINARY
  return binary ? [binary, args] : [process.execPath, [cli, ...args]]
}

async function exec(args: string[]) {
  const sandbox = await createSandbox()
  await sandbox.configure()
  await sandbox.write('home/dotfiles/files/zsh/configfile.module.json', '{"files": []}')
  await sandbox.write('home/dotfiles/scripts/fail.sh', 'exit 4\n')
  await sandbox.write('home/dotfiles/scripts/hello.js', 'console.log("hello from Node.js")\n')

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox.home, NO_COLOR: '1' }
  // FORCE_COLOR (set by many CI and shells) would override NO_COLOR.
  delete env.FORCE_COLOR

  const result = spawnSync(...command([...args]), {
    cwd: sandbox.cwd,
    env,
    encoding: 'utf8',
  })

  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('built CLI', () => {
  it('says its version', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

    await expect(exec(['--version'])).resolves.toMatchObject({
      code: 0,
      stdout: `${pkg.version}\n`,
    })
  })

  it('runs a JavaScript script without shebang line, with Node.js', async () => {
    // In a standalone binary, with the node found in PATH.
    await expect(exec(['scripts', 'run', 'hello'])).resolves.toMatchObject({
      code: 0,
      stdout: 'hello from Node.js\n',
    })
  })

  it('runs a command', async () => {
    await expect(exec(['modules', 'list'])).resolves.toMatchObject({
      code: 0,
      stdout: '1 module found.\n- zsh\n',
    })
  })

  it('forwards the exit code and writes errors to stderr without colors', async () => {
    const result = await exec(['scripts', 'run', 'fail'])

    expect(result.code).toBe(4)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      ' Info  Running "fail"…\n Error  Script "fail" exited with code 4.\n',
    )
  })

  it('fails clearly instead of prompting when stdin is not a terminal', async () => {
    const deployAll = await exec(['modules', 'deploy'])
    expect(deployAll.code).toBe(1)
    expect(deployAll.stderr).toContain('Pass module names, or --all')

    const init = await exec(['init'])
    expect(init.code).toBe(1)
    expect(init.stderr).toContain(
      'Also pass: --force (configfile is already set up, and --force sets it up again), --repo <url>',
    )
  })

  describe('signals during scripts run', () => {
    // Each test runs in its own process group, killed afterwards: if signal
    // forwarding ever regresses, no script is left running on the machine.
    const groups: number[] = []
    afterEach(() => {
      for (const pid of groups.splice(0)) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    })

    /** Starts a long-running script, sends `signal` to configfile only once it runs. */
    async function interrupt(
      sandbox: Sandbox,
      script: string,
      signal: NodeJS.Signals,
      args = ['scripts', 'run', 'long'],
    ) {
      await sandbox.configure()
      await sandbox.write('home/dotfiles/scripts/long.sh', script)

      const child = spawn(...command([...args]), {
        cwd: sandbox.cwd,
        env: { ...process.env, HOME: sandbox.home, NO_COLOR: '1' },
        detached: true,
      })
      if (child.pid != null) groups.push(child.pid)

      let stdout = ''
      let stderr = ''
      child.stderr.on('data', chunk => {
        stderr += chunk
      })
      let sent = false
      child.stdout.on('data', chunk => {
        stdout += chunk
        // Once: a deployment goes on writing to stdout.
        if (stdout.includes('ready') && !sent) sent = child.kill(signal)
      })

      return new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
        stderr: string
      }>(resolve => {
        child.on('close', (code, closeSignal) => resolve({ code, signal: closeSignal, stderr }))
      })
    }

    it('lets the script handle Ctrl+C and reports its exit code', async () => {
      const sandbox = await createSandbox()

      // Only configfile receives SIGINT here; in a terminal the script gets it too.
      const result = await interrupt(sandbox, 'echo ready\nsleep 1\nexit 5\n', 'SIGINT')

      expect(result).toMatchObject({ code: 5, signal: null })
    })

    it('stops a deployment interrupted during a post_deploy script, even with --keep-going', async () => {
      const sandbox = await createSandbox()
      for (const name of ['a', 'b']) {
        await sandbox.write(`home/dotfiles/files/${name}/rc`)
        await sandbox.write(
          `home/dotfiles/files/${name}/configfile.module.json`,
          JSON.stringify({
            files: [{ source_path: 'rc', target_path: `~/.${name}rc`, deploy: 'global' }],
            post_deploy: 'long',
          }),
        )
      }

      // The script ends by itself with success: configfile was still asked to stop.
      const result = await interrupt(sandbox, "trap '' INT\necho ready\nsleep 1\n", 'SIGINT', [
        'modules',
        'deploy',
        '--all',
        '--keep-going',
      ])

      expect(result).toMatchObject({ code: 130, signal: null })
      expect(existsSync(path.join(sandbox.home, '.arc'))).toBe(true)
      expect(existsSync(path.join(sandbox.home, '.brc'))).toBe(false)
    })

    /** Modules `a` and `b`, one global file each, with `settings` in both. */
    async function withModules(sandbox: Sandbox, settings: Record<string, string>) {
      for (const name of ['a', 'b']) {
        await sandbox.write(`home/dotfiles/files/${name}/rc`)
        await sandbox.write(
          `home/dotfiles/files/${name}/configfile.module.json`,
          JSON.stringify({
            files: [{ source_path: 'rc', target_path: `~/.${name}rc`, deploy: 'global' }],
            ...settings,
          }),
        )
      }
    }

    it('deploys nothing more when interrupted during a pre_deploy script', async () => {
      const sandbox = await createSandbox()
      await withModules(sandbox, { pre_deploy: 'long' })

      const result = await interrupt(sandbox, "trap '' INT\necho ready\nsleep 1\n", 'SIGINT', [
        'modules',
        'deploy',
        '--all',
        '--keep-going',
      ])

      expect(result).toMatchObject({ code: 130, signal: null })
      expect(result.stderr).toContain('Interrupted. 2 modules were not deployed: a, b.')
      expect(existsSync(path.join(sandbox.home, '.arc'))).toBe(false)
      expect(existsSync(path.join(sandbox.home, '.brc'))).toBe(false)
    })

    it('stops an undeployment interrupted during a script, with the exit code of the signal', async () => {
      const sandbox = await createSandbox()
      await withModules(sandbox, { pre_undeploy: 'long' })
      await sandbox.configure()
      spawnSync(...command(['modules', 'deploy', '--all']), {
        cwd: sandbox.cwd,
        env: { ...process.env, HOME: sandbox.home },
      })
      expect(existsSync(path.join(sandbox.home, '.arc'))).toBe(true)

      const result = await interrupt(
        sandbox,
        "trap 'exit 0' TERM\necho ready\nwhile true; do sleep 0.05; done\n",
        'SIGTERM',
        ['modules', 'undeploy', '--all'],
      )

      expect(result).toMatchObject({ code: 143, signal: null })
      expect(result.stderr).toContain('Interrupted. 2 modules were not undeployed: a, b.')
      expect(result.stderr).toContain(
        'The files the repository no longer deploys were not checked.',
      )
      expect(existsSync(path.join(sandbox.home, '.arc'))).toBe(true)
    })

    it('forwards SIGTERM to the script', async () => {
      const sandbox = await createSandbox()

      const result = await interrupt(
        sandbox,
        "trap 'exit 7' TERM\necho ready\nwhile true; do sleep 0.05; done\n",
        'SIGTERM',
      )

      expect(result).toMatchObject({ code: 7, signal: null })
    })
  })

  it('says how to install git when it is missing, before changing anything', async () => {
    const sandbox = await createSandbox()

    const result = spawnSync(...command(['init', '--repo', 'https://example.com/dotfiles.git']), {
      cwd: sandbox.cwd,
      env: { ...process.env, HOME: sandbox.home, NO_COLOR: '1', PATH: '/nonexistent' },
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/git is not installed\. Install it with/)
    expect(result.stdout).not.toContain('Cloning')
    expect(existsSync(path.join(sandbox.home, '.configfile/dotfiles'))).toBe(false)
  })

  it('checks git before syncing', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await mkdir(path.join(sandbox.repo, '.git'), { recursive: true })

    const result = spawnSync(...command(['update']), {
      cwd: sandbox.cwd,
      env: { ...process.env, HOME: sandbox.home, NO_COLOR: '1', PATH: '/nonexistent' },
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/git is not installed\. Install it with/)
    expect(result.stdout).not.toContain('Syncing')
  })

  it('stops a hung git check on Ctrl+C, leaving nothing running', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await mkdir(path.join(sandbox.repo, '.git'), { recursive: true })
    const pidFile = path.join(sandbox.root, 'git.pid')
    await sandbox.write('bin/git', `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`, 0o755)

    const child = spawn(...command(['update']), {
      cwd: sandbox.cwd,
      env: {
        ...process.env,
        HOME: sandbox.home,
        NO_COLOR: '1',
        PATH: `${path.join(sandbox.root, 'bin')}:/usr/bin:/bin`,
      },
      stdio: 'ignore',
    })
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      child.on('close', (code, signal) => resolve({ code, signal })),
    )
    let gitPid = 0
    while (gitPid === 0) {
      await new Promise(resolve => setTimeout(resolve, 50))
      gitPid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
    }

    // Only configfile gets the signal: the hung git is in its own process group.
    child.kill('SIGINT')
    const result = await ended

    expect(result).toEqual({ code: null, signal: 'SIGINT' })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(() => process.kill(gitPid, 0)).toThrow()
  })

  // Eight processes: allow for slow, busy CI machines.
  it('never loses a file when several configfile processes deploy at once', {
    timeout: 30_000,
  }, async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    const modules = ['a', 'b', 'c', 'd']
    for (const name of modules) {
      await sandbox.write(`home/dotfiles/files/${name}/x`, name)
      await sandbox.write(
        `home/dotfiles/files/${name}/configfile.module.json`,
        JSON.stringify({
          files: [{ source_path: 'x', target_path: '~/.shared', deploy: 'global' }],
        }),
      )
    }
    await sandbox.write('home/.shared', 'PRECIOUS')

    const runs = modules.map(
      name =>
        new Promise<number | null>(resolve => {
          const child = spawn(...command(['modules', 'deploy', name]), {
            cwd: sandbox.cwd,
            env: { ...process.env, HOME: sandbox.home, NO_COLOR: '1' },
            stdio: 'ignore',
          })
          child.on('close', resolve)
        }),
    )
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0])

    const copies = (await readdir(sandbox.home)).filter(name => name.startsWith('.shared'))
    const contents = await Promise.all(
      copies.map(name => readFile(path.join(sandbox.home, name), 'utf8').catch(() => '')),
    )
    expect(contents.filter(content => content === 'PRECIOUS')).toHaveLength(1)

    // Undeploying every module unwinds the backups down to the original file.
    for (const _ of modules) {
      spawnSync(...command(['modules', 'undeploy', '--all']), {
        cwd: sandbox.cwd,
        env: { ...process.env, HOME: sandbox.home, NO_COLOR: '1' },
      })
    }
    expect(await readFile(path.join(sandbox.home, '.shared'), 'utf8')).toBe('PRECIOUS')
  })

  it('keeps one whole history line per run when many runs write at once', {
    timeout: 30_000,
  }, async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/scripts/ok.sh', 'exit 0\n')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox.home, NO_COLOR: '1' }

    const runs = Array.from(
      { length: 16 },
      () =>
        new Promise<number | null>(resolve => {
          const child = spawn(...command(['scripts', 'run', 'ok']), {
            cwd: sandbox.cwd,
            env,
            stdio: 'ignore',
          })
          child.on('close', resolve)
        }),
    )
    expect(new Set(await Promise.all(runs))).toEqual(new Set([0]))

    const lines = (await readFile(path.join(sandbox.home, '.configfile/history.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(text => JSON.parse(text))
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(lines).toHaveLength(16)
    expect(new Set(lines.map(line => line.pid)).size).toBe(16)
    expect(
      lines.every(line => line.version === pkg.version && line.command === 'scripts run'),
    ).toBe(true)
  })

  it('loses no line when many runs rotate the history at once', { timeout: 30_000 }, async () => {
    const sandbox = await createSandbox()
    await sandbox.configure({ history_max_size: '8KB' })
    await sandbox.write('home/dotfiles/scripts/ok.sh', 'exit 0\n')
    const old = JSON.stringify({
      v: 1,
      time: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      pid: 1,
      version: '0.0.0',
      command: 'update',
      options: {},
      cwd: '/',
      exitCode: 0,
      changes: [],
      unchanged: 0,
    })
    const count = Math.ceil(8192 / old.length) + 1
    await sandbox.write('home/.configfile/history.jsonl', `${old}\n`.repeat(count))
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox.home, NO_COLOR: '1' }

    // One rotation is due; the 16 new lines then fit under the limit.
    await Promise.all(
      Array.from(
        { length: 16 },
        () =>
          new Promise(resolve => {
            spawn(...command(['scripts', 'run', 'ok']), {
              cwd: sandbox.cwd,
              env,
              stdio: 'ignore',
            }).on('close', resolve)
          }),
      ),
    )

    const lines = async (name: string) =>
      (await readFile(path.join(sandbox.home, '.configfile', name), 'utf8'))
        .split('\n')
        .filter(line => line !== '')
    expect((await lines('history.1.jsonl')).length).toBeGreaterThanOrEqual(count)
    expect([...(await lines('history.1.jsonl')), ...(await lines('history.jsonl'))]).toHaveLength(
      count + 16,
    )
  })
})
