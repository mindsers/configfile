import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ensureGit, gitInstallHint } from '../src/process.ts'
import { createSandbox } from './helpers.ts'

describe('gitInstallHint', () => {
  it.each([
    ['macOS', 'darwin', null, 'xcode-select --install'],
    ['Ubuntu', 'linux', 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n', 'sudo apt install git'],
    ['Linux Mint', 'linux', 'ID=linuxmint\nID_LIKE="ubuntu debian"\n', 'sudo apt install git'],
    ['Debian', 'linux', 'ID=debian\n', 'sudo apt install git'],
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
  it('accepts a working git', async () => {
    await expect(ensureGit()).resolves.toBeUndefined()
  })

  it('says how to install git when it is missing', async () => {
    await expect(ensureGit({ command: 'configfile-no-such-git' })).rejects.toThrow(
      /^git is not installed\. Install it with/,
    )
  })

  it("explains macOS's git that needs the developer tools", async () => {
    const sandbox = await createSandbox()
    const stub = await sandbox.write(
      'bin/git',
      '#!/bin/sh\necho "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun" >&2\nexit 1\n',
      0o755,
    )

    await expect(ensureGit({ command: stub })).rejects.toThrow(
      "git needs Apple's command line developer tools. Install them with: xcode-select --install",
    )
  })

  it('reports a git that fails for another reason', async () => {
    const sandbox = await createSandbox()
    const broken = await sandbox.write(
      'bin/git',
      '#!/bin/sh\necho "error while loading shared libraries" >&2\nexit 127\n',
      0o755,
    )

    await expect(ensureGit({ command: path.resolve(broken) })).rejects.toThrow(
      'git does not work: error while loading shared libraries',
    )
  })
})
