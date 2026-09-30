import type { Output } from './output.js'

export interface Prompts {
  /** `false` when questions cannot be asked (stdin is not a terminal). */
  readonly interactive: boolean
  confirm(options: { message: string; default?: boolean }): Promise<boolean>
  input(options: { message: string; default?: string; required?: boolean }): Promise<string>
}

/** Everything a command needs from the outside world, injected for testability. */
export interface Context {
  readonly home: string
  readonly cwd: string
  readonly output: Output
  readonly prompts: Prompts
}
