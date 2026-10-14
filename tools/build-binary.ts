// Builds the standalone binary of configfile for the system it runs on: a
// copy of this Node.js with configfile bundled into it (Node.js single
// executable applications), so that a new machine needs neither Node.js nor
// a package manager. Run it with the Node.js the binary should embed:
//
//   node tools/build-binary.ts
//
// It writes release/configfile-<system>-<arch>.tar.gz, holding the binary
// `configfile`, its LICENSE, and THIRD-PARTY-LICENSES (Node.js and the
// bundled packages). The binary is run once, to check it starts.

import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
/** The sentinel Node.js looks for to know it carries an application. */
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
/** The systems and architectures binaries are made for, by their name in releases. */
const SYSTEMS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macos', linux: 'linux' }
const ARCHS: Partial<Record<NodeJS.Architecture, string>> = { arm64: 'arm64', x64: 'x64' }

/** The name of the archive for this system, such as `configfile-macos-arm64.tar.gz`. */
export function archiveName(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  const system = SYSTEMS[platform]
  const machine = ARCHS[arch]
  if (system == null || machine == null) {
    throw new Error(`No binary is made for ${platform} ${arch}.`)
  }
  return `configfile-${system}-${machine}.tar.gz`
}

async function main(): Promise<void> {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    version: string
  }
  const archive = path.join(root, 'release', archiveName(process.platform, process.arch))
  const work = await mkdtemp(path.join(tmpdir(), 'configfile-binary-'))

  try {
    // 1. One CommonJS file: the form Node.js runs in a single executable.
    const bundle = path.join(work, 'configfile.cjs')
    const { metafile } = await build({
      entryPoints: [path.join(root, 'src/cli.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: `node${process.versions.node}`,
      outfile: bundle,
      define: { CONFIGFILE_VERSION: JSON.stringify(version) },
      legalComments: 'none',
      metafile: true,
      logLevel: 'warning',
      // import.meta is only read when CONFIGFILE_VERSION is not set, which it is here.
      logOverride: { 'empty-import-meta': 'silent' },
    })

    // 2. The blob Node.js loads at start, then a copy of Node.js carrying it.
    const config = path.join(work, 'sea-config.json')
    const blob = path.join(work, 'sea.blob')
    await writeFile(
      config,
      JSON.stringify({
        main: bundle,
        output: blob,
        disableExperimentalSEAWarning: true,
        // NODE_OPTIONS is for the user's Node.js: it must not change how configfile starts.
        execArgvExtension: 'none',
      }),
    )
    execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' })

    const folder = path.join(work, 'configfile')
    await mkdir(folder)
    const binary = path.join(folder, 'configfile')
    await copyFile(process.execPath, binary)
    // macOS checks the signature of every binary: the one Node.js came with
    // no longer matches once the blob is added, so it is replaced.
    if (process.platform === 'darwin') {
      execFileSync('codesign', ['--remove-signature', binary], { stdio: 'inherit' })
    }
    execFileSync(
      path.join(root, 'node_modules/.bin/postject'),
      [
        binary,
        'NODE_SEA_BLOB',
        blob,
        '--sentinel-fuse',
        FUSE,
        ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
      ],
      { stdio: 'inherit' },
    )
    if (process.platform === 'darwin') {
      execFileSync('codesign', ['--sign', '-', binary], { stdio: 'inherit' })
    }

    // 3. It starts, and says the version it was built for.
    const reported = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
    if (reported !== version) {
      throw new Error(`The binary says it is ${reported}, not ${version}.`)
    }

    // 4. The archive, with the licenses of what the binary contains.
    await copyFile(path.join(root, 'LICENSE'), path.join(folder, 'LICENSE'))
    await writeFile(
      path.join(folder, 'THIRD-PARTY-LICENSES'),
      await thirdPartyLicenses(Object.keys(metafile.inputs)),
    )
    await mkdir(path.dirname(archive), { recursive: true })
    await rm(archive, { force: true })
    execFileSync('tar', ['-czf', archive, '-C', folder, '.'], { stdio: 'inherit' })
    console.log(
      `${path.relative(root, archive)}: configfile ${version}, Node.js ${process.version}`,
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * The licenses of Node.js (the binary is a copy of it) and of every package
 * bundled into it, found from the files the bundle was made of.
 */
async function thirdPartyLicenses(inputs: string[]): Promise<string> {
  const sections: string[] = []
  const node = path.resolve(path.dirname(process.execPath), '..', 'LICENSE')
  sections.push(`Node.js ${process.version}\n\n${await readFile(node, 'utf8')}`)

  const packages = new Set<string>()
  for (const input of inputs) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)
    if (match?.[1] != null) packages.add(path.resolve(root, match[1]))
  }
  for (const folder of [...packages].sort()) {
    const { name, version } = JSON.parse(
      await readFile(path.join(folder, 'package.json'), 'utf8'),
    ) as { name: string; version: string }
    const file = (await readdir(folder)).find(entry => /^licen[sc]e/i.test(entry))
    if (file == null) throw new Error(`${name} ${version} has no license file to ship.`)
    sections.push(`${name} ${version}\n\n${await readFile(path.join(folder, file), 'utf8')}`)
  }
  return `${sections.map(section => section.trimEnd()).join(`\n\n${'-'.repeat(72)}\n\n`)}\n`
}

if (import.meta.main) await main()
