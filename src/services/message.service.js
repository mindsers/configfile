import color from 'chalk'

export class MessageService {
  constructor() {
    this.stdout = process.stdout
    this.stderr = process.stderr
  }

  printError(...args) {
    const buildText = this._useBuilder(
      t => color.bgRed(color.black(t)),
      t => color.red(t),
      'Abort'
    )

    this.stdout.write(buildText(...args))
  }

  printWarning(...args) {
    const buildText = this._useBuilder(
      t => color.bgYellow(color.black(t)),
      t => color.yellow(t),
      'Warn'
    )

    this.stdout.write(buildText(...args))
  }

  printInfo(...args) {
    const buildText = this._useBuilder(
      t => color.bgCyan(color.black(t)),
      t => color.cyan(t),
      'Info'
    )

    this.stdout.write(buildText(...args))
  }

  printSuccess(...args) {
    const buildText = this._useBuilder(
      t => color.bgGreen(color.black(t)),
      t => color.green(t),
      'Done'
    )

    this.stdout.write(buildText(...args))
  }

  print(...args) {
    const buildText = this._useBuilder(
      t => color.bgWhite(color.black(t)),
      t => color.gray(t)
    )

    this.stdout.write(buildText(...args))
  }

  printEmptyLine() {
    this.print('')
  }

  printRawText(text) {
    this.stdout.write(text)
  }

  printRawError(text) {
    this.stderr.write(text)
  }

  _useBuilder(stylePrefix, styleText, defaultPrefix) {
    return (prefix, ...texts) => {
      let fullText = `${styleText(prefix)}\n`

      if (defaultPrefix != null) {
        fullText = `${stylePrefix(` ${defaultPrefix} `)} ${fullText}`
      }

      if (texts.length > 0) {
        const styledPrefix = stylePrefix(` ${prefix} `)
        fullText = `${styledPrefix} ${styleText(texts.join(' '))}\n`
      }

      return fullText
    }
  }
}
