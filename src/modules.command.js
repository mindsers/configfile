const { LogUtils } = require('./shared/log.utils')

module.exports = exports = fileService => () => {
  const modules = fileService.modules

  if (modules.length < 1) {
    LogUtils.log({ type: 'info', message: `No module found.` })
    return
  }

  LogUtils.log({ message: `${modules.length} module(s) found.` })

  for (const { module: name } of modules) {
    LogUtils.log({ message: `- ${name}` })
  }
}
