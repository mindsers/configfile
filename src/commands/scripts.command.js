const { LogUtils } = require('../shared/utils')

const { ConfigurationFileNotExist } = require('../services/config')

module.exports = exports = fileService => () => {
  let scripts = []

  try {
    scripts = fileService.scripts
  } catch (e) {
    if (e instanceof ConfigurationFileNotExist) {
      LogUtils.log({ message: 'Unable to load scripts without knowing where are stored the data.' })
      LogUtils.log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
      return
    }
  }

  if (scripts.length < 1) {
    LogUtils.log({ type: 'info', message: `No scripts found.` })
    return
  }

  LogUtils.log({ message: `${scripts.length} script(s) found.` })

  for (const { script } of scripts) {
    LogUtils.log({ message: `- ${script}` })
  }
}
