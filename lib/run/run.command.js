const path = require('path')

const { log } = require('../shared/log.utils')

const { ConfigurationFileNotExist } = require('../services/config-file-not-exist.error')
const { ScriptNotExist } = require('./script-not-exist.error')
const { BadScriptPermission } = require('./bad-script-permission.error')

module.exports = exports = (configService, fileService) => (scriptName, options) => {
  Promise.resolve()
    .then(scriptPath => log({ type: 'info', message: `Running "${scriptName}" script.` }))
    .then(() => fileService.runScript(scriptName))
    .then(() => log({ type: 'success', message: `"${scriptName}" script execution is finished.` }))
    .catch(error => {
      if (error instanceof ConfigurationFileNotExist) {
        log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
        return
      }

      if (error instanceof ScriptNotExist) {
        log({ type: 'error', message: error.message })
        return
      }

      if (error instanceof BadScriptPermission) {
        log({ type: 'error', message: error.message, prefix: ' Fail ' })
        return
      }

      log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
      console.log(error)
    })
}
