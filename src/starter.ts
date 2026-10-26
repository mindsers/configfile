import { redactUrl } from './output.ts'
import { DEFAULT_MODULE_SETTINGS, REPOSITORY_SETTINGS } from './repository.ts'

/** A file of a new dotfiles repository. */
export interface StarterFile {
  /** Relative to the repository, with `/`. */
  readonly path: string
  readonly content: string
  readonly executable: boolean
}

/** The schemas the settings files point to, for editors. */
export const REPOSITORY_SCHEMA = 'https://docs.configfile.sh/schemas/repository.json'
export const MODULE_SCHEMA = 'https://docs.configfile.sh/schemas/module.json'

/**
 * The files `init` writes into a new dotfiles repository: its settings, a
 * README, a module and a script to start from. The example module deploys
 * nothing, so that deploying every module anywhere stays harmless, and the
 * settings name no script, so that none runs on its own. The README shows
 * the repository's `url` without its credentials, if any: it is pushed.
 */
export function starterFiles(url: string): StarterFile[] {
  const file = (path: string, content: string, executable = false) => ({
    path,
    content,
    executable,
  })
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  return [
    file(REPOSITORY_SETTINGS, json({ $schema: REPOSITORY_SCHEMA })),
    file('README.md', readme(publicUrl(url))),
    file(
      `files/example/${DEFAULT_MODULE_SETTINGS}`,
      json({
        $schema: MODULE_SCHEMA,
        files: [{ source_path: 'example.conf', target_path: '~/.example.conf', deploy: 'none' }],
      }),
    ),
    file(
      'files/example/example.conf',
      '# A file of the example module. Its entry in configfile.module.json says\n' +
        '# "deploy": "none": configfile keeps it here and never deploys it.\n',
    ),
    file(
      'scripts/hello.sh',
      '#!/bin/sh\n' +
        '# An example script: run it with "configfile scripts run hello".\n' +
        'echo "Hello from $CONFIGFILE_REPO, on $CONFIGFILE_OS."\n',
      true,
    ),
  ]
}

function readme(url: string): string {
  return `# Dotfiles

My configuration files and setup scripts, deployed with [configfile](https://docs.configfile.sh).

## Set up a machine

\`\`\`sh
configfile init --repo ${url}
configfile modules deploy --all
\`\`\`

## What is in this repository

- \`files/\`: one folder per tool, called a module. Each holds the tool's files and a
  \`${DEFAULT_MODULE_SETTINGS}\` that says where they go.
- \`scripts/\`: scripts that \`configfile scripts run <name>\` runs, such as \`hello\`.
- \`${REPOSITORY_SETTINGS}\`: the settings of the repository.

## Add your files

Add a file of this machine to a module, which configfile commits here and pushes:

\`\`\`sh
configfile modules adopt --module zsh ~/.zshrc
\`\`\`

Or edit this repository, commit and push, then run \`configfile update\` on each machine.

\`files/example\` shows what a module looks like: its file is never deployed
(\`"deploy": "none"\`). Change it, or remove it once you have your own modules. See the
[modules reference](https://docs.configfile.sh/reference/modules/).
`
}

/** The URL without credentials. */
function publicUrl(url: string): string {
  if (redactUrl(url) === url) return url
  const parsed = new URL(url)
  parsed.username = ''
  parsed.password = ''
  return parsed.toString()
}
