import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ensureGit, git, gitInstallHint, gitOutput } from '../src/process.ts'
import { createSandbox } from './helpers.ts'

/** The os-release file of this machine, as configfile reads it. */
async function osRelease(): Promise<string | null> {
  return readFile('/etc/os-release', 'utf8')
    .catch(() => readFile('/usr/lib/os-release', 'utf8'))
    .catch(() => null)
}

/** What configfile says on this machine when git is missing. */
async function missingGitMessage(): Promise<string> {
  return `git is not installed. ${gitInstallHint(process.platform, await osRelease())}`
}

const DEBIAN_12 = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"
`

describe('gitInstallHint', () => {
  it.each([
    ['macOS', 'darwin', null, 'xcode-select --install'],
    ['Ubuntu', 'linux', 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n', 'sudo apt install git'],
    ['Linux Mint', 'linux', 'ID=linuxmint\nID_LIKE="ubuntu debian"\n', 'sudo apt install git'],
    // VERSION_ID comes before ID, as in the real file.
    ['Debian 12', 'linux', DEBIAN_12, 'sudo apt install git'],
    ['a commented line', 'linux', '# ID=fedora\nID=debian\n', 'sudo apt install git'],
    ['Fedora', 'linux', 'ID=fedora\n', 'sudo dnf install git'],
    ['Rocky Linux', 'linux', 'ID="rocky"\nID_LIKE="rhel centos fedora"\n', 'sudo dnf install git'],
    ['Alpine', 'linux', 'ID=alpine\n', 'sudo apk add git'],
    ['Arch', 'linux', 'ID=arch\n', 'sudo pacman -S git'],
    [
      'openSUSE',
      'linux',
      'ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n',
      'sudo zypper install git',
    ],
    ['an unknown Linux', 'linux', 'ID=plan9\n', 'the package manager of your system'],
    ['a Linux without os-release', 'linux', null, 'the package manager of your system'],
  ] as const)('%s', (_, platform, osRelease, expected) => {
    expect(gitInstallHint(platform, osRelease)).toContain(expected)
  })
})

describe('ensureGit', () => {
  /** A fake git: a shell script, executable unless `mode` says otherwise. */
  async function fakeGit(script: string, mode = 0o755) {
    const sandbox = await createSandbox()
    return {
      cwd: sandbox.home,
      command: await sandbox.write('bin/git', `#!/bin/sh\n${script}\n`, mode),
    }
  }

  it('accepts a working git', async () => {
    const sandbox = await createSandbox()

    await expect(ensureGit({ cwd: sandbox.home })).resolves.toBeUndefined()
  })

  it('says how to install git on this system when it is missing', async () => {
    const sandbox = await createSandbox()

    await expect(
      ensureGit({ cwd: sandbox.home, command: 'configfile-no-such-git' }),
    ).rejects.toThrow(await missingGitMessage())
  })

  it.each([
    [
      'the xcrun error, on stderr',
      'echo "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun" >&2; exit 1',
    ],
    [
      'the xcode-select note',
      'echo "xcode-select: note: No developer tools were found, requesting install." >&2; exit 1',
    ],
    [
      'the xcrun error, on stdout',
      'echo "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)"; exit 1',
    ],
  ])("explains macOS's git that needs the developer tools: %s", async (_, script) => {
    const options = await fakeGit(script)

    const failure = ensureGit(options)

    await expect(failure).rejects.toThrow(
      /^git needs Apple's command line developer tools \(.+\)\. Install them with: xcode-select --install/,
    )
  })

  it('reports other xcrun errors as they are', async () => {
    const options = await fakeGit(
      'echo "xcrun: error: missing DEVELOPER_DIR path: /nowhere" >&2; exit 1',
    )

    await expect(ensureGit(options)).rejects.toThrow(
      'git does not work: xcrun: error: missing DEVELOPER_DIR path: /nowhere',
    )
  })

  it('reports a git that fails for another reason', async () => {
    const options = await fakeGit('echo "error while loading shared libraries" >&2; exit 127')

    await expect(ensureGit(options)).rejects.toThrow(
      'git does not work: error while loading shared libraries',
    )
  })

  it('names the signal that stopped git', async () => {
    const options = await fakeGit('kill -9 $$')

    await expect(ensureGit(options)).rejects.toThrow('git does not work: stopped by SIGKILL')
  })

  it('stops waiting for a git that does not answer', async () => {
    const options = await fakeGit('sleep 30')

    await expect(ensureGit({ ...options, timeoutMs: 300 })).rejects.toThrow(
      'git did not answer within 0.3 seconds (git --version).',
    )
  })

  it('says when git is found but cannot be executed', async () => {
    const options = await fakeGit('exit 0', 0o644)

    await expect(ensureGit(options)).rejects.toThrow(
      /^git was found but cannot be executed \(permission denied\)/,
    )
  })
})

describe('git and gitOutput', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('say how to install git when it is missing', async () => {
    const sandbox = await createSandbox()
    vi.stubEnv('PATH', '/nonexistent')
    const message = await missingGitMessage()

    await expect(gitOutput(['status'], { cwd: sandbox.root })).rejects.toThrow(message)
    await expect(gitOutput(['status'], { cwd: sandbox.root, allowFailure: true })).rejects.toThrow(
      message,
    )
    await expect(git(['status'], { cwd: sandbox.root }, 'git status')).rejects.toThrow(message)
  })

  it('never blame git for a missing working folder', async () => {
    const sandbox = await createSandbox()
    const missing = path.join(sandbox.root, 'gone')

    await expect(gitOutput(['status'], { cwd: missing })).rejects.toThrow(
      `Cannot run git in ${missing}: the folder does not exist.`,
    )
    await expect(git(['status'], { cwd: missing }, 'git status')).rejects.toThrow(
      `Cannot run git in ${missing}: the folder does not exist.`,
    )
  })
})
