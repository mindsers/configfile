import { confirm, input } from '@inquirer/prompts'

import type { Prompts } from './context.ts'
import { CliError } from './errors.ts'
import { escapeControls } from './output.ts'

/**
 * Questions can quote names from the repository (paths, file names): their
 * control characters are shown as escapes, never sent to the terminal.
 */
export const interactivePrompts: Prompts = {
  interactive: true,
  confirm: options => confirm({ ...options, message: escapeControls(options.message) }),
  input: options => input({ ...options, message: escapeControls(options.message) }),
}

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
