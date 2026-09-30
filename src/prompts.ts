import { confirm, input } from '@inquirer/prompts'

import type { Prompts } from './context.js'
import { CliError } from './errors.js'

export const interactivePrompts: Prompts = { interactive: true, confirm, input }

/**
 * Used when stdin is not a terminal. Commands check `interactive` to offer
 * specific options; this is the fallback so nothing hangs or garbles output.
 */
export const nonInteractivePrompts: Prompts = {
  interactive: false,
  confirm: ({ message }) => Promise.reject(notInteractive(message)),
  input: ({ message }) => Promise.reject(notInteractive(message)),
}

function notInteractive(question: string): CliError {
  return new CliError(
    `Cannot ask "${question}" without an interactive terminal. ` +
      'Pass the answer as arguments or options instead (see --help).',
  )
}
