const { LogUtils } = require('./shared/log.utils')

module.exports = exports = fileService => () => {
  const scripts = fileService.scripts

  if (scripts.length < 1) {
    LogUtils.log({ type: 'info', message: `No scripts found.` })
    return
  }

  LogUtils.log({ message: `${scripts.length} script(s) found.` })

  for (const [index, { script }] of scripts.entries()) {
    LogUtils.log({ message: `- ${script}` })
  }
}
