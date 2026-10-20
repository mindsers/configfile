// The install script (docs/public/install.sh, published with the docs at
// https://docs.configfile.sh/install.sh, where https://configfile.sh/install.sh
// redirects), run against a fake release on disk.
// Fake `uname`, `sysctl` and `ldd` commands, first in PATH, play the system.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { archiveName } from '../tools/build-binary.ts'
import { createSandbox, type Sandbox } from './helpers.ts'

const script = fileURLToPath(new URL('../docs/public/install.sh', import.meta.url))

/** Every archive a release has, by the system (`uname -s`, `uname -m`) it is for. */
const ARCHIVES: [string, string, string][] = [
  ['Darwin', 'arm64', archiveName('darwin', 'arm64')],
  ['Darwin', 'x86_64', archiveName('darwin', 'x64')],
  ['Linux', 'x86_64', archiveName('linux', 'x64')],
  ['Linux', 'amd64', archiveName('linux', 'x64')],
  ['Linux', 'aarch64', archiveName('linux', 'arm64')],
  ['Linux', 'arm64', archiveName('linux', 'arm64')],
]
/** The system the tests play by default: Linux on x64. */
const NAME = archiveName('linux', 'x64')

/**
 * A release in <sandbox>/releases/<folder>, laid out as on GitHub: an archive
 * per system holding a stand-in for the binary (`binary`, which says its
 * version by default), and SHA256SUMS. `sums` rewrites the lines of SHA256SUMS.
 */
