const { LogUtils } = require('../shared/utils')

const { ConfigurationFileNotExist } = require('../services/config')
const { ScriptNotExist, BadScriptPermission } = require('../services/file')

module.exports = exports = (configService, fileService) => (scriptName, options) => {
  Promise.resolve()
    .then(scriptPath => LogUtils.log({ type: 'info', message: `Running "${scriptName}" script.` }))
    .then(() => fileService.runScript(scriptName))
    .then(() => LogUtils.log({ type: 'success', message: `"${scriptName}" script execution is finished.` }))
    .catch(error => {
      if (error instanceof ConfigurationFileNotExist) {
        LogUtils.log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
        return
      }

      if (error instanceof ScriptNotExist) {
        LogUtils.log({ type: 'error', message: error.message })
        return
      }

      if (error instanceof BadScriptPermission) {
        LogUtils.log({ type: 'error', message: error.message, prefix: ' Fail ' })
        return
      }

      LogUtils.log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
    })
}
