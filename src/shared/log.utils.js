const color = require('chalk')

class LogUtils {
  static get loggerOptions() {
    return {
      error: {
        loggerFunction: (...x) => console.error(...x),
        prefixDefault: ' Abort ',
        prefixColor: x => color.bgRed(color.black(x)),
        messageColor: x => color.red(x)
      },
      info: {
        loggerFunction: (...x) => console.info(...x),
        prefixDefault: ' Info ',
        prefixColor: x => color.bgCyan(color.black(x)),
        messageColor: x => color.cyan(x)
      },
      warn: {
        loggerFunction: (...x) => console.warn(...x),
        prefixDefault: ' Warn ',
        prefixColor: x => color.bgYellow(color.black(x)),
        messageColor: x => color.yellow(x)
      },
      log: {
        loggerFunction: (...x) => console.log(...x),
        prefixDefault: '',
        prefixColor: x => color.bgWhite(color.black(x)),
        messageColor: x => color.gray(x)
      },
      success:{
        loggerFunction: (...x) => console.info(...x),
        prefixDefault: ' Done ',
        prefixColor: x => color.bgGreen(color.black(x)),
        messageColor: x => color.green(x)
      }
    }
  }

  static log({ type = 'log', message, prefix } = {}) {
    if (type in LogUtils.loggerOptions) {
      const args = []

      if (prefix == null) {
        prefix = LogUtils.loggerOptions[type].prefixDefault
      }

      if (prefix.length > 0) {
        args.push(LogUtils.loggerOptions[type].prefixColor(prefix))
      }
      args.push(LogUtils.loggerOptions[type].messageColor(message))

      LogUtils.loggerOptions[type].loggerFunction(...args)

      return
    }

    console.log(message)
  }

  static addBlanckLine() {
    console.log('')
  }
}

module.exports = exports = {
  LogUtils
}
