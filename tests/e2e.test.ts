import { spawn, spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createSandbox, type Sandbox } from './helpers.js'

// Built by tests/global-setup.ts before the test run.
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

async function exec(args: string[]) {
  const sandbox = await createSandbox()
  await sandbox.configure()
  await sandbox.write('home/dotfiles/files/zsh/settings.json', '{"files": []}')
  await sandbox.write('home/dotfiles/scripts/fail.sh', 'exit 4\n')

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox.home, NO_COLOR: '1' }
  // FORCE_COLOR (set by many CI and shells) would override NO_COLOR.
  delete env.FORCE_COLOR

  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: sandbox.cwd,
    env,
    encoding: 'utf8',
  })

  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('built CLI', () => {
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
      'Also pass: --force (a configuration already exists), --repo <url>',
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
    async function interrupt(sandbox: Sandbox, script: string, signal: NodeJS.Signals) {
      await sandbox.configure()
      await sandbox.write('home/dotfiles/scripts/long.sh', script)

      const child = spawn(process.execPath, [cli, 'scripts', 'run', 'long'], {
        cwd: sandbox.cwd,
        env: { ...process.env, HOME: sandbox.home, NO_COLOR: '1' },
        detached: true,
      })
      if (child.pid != null) groups.push(child.pid)

      let stdout = ''
      child.stdout.on('data', chunk => {
        stdout += chunk
        if (stdout.includes('ready')) child.kill(signal)
      })

      return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.on('close', (code, closeSignal) => resolve({ code, signal: closeSignal }))
      })
    }

    it('lets the script handle Ctrl+C and reports its exit code', async () => {
      const sandbox = await createSandbox()

      // Only configfile receives SIGINT here; in a terminal the script gets it too.
      const result = await interrupt(sandbox, 'echo ready\nsleep 0.3\nexit 5\n', 'SIGINT')

      expect(result).toEqual({ code: 5, signal: null })
    })

    it('forwards SIGTERM to the script', async () => {
      const sandbox = await createSandbox()

      const result = await interrupt(
        sandbox,
        "trap 'exit 7' TERM\necho ready\nwhile true; do sleep 0.05; done\n",
        'SIGTERM',
      )

      expect(result).toEqual({ code: 7, signal: null })
    })
  })

  it('never loses a file when several configfile processes deploy at once', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    const modules = ['a', 'b', 'c', 'd']
    for (const name of modules) {
      await sandbox.write(`home/dotfiles/files/${name}/x`, name)
      await sandbox.write(
        `home/dotfiles/files/${name}/settings.json`,
        JSON.stringify({
          files: [{ source_path: 'x', target_path: '~/.shared', deploy: 'global' }],
        }),
      )
    }
    await sandbox.write('home/.shared', 'PRECIOUS')

    const runs = modules.map(
      name =>
        new Promise<number | null>(resolve => {
          const child = spawn(process.execPath, [cli, 'modules', 'deploy', name], {
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
      spawnSync(process.execPath, [cli, 'modules', 'undeploy', '--all'], {
        cwd: sandbox.cwd,
        env: { ...process.env, HOME: sandbox.home, NO_COLOR: '1' },
      })
    }
    expect(await readFile(path.join(sandbox.home, '.shared'), 'utf8')).toBe('PRECIOUS')
  })

  it('keeps one whole history line per run when many runs write at once', async () => {
    const sandbox = await createSandbox()
    await sandbox.configure()
    await sandbox.write('home/dotfiles/scripts/ok.sh', 'exit 0\n')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox.home, NO_COLOR: '1' }

    const runs = Array.from(
      { length: 16 },
      () =>
        new Promise<number | null>(resolve => {
          const child = spawn(process.execPath, [cli, 'scripts', 'run', 'ok'], {
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
})
