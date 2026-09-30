import { styleText } from 'node:util'

type Style = Parameters<typeof styleText>[0]

/**
 * User-facing messages. Informational output goes to stdout, warnings and
 * errors to stderr. Colors follow Node's detection for each stream: TTY,
 * NO_COLOR, NODE_DISABLE_COLORS and FORCE_COLOR.
 */
export class Output {
  constructor(
    readonly stdout: NodeJS.WritableStream,
    readonly stderr: NodeJS.WritableStream,
  ) {}

  /** Same messages, all on stderr: for commands whose stdout belongs to someone else. */
  toStderr(): Output {
    return new Output(this.stderr, this.stderr)
  }

  print(message: string): void {
    this.stdout.write(`${message}\n`)
  }

  info(message: string): void {
    this.#write(this.stdout, 'Info', ['bgCyan', 'black'], 'cyan', message)
  }

  success(message: string): void {
    this.#write(this.stdout, 'Done', ['bgGreen', 'black'], 'green', message)
  }

  warn(message: string): void {
    this.#write(this.stderr, 'Warn', ['bgYellow', 'black'], 'yellow', message)
  }

  error(message: string): void {
    this.#write(this.stderr, 'Error', ['bgRed', 'black'], 'red', message)
  }

  #write(
    stream: NodeJS.WritableStream,
    label: string,
    labelStyle: Style,
    textStyle: Style,
    message: string,
  ): void {
    const style = (format: Style, text: string) =>
      styleText(format, text, { stream: stream as NodeJS.WriteStream })

    stream.write(`${style(labelStyle, ` ${label} `)} ${style(textStyle, message)}\n`)
  }
}

/** `plural(1, 'file')` → "1 file", `plural(2, 'file')` → "2 files". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
