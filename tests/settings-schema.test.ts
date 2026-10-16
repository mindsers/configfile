// The JSON Schema of settings.json (docs/public/schemas/settings.json, served at
// https://docs.configfile.sh/schemas/settings.json) must accept what configfile
// accepts and refuse what it refuses: each example below goes through both.

import { readFile } from 'node:fs/promises'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import { listModules } from '../src/repository.ts'
import { createSandbox } from './helpers.ts'

const schemaFile = new URL('../docs/public/schemas/settings.json', import.meta.url)
const schema = JSON.parse(await readFile(schemaFile, 'utf8'))
const validate = new Ajv2020({ allErrors: true }).compile(schema)

/** Whether configfile uses every entry of this settings.json, with no error. */
async function configfileAccepts(settings: unknown): Promise<boolean> {
  const sandbox = await createSandbox()
  await sandbox.write('home/dotfiles/files/zsh/zshrc')
  await sandbox.write('home/dotfiles/files/zsh/settings.json', JSON.stringify(settings))

  const [module] = await listModules(sandbox.repo, { ...sandbox, warn: () => {} })
  if (module == null) throw new Error('no module')
  return (
    module.error == null &&
    module.invalidEntries.length === 0 &&
    Object.keys(module.hookProblems).length === 0
  )
}

const zshrc = { source_path: 'zshrc', target_path: '~/.zshrc' }

const accepted: [string, unknown][] = [
  ['a global file', { files: [{ ...zshrc, deploy: 'global' }] }],
  ['a global file linked', { files: [{ ...zshrc, deploy: 'global', method: 'link' }] }],
  ['a global file copied', { files: [{ ...zshrc, deploy: 'global', method: 'copy' }] }],
  [
    'a local file copied',
    { files: [{ source_path: 'zshrc', target_path: '.zshrc', deploy: 'local', method: 'copy' }] },
  ],

  ['a local file', { files: [{ source_path: 'zshrc', target_path: '.zshrc', deploy: 'local' }] }],
  ['a file never deployed, without target', { files: [{ source_path: 'zshrc', deploy: 'none' }] }],
  ['a file never deployed, without source', { files: [{ deploy: 'none' }] }],
  ['a file without strategy (deployed nowhere, with a warning)', { files: [zshrc] }],
  ['no files', { files: [] }],
  ['scripts to run when deployed', { files: [], pre_deploy: 'check', post_deploy: 'setup' }],
  ['scripts to run when undeployed', { files: [], pre_undeploy: 'stop', post_undeploy: 'clean' }],
  ['a "$schema" key', { $schema: 'https://docs.configfile.sh/schemas/settings.json', files: [] }],
]

const refused: [string, unknown][] = [
  ['no "files" key', {}],
  ['"files" that is not a list', { files: {} }],
  ['an entry that is not an object', { files: ['zshrc'] }],
  ['an unknown strategy', { files: [{ ...zshrc, deploy: 'linked' }] }],
  ['the "global" key of 1.x', { files: [{ ...zshrc, global: true }] }],
  ['the configfile 0.3 list format', [{ ...zshrc, deploy: 'global' }]],
  ['an unknown method', { files: [{ ...zshrc, deploy: 'global', method: 'symlink' }] }],
  [
    'a local file linked',
    { files: [{ source_path: 'zshrc', target_path: '.zshrc', deploy: 'local', method: 'link' }] },
  ],
  ['a file linked with "global": false', { files: [{ ...zshrc, global: false, method: 'link' }] }],
  ['both "deploy" and "global"', { files: [{ ...zshrc, deploy: 'global', global: true }] }],
  ['a "global" that is not a boolean', { files: [{ ...zshrc, global: 'yes' }] }],
  ['a deployed file without source', { files: [{ target_path: '~/.zshrc', deploy: 'global' }] }],
  ['an empty source', { files: [{ ...zshrc, source_path: ' ', deploy: 'global' }] }],
  ['a global file without target', { files: [{ source_path: 'zshrc', deploy: 'global' }] }],
  ['a local file without target', { files: [{ source_path: 'zshrc', deploy: 'local' }] }],
  ['an empty target', { files: [{ ...zshrc, target_path: '', deploy: 'global' }] }],
  ['a "post_deploy" that is not a string', { files: [], post_deploy: ['setup'] }],
  ['an empty "post_deploy"', { files: [], post_deploy: ' ' }],
  ['a "pre_deploy" that is not a string', { files: [], pre_deploy: 42 }],
  ['an empty "post_undeploy"', { files: [], post_undeploy: '' }],
  ['a source that is not a string', { files: [{ ...zshrc, source_path: 42, deploy: 'global' }] }],
]

// Stricter on purpose, to catch mistakes in an editor: configfile ignores these.
const refusedByTheSchemaOnly: [string, unknown][] = [
  ['an unknown key in an entry (a typo)', { files: [{ ...zshrc, deploy: 'global', target: 'x' }] }],
  ['an unknown top-level key', { files: [], file: [] }],
  ['a wrong type in an entry never deployed', { files: [{ source_path: 42, deploy: 'none' }] }],
]

describe('settings.json schema', () => {
  it.each(accepted)('accepts %s, as configfile does', async (_, settings) => {
    expect(await configfileAccepts(settings)).toBe(true)
    expect(validate(settings), JSON.stringify(validate.errors)).toBe(true)
  })

  it.each(refused)('refuses %s, as configfile does', async (_, settings) => {
    expect(await configfileAccepts(settings)).toBe(false)
    expect(validate(settings)).toBe(false)
  })

  it.each(refusedByTheSchemaOnly)('refuses %s, which configfile ignores', async (_, settings) => {
    expect(await configfileAccepts(settings)).toBe(true)
    expect(validate(settings)).toBe(false)
  })

  it('describes the keys the modules reference documents', async () => {
    const page = await readFile(
      new URL('../docs/src/content/docs/reference/modules.md', import.meta.url),
      'utf8',
    )
    const documented = [...page.matchAll(/^\| `(\w+)` \|/gm)].map(match => match[1])

    // The keys of an entry, and those of the file itself next to "files".
    const { $schema, files, ...settings } = schema.properties
    const described = [...Object.keys(schema.$defs.entry.properties), ...Object.keys(settings)]

    expect(described.sort()).toEqual(documented.sort())
  })

  it('is served where its $id says, from the documentation site', () => {
    expect(schema.$id).toBe('https://docs.configfile.sh/schemas/settings.json')
  })
})
