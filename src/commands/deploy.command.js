const { LogUtils } = require('../shared/utils')

const { ConfigurationFileNotExist } = require('../services/config')

module.exports = exports = fileService => (modules, options) => {
  const localDeployment = options.local || false

  Promise.resolve()
    .then(scriptPath => LogUtils.log({ type: 'info', message: `Deployment (${modules.join(', ')}) start.` }))
    .then(() => fileService.deployModules(modules, !localDeployment))
    .then(scriptPath => LogUtils.log({ type: 'success', message: `Deployment task is finished.` }))
    .catch(error => {
      if (error instanceof ConfigurationFileNotExist) {
        LogUtils.log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
        return
      }

      LogUtils.log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
    })
}
