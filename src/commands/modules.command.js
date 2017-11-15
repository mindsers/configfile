const { LogUtils } = require('../shared/utils')

const { ConfigurationFileNotExist } = require('../services/config')

module.exports = exports = fileService => () => {
  let modules = []

  try {
    modules = fileService.modules
  } catch (e) {
    if (e instanceof ConfigurationFileNotExist) {
      LogUtils.log({ message: 'Unable to load modules without knowing where are stored the data.' })
      LogUtils.log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
      return
    }
  }

  if (modules.length < 1) {
    LogUtils.log({ type: 'info', message: `No module found.` })
    return
  }

  LogUtils.log({ message: `${modules.length} module(s) found.` })

  for (const { module: name } of modules) {
    LogUtils.log({ message: `- ${name}` })
  }
}
