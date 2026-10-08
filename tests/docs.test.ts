import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { COMMANDS_PAGE, renderCommandsPage } from '../tools/docs-commands.ts'

const page = await readFile(COMMANDS_PAGE, 'utf8')
const block = (name: string, content = '') =>
  `<!-- generated: ${name} -->\n${content}<!-- /generated -->`

describe('commands reference', () => {
  it('documents every command, with its current usage and options', () => {
    // On failure, run "pnpm docs:commands" and commit the page (a new command
    // first needs its <!-- generated --> block, see CONTRIBUTING.md).
    expect(renderCommandsPage(page)).toBe(page)
  })

  it('rewrites stale blocks, and leaves everything else as it is', () => {
    const stale = page
      .replace(
        /(<!-- generated: configfile init -->\n)[\s\S]*?(<!-- \/generated -->)/,
        '$1STALE\n$2',
      )
      .replace('<!-- generated: configfile update -->', '<!-- generated:  configfile update  -->')
    expect(stale).toContain('STALE')

    const rendered = renderCommandsPage(stale)

    expect(rendered).not.toContain('STALE')
    expect(rendered).toBe(
      // Only the stale content changed: the marker keeps its spacing.
      page.replace(
        '<!-- generated: configfile update -->',
        '<!-- generated:  configfile update  -->',
      ),
    )
  })

  it('keeps Windows line endings', () => {
    const crlf = page.replaceAll('\n', '\r\n')

    expect(renderCommandsPage(crlf)).toBe(crlf)
  })

  it('refuses unknown, missing and duplicate commands, listing every problem', () => {
    const wrong = `${block('configfile nope')}\n${page}\n${block('configfile init')}\n`

    const error = (() => {
      try {
        renderCommandsPage(
          wrong.replace(/<!-- generated: configfile history -->[\s\S]*?<!-- \/generated -->/, ''),
        )
      } catch (thrown) {
        return (thrown as Error).message
      }
      return ''
    })()

    expect(error).toContain('"configfile nope" is not a command.')
    expect(error).toContain('"configfile history" has no <!-- generated:')
    expect(error).toContain('"configfile init" has more than one block.')
  })

  it('names the block whose closing marker is missing', () => {
    const broken = page.replace(
      /(<!-- generated: configfile modules list -->[\s\S]*?)<!-- \/generated -->/,
      '$1',
    )

    expect(() => renderCommandsPage(broken)).toThrow(
      'The block of "configfile modules list" has no <!-- /generated -->.',
    )
  })

  it('can be run to check the page', () => {
    const script = fileURLToPath(new URL('../tools/docs-commands.ts', import.meta.url))

    const output = execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' })

    expect(output).toContain('is up to date.')
  })
})
