export class LoggerService {
  constructor(logLevel = LOG_LEVEL.INFO) {
    this._logLevel = logLevel
  }

  log(text, level = LOG_LEVEL.ALL) {
    if (this._logLevel > level) {
      return
    }

    const logLine = this._makeLogLine(`${this._getPrefixDate()} - `, text, ` (${getLogLevelName(level)})`)

    for (const line of logLine) {
      this._getOutputStream(level).write(line)
    }
  }

  error(text) {
    return this.log(text, LOG_LEVEL.ERROR)
  }

  warn(text) {
    return this.log(text, LOG_LEVEL.WARN)
  }

  info(text) {
    return this.log(text, LOG_LEVEL.INFO)
  }

  debug(text) {
    return this.log(text, LOG_LEVEL.DEBUG)
  }

  _getPrefixDate() {
    const date = new Date()
    const addPrefix = (num, zero) => `${(new Array(zero).fill(0).join())}${num}`.slice(-1 * zero)

    const year = addPrefix(date.getFullYear(), 4)
    const month = addPrefix(date.getMonth() + 1, 2)
    const day = addPrefix(date.getDate(), 2)
    const hours = addPrefix(date.getHours(), 2)
    const seconds = addPrefix(date.getSeconds(), 2)
    const milliseconds = addPrefix(date.getMilliseconds(), 4)

    const dateText = [year, month, day].join(':')
    const timeText = [hours, seconds].join(':')

    return `${dateText} ${timeText} +${milliseconds}`
  }

  _getOutputStream(level) {
    if (level >= LOG_LEVEL.ERROR) {
      return process.stderr
    }

    return process.stdout
  }

  _makeLogLine(left, center, right) {
    const dataMaxLength = process.stdout.columns - right.length - left.length
    const getLinesFromLine = line => line
      .split('')
      .reduce((lines, char) => {
        let last = lines.pop()
        if (last.length < dataMaxLength) {
          last = last + char
          return [...lines, last]
        }

        return [...lines, last, char]
      }, [''])

    return center
      .split('\n')
      .reduce((aggr, line) => [...aggr, ...getLinesFromLine(line)], [])
      .map(line => `${line}${(new Array(dataMaxLength).fill('\u00A0').join(''))}`.slice(0, dataMaxLength))
      .map((line, index) => {
        if (index === 0) {
          return `${left}${line}${right}`
        }

        return `${(new Array(left.length).fill('\u00A0').join(''))}${line}${(new Array(right.length).fill('\u00A0').join(''))}`
      })
  }
}

export const LOG_LEVEL = Object.freeze({
  ERROR: 4,
  WARN: 3,
  INFO: 2,
  DEBUG: 1,
  ALL: 0
})

function getLogLevelName(level) {
  for (const key of Object.keys(LOG_LEVEL)) {
    if (LOG_LEVEL[key] === level) {
      return key
    }
  }

  return null
}
