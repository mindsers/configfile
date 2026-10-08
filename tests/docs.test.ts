import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { COMMANDS_PAGE, renderCommandsPage } from '../tools/docs-commands.ts'

describe('documentation', () => {
  it('documents every command, with its current usage and options', async () => {
    const page = await readFile(COMMANDS_PAGE, 'utf8')

    // On failure, run "pnpm docs:commands" and commit the page.
    expect(renderCommandsPage(page)).toBe(page)
  })

  it('refuses a page that misses a command or names an unknown one', () => {
    const page = '<!-- generated: configfile nope -->\n<!-- /generated -->\n'

    expect(() => renderCommandsPage(page)).toThrow(/"configfile nope" is not a command/)
    expect(() => renderCommandsPage(page)).toThrow(/"configfile init" has no/)
  })
})