async function withRelease(
  sandbox: Sandbox,
  version: string,
  {
    folder = `download/${version}`,
    binary = `#!/bin/sh\necho ${version}\n`,
    sums = (line: string) => line,
  }: { folder?: string; binary?: string; sums?: (line: string) => string } = {},
) {
  const dir = path.join(sandbox.root, 'releases', folder)
  // As tools/build-binary.ts lays it out.
  await sandbox.write('build/configfile', binary, 0o755)
  await sandbox.write('build/LICENSE', 'license')
  await sandbox.write('build/THIRD-PARTY-LICENSES', 'licenses')
  await mkdir(dir, { recursive: true })
  const lines = [`${'0'.repeat(64)}  configfile-${version}.tgz`]
  for (const name of new Set(ARCHIVES.map(([, , name]) => name))) {
    execFileSync('tar', ['-czf', path.join(dir, name), '-C', path.join(sandbox.root, 'build'), '.'])
    const sum = createHash('sha256')
      .update(await readFile(path.join(dir, name)))
      .digest('hex')
    lines.push(sums(`${sum}  ${name}`))
  }
  await writeFile(path.join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  return dir
}

interface System {
  /** `uname -s` and `uname -m`. */
  uname?: [string, string]
  /** What `sysctl -n sysctl.proc_translated` says (1: under Rosetta). */
  translated?: string
  /** What `ldd --version` prints. */
  libc?: string
  /** Replaces the PATH of the user, after the fake commands. */
  path?: string
}

/** Runs install.sh as on `system`, with the version 9.9.9 by default. */
async function install(sandbox: Sandbox, env: Record<string, string> = {}, system: System = {}) {
  const { uname = ['Linux', 'x86_64'], translated = '0', libc = 'ldd (GNU libc) 2.39' } = system
  const fake = path.join(sandbox.root, 'fake')
  await sandbox.write(
    'fake/uname',
    `#!/bin/sh\ncase "$1" in -s) echo ${uname[0]} ;; -m) echo ${uname[1]} ;; esac\n`,
    0o755,
  )
  await sandbox.write('fake/sysctl', `#!/bin/sh\necho ${translated}\n`, 0o755)
  await sandbox.write('fake/ldd', `#!/bin/sh\necho '${libc}' >&2\n`, 0o755)

  const result = spawnSync('/bin/sh', [script], {
    cwd: sandbox.cwd,
    encoding: 'utf8',
    env: {
      PATH: `${fake}:${system.path ?? process.env.PATH ?? ''}`,
      HOME: sandbox.home,
      // As in most terminals: a UTF-8 locale changes how some shells read the script.
      LANG: 'en_US.UTF-8',
      CONFIGFILE_DOWNLOAD_URL: pathToFileURL(path.join(sandbox.root, 'releases')).href,
      CONFIGFILE_VERSION: '9.9.9',
      ...env,
    },
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * A folder with links to these commands only, for a PATH without the others.
 * Commands this system doesn't have are left out.
 */
async function only(sandbox: Sandbox, ...commands: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(sandbox.root, 'only-'))
  for (const command of commands) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' })
    if (found.status === 0) await symlink(found.stdout.trim(), path.join(dir, command))
  }
  return dir
}

/** What install.sh needs from the system, besides a downloader and a checksum tool. */
const BASICS = [
  'sh',
  'mktemp',
  'rm',
  'awk',
  'cut',
  'grep',
  'tar',
  'gzip',
  'mkdir',
  'cp',
  'chmod',
  'mv',
]

const installed = (sandbox: Sandbox) => path.join(sandbox.home, '.local/bin/configfile')

describe('install.sh', () => {
  it('installs the binary of the release in ~/.local/bin, checked against SHA256SUMS', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')

    const result = await install(sandbox)

    const binary = installed(sandbox)
    expect(result.code, result.stderr).toBe(0)
    expect(execFileSync(binary, { encoding: 'utf8' })).toBe('9.9.9\n')
    expect(result.stdout).toContain(`configfile 9.9.9 is installed in ${binary}.`)
    expect(result.stdout).toContain(`${path.dirname(binary)} is not in your PATH`)
    expect(result.stdout).toContain('Next: run "configfile init"')
    // Only the binary: the licenses stay in the archive, and no draft is left.
    expect(await readdir(path.dirname(binary))).toEqual(['configfile'])
  })

  it.each(ARCHIVES)('downloads the archive for %s %s: %s', async (system, machine, name) => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')

    const result = await install(sandbox, {}, { uname: [system, machine] })

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(`/releases/download/9.9.9/${name}...`)
  })

  it('downloads the archive for Apple silicon from a shell running under Rosetta', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')

    const result = await install(sandbox, {}, { uname: ['Darwin', 'x86_64'], translated: '1' })

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(`/${archiveName('darwin', 'arm64')}...`)
  })

  it.each([
    [['FreeBSD', 'amd64'], 'no configfile binary for FreeBSD: it runs on macOS and Linux.'],
    [['Linux', 'riscv64'], 'no configfile binary for riscv64 processors: install it with npm'],
  ] as const)('refuses a system it has no binary for: %s', async (uname, message) => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')

    const result = await install(sandbox, {}, { uname: [...uname] })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(message)
    expect(existsSync(installed(sandbox))).toBe(false)
  })

  it('refuses a Linux without the GNU C library (Alpine)', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')

    const result = await install(sandbox, {}, { libc: 'musl libc (x86_64)' })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'needs the GNU C library, not musl (Alpine): install it with npm',
    )
    expect(existsSync(installed(sandbox))).toBe(false)
  })

  it('installs where CONFIGFILE_INSTALL_DIR says, replacing an older version', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')
    const dir = path.join(sandbox.root, 'bin')
    await sandbox.write('bin/configfile', '#!/bin/sh\necho 1.0.0\n', 0o755)

    const result = await install(
      sandbox,
      { CONFIGFILE_INSTALL_DIR: dir },
      { path: `${dir}:${process.env.PATH ?? ''}` },
    )

    expect(result.code, result.stderr).toBe(0)
    expect(execFileSync(path.join(dir, 'configfile'), { encoding: 'utf8' })).toBe('9.9.9\n')
    expect(result.stdout).not.toContain('not in your PATH')
    expect(result.stdout).not.toContain('Another configfile')
  })

  it('says when another configfile comes first in PATH', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')
    const other = path.join(sandbox.root, 'other')
    await sandbox.write('other/configfile', '#!/bin/sh\necho 0.3.1\n', 0o755)

    const result = await install(
      sandbox,
      {},
      { path: `${other}:${path.dirname(installed(sandbox))}:${process.env.PATH ?? ''}` },
    )

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      `Another configfile comes first in your PATH: ${path.join(other, 'configfile')}.`,
    )
  })

  it('keeps the installed configfile when the new one does not start on this system', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9', { binary: '#!/bin/sh\nexit 1\n' })
    await sandbox.write('home/.local/bin/configfile', '#!/bin/sh\necho 1.0.0\n', 0o755)

    const result = await install(sandbox)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `the downloaded configfile does not start on this system: nothing was changed in ${path.dirname(installed(sandbox))}.`,
    )
    expect(execFileSync(installed(sandbox), { encoding: 'utf8' })).toBe('1.0.0\n')
    expect(await readdir(path.dirname(installed(sandbox)))).toEqual(['configfile'])
  })

  it('installs nothing when the download does not match its checksum', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9', { sums: line => `${'f'.repeat(64)}${line.slice(64)}` })

    const result = await install(sandbox)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`${NAME} does not match the checksum of the release`)
    expect(existsSync(installed(sandbox))).toBe(false)
  })

  it('installs nothing when SHA256SUMS has no line for the archive', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9', { sums: () => '' })

    const result = await install(sandbox)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`SHA256SUMS of the release has no line for ${NAME}.`)
    expect(existsSync(installed(sandbox))).toBe(false)
  })

  it('reads SHA256SUMS lines written for binary files (*name)', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9', { sums: line => line.replace('  ', ' *') })

    const result = await install(sandbox)

    expect(result.code, result.stderr).toBe(0)
  })

  it('says which download failed', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')

    const result = await install(sandbox, { CONFIGFILE_VERSION: '8.8.8' })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`cannot download ${pathToFileURL(sandbox.root).href}`)
    expect(result.stderr).toContain(`/releases/download/8.8.8/${NAME}`)
  })

  it('installs the latest release by default', async () => {
    const sandbox = await createSandbox()
    // GitHub serves the latest release at releases/latest/download/.
    await withRelease(sandbox, '9.9.9', { folder: 'latest/download' })

    const result = await install(sandbox, { CONFIGFILE_VERSION: '' })

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(`/releases/latest/download/${NAME}...`)
  })

  it('says when the folder to install into cannot be created', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')
    const file = await sandbox.write('file')

    const result = await install(sandbox, { CONFIGFILE_INSTALL_DIR: path.join(file, 'bin') })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`cannot create ${path.join(file, 'bin')}.`)
  })

  it('downloads with wget when curl is missing', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')
    // wget cannot read file:// URLs: a stand-in copies the file.
    await sandbox.write(
      'wget/wget',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion.
      '#!/bin/sh\n# wget -q -O <file> <url>\ncp "${4#file://}" "$3"\n',
      0o755,
    )
    const tools = await only(sandbox, ...BASICS, 'sha256sum', 'shasum', 'git')

    const result = await install(
      sandbox,
      {},
      { path: `${path.join(sandbox.root, 'wget')}:${tools}` },
    )

    expect(result.code, result.stderr).toBe(0)
    expect(execFileSync(installed(sandbox), { encoding: 'utf8' })).toBe('9.9.9\n')
  })

  it('says what is missing to download or check the binary, once', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')

    const noDownloader = await install(
      sandbox,
      {},
      { path: await only(sandbox, ...BASICS, 'sha256sum', 'shasum') },
    )
    const noChecksum = await install(sandbox, {}, { path: await only(sandbox, ...BASICS, 'curl') })

    expect(noDownloader.code).toBe(1)
    expect(noDownloader.stderr).toContain('curl or wget is needed to download configfile.')
    expect(noChecksum.code).toBe(1)
    expect(noChecksum.stderr.trim()).toBe(
      'configfile installer: sha256sum or shasum is needed to check the download.',
    )
  })

  it('says when git is missing', async () => {
    const sandbox = await createSandbox()
    await withRelease(sandbox, '9.9.9')
    const tools = await only(sandbox, ...BASICS, 'curl', 'sha256sum', 'shasum')

    const result = await install(sandbox, {}, { path: tools })

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      "configfile needs git: install it with your system's package manager.",
    )
  })
})
