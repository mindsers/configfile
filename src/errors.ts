/**
 * An expected failure that should be reported to the user as a plain message
 * (no stack trace) and end the process with `exitCode`.
 */
export class CliError extends Error {
  override name = 'CliError'
  /** Always 1–255: an error must never end the process with success. */
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.exitCode = Number.isInteger(exitCode) && exitCode > 0 && exitCode < 256 ? exitCode : 1
  }
}

export class NotInitializedError extends CliError {
  override name = 'NotInitializedError'

  constructor(configPath: string) {
    super(`No configuration found at ${configPath}. Run "configfile init" first.`)
  }
}

/** Thrown by @inquirer/prompts when the user presses Ctrl+C. */
export function isPromptExit(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError'
}
