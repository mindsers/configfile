import type { History } from './history.ts'
import type { Output } from './output.ts'

export interface Prompts {
  /** `false` when questions cannot be asked (stdin is not a terminal). */
  readonly interactive: boolean
  confirm(options: { message: string; default?: boolean }): Promise<boolean>
  /** `validate` returns `true`, or why the answer is refused: the question is then asked again. */
  input(options: {
    message: string
    default?: string
    required?: boolean
    validate?: (value: string) => true | string
  }): Promise<string>
}

/** Everything a command needs from the outside world, injected for testability. */
export interface Context {
  readonly home: string
  readonly cwd: string
  /** The system configfile runs on, which picks the scripts made for it (see `listScripts`). */
  readonly platform: NodeJS.Platform
  readonly output: Output
  readonly prompts: Prompts
  /** What this run changes, saved to `~/.configfile/history.jsonl` when it ends if it is recorded (see `shouldRecord`). */
  readonly history: History
}
