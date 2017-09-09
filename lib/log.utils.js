const color = require('chalk')

const loggerOptions = {
  error: {
    loggerFunction: (...x) => console.error(...x),
    prefixColor: x => color.bgRed(color.black(x)),
    messageColor: x => color.red(x)
  },
  info: {
    loggerFunction: (...x) => console.info(...x),
    prefixColor: x => color.bgCyan(color.black(x)),
    messageColor: x => color.cyan(x)
  },
  warn: {
    loggerFunction: (...x) => console.warn(...x),
    prefixColor: x => color.bgYellow(color.black(x)),
    messageColor: x => color.yellow(x)
  },
  log: {
    loggerFunction: (...x) => console.log(...x),
    prefixColor: x => color.bgWhite(color.black(x)),
    messageColor: x => color.white(x)
  }
}

function log({ type = 'log', message, prefix = '' } = {}) {
  if (type in loggerOptions) {
    const args = []
    if(prefix.length > 0) { args.push(loggerOptions[type].prefixColor(prefix)) }
    args.push(loggerOptions[type].messageColor(message))
    loggerOptions[type].loggerFunction(...args)

    return
  }

  console.log(message)
}

module.exports = exports = {
  log
}
