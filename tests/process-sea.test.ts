// In a standalone binary (tools/build-binary.ts), configfile's Node.js runs
// only configfile: JavaScript scripts without shebang line run with the node
// found in PATH. isSea() is read when src/process.ts loads, hence this file.

import { chmod, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runScript } from '../src/process.ts'
import { createSandbox, type Sandbox } from './helpers.ts'

vi.mock('node:sea', () => ({ isSea: () => true }))

async function withScript(sandbox: Sandbox) {
  const file = await sandbox.write('scripts/hello.js', 'console.log("hello")\n')
  return { name: 'hello', file: 'hello.js', path: file }
}

describe('runScript in a standalone binary', () => {
  it('runs a .js script without shebang line with the node found in PATH', async () => {
    const sandbox = await createSandbox()
    const script = await withScript(sandbox)
    const log = path.join(sandbox.root, 'log')
    // A stand-in for node: says what it was given.
    await sandbox.write('bin/node', `#!/bin/sh\necho "$@" > "${log}"\nexit 3\n`, 0o755)

    const code = await runScript(script, ['--flag'], {
      cwd: sandbox.cwd,
      env: { PATH: `${path.join(sandbox.root, 'bin')}:/usr/bin:/bin` },
    })

    expect(code).toBe(3)
    expect(await readFile(log, 'utf8')).toBe(`${script.path} --flag\n`)
  })

  it('says to install Node.js when there is none', async () => {
    const sandbox = await createSandbox()
    const script = await withScript(sandbox)

    await expect(
      runScript(script, [], { cwd: sandbox.cwd, env: { PATH: path.join(sandbox.root, 'none') } }),
    ).rejects.toThrow(
      'Script "hello" needs Node.js, which is not installed. Install it, or add a shebang line',
    )
  })

  // root runs any file whatever its permissions.
  it.skipIf(process.getuid?.() === 0)(
    'names the node of PATH when it cannot be executed',
    async () => {
      const sandbox = await createSandbox()
      const script = await withScript(sandbox)
      const node = await sandbox.write('bin/node', '#!/bin/sh\n')
      await chmod(node, 0o644)

      await expect(
        runScript(script, [], {
          cwd: sandbox.cwd,
          env: { PATH: path.join(sandbox.root, 'bin') },
        }),
      ).rejects.toThrow(
        'Cannot run script "hello": the node found in PATH cannot be executed (permission denied).',
      )
    },
  )
})
