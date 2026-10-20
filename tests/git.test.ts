import { readFile, symlink } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkRepositoryUrl } from '../src/git-url.ts'
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
    // Computed first: the rejection must be awaited as soon as it exists.
    const message = await missingGitMessage()

    await expect(ensureGit({ command: 'configfile-no-such-git' })).rejects.toThrow(message)
  })

  it('needs no particular folder', async () => {
    await expect(ensureGit()).resolves.toBeUndefined()
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

  it('reports a removed Xcode as it is', async () => {
    const options = await fakeGit(
      'echo "xcrun: error: invalid active developer path (/Applications/Xcode.app/Contents/Developer)" >&2; exit 1',
    )

    await expect(ensureGit(options)).rejects.toThrow(
      'git does not work: xcrun: error: invalid active developer path (/Applications/Xcode.app/Contents/Developer)',
    )
  })

  it('quotes only the first line of the developer tools message', async () => {
    const options = await fakeGit(
      'echo "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)" >&2; echo "second line" >&2; exit 1',
    )

    const failure = ensureGit(options)

    await expect(failure).rejects.toThrow(
      "git needs Apple's command line developer tools (xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)). Install them with: xcode-select --install",
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

  it('stops waiting on time even when something git started keeps its output open', async () => {
    const sandbox = await createSandbox()
    const pidFile = path.join(sandbox.root, 'escaped.pid')
    // A child that leaves git's process group, so the group kill misses it.
    const command = await sandbox.write(
      'bin/git',
      `#!/bin/sh\nperl -e 'use POSIX; setsid(); sleep 20' &\necho $! > "${pidFile}"\nsleep 30\n`,
      0o755,
    )
    const started = Date.now()

    try {
      await expect(ensureGit({ command, timeoutMs: 300 })).rejects.toThrow(
        'git did not answer within 0.3 seconds',
      )
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''))
      if (pid > 0) process.kill(pid, 'SIGKILL')
    }
  })

  it('leaves no timer behind once git has answered', async () => {
    const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length
    const before = timers()

    await ensureGit()

    expect(timers()).toBe(before)
  })

  it('says when git cannot be executed', async () => {
    const options = await fakeGit('exit 0', 0o644)
    const hint = gitInstallHint(process.platform, await osRelease())

    await expect(ensureGit(options)).rejects.toThrow(
      'git cannot be executed (permission denied). Check the git found in PATH and the ' +
        `permissions of the folders in PATH, or reinstall git. ${hint}`,
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

  it('never blame git for a working folder that cannot be used', async () => {
    const sandbox = await createSandbox()
    const missing = path.join(sandbox.root, 'gone')
    const brokenLink = path.join(sandbox.root, 'broken-link')
    await symlink(path.join(sandbox.root, 'nowhere'), brokenLink)
    const file = await sandbox.write('a-file', '')

    for (const [cwd, problem] of [
      [missing, 'the folder does not exist'],
      [brokenLink, 'the folder does not exist'],
      [file, 'it is not a folder'],
    ] as const) {
      const message = `Cannot run git in ${cwd}: ${problem}.`
      await expect(gitOutput(['status'], { cwd })).rejects.toThrow(message)
      await expect(git(['status'], { cwd }, 'git status')).rejects.toThrow(message)
    }
  })
})

describe('checkRepositoryUrl', () => {
  const where = { home: '/home/me', cwd: '/work' }

  it.each([
    'https://github.com/mindsers/configfile.git', // #48
    'http://example.com/dotfiles',
    'ssh://git@github.com:22/me/dotfiles.git',
    'git+ssh://git@github.com/me/dotfiles.git',
    'git://example.com/dotfiles.git',
    'file:///srv/git/dotfiles.git',
    'git@github.com:me/dotfiles.git',
    'example.com:dotfiles.git',
    'persistent-https::https://example.com/dotfiles.git',
  ])('accepts %s as it is', url => {
    expect(checkRepositoryUrl(` ${url} `, where)).toEqual({ url })
  })

  it.each([
    ['', 'A repository URL is required.'],
    ['--upload-pack=touch /tmp/x', 'is not a repository URL'],
    ['htps://github.com/me/dotfiles.git', '"htps://" is not a protocol git can clone from.'],
    ['https://github.com', 'the path is missing'],
    ['https://github.com/', 'the path is missing'],
    ['ssh://host:port/repo', 'is not a valid URL'],
    ['git@:me/dotfiles.git', 'has no valid host name'],
    ['git@github.com:', 'nothing after ":"'],
    ['github.com/me/dotfiles', 'nor an existing folder'],
    ['dotfiles', 'nor an existing folder'],
  ])('refuses %j', (url, error) => {
    const result = checkRepositoryUrl(url, where)
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain(error)
  })

  it('hides credentials in its messages', () => {
    const result = checkRepositoryUrl('https://me:secret@github.com/', where)
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('accepts an existing local folder, made absolute', async () => {
    const sandbox = await createSandbox()
    await sandbox.write('home/repos/dotfiles/.keep')
    await sandbox.write('cwd/dotfiles/.keep')
    const here = { home: sandbox.home, cwd: sandbox.cwd }

    expect(checkRepositoryUrl('~/repos/dotfiles', here)).toEqual({
      url: path.join(sandbox.home, 'repos/dotfiles'),
    })
    expect(checkRepositoryUrl('dotfiles', here)).toEqual({
      url: path.join(sandbox.cwd, 'dotfiles'),
    })
    expect(checkRepositoryUrl(sandbox.root, here)).toEqual({ url: sandbox.root })
  })
})
