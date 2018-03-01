const { LogUtils } = require('../shared/utils')

const { ConfigurationFileNotExist } = require('../services/config')
const { ScriptNotExist, BadScriptPermission } = require('../services/file')

module.exports = exports = (execService, fileService) => async (scriptName, options) => {
  LogUtils.log({ type: 'info', message: `Running "${scriptName}" script.` })

  const script = fileService.scriptByName(scriptName)

  try {
    await execService.runScript(script)

    LogUtils.log({ type: 'success', message: `"${scriptName}" script execution is finished.` })
  } catch (error) {
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
  }
}
