const { LogUtils } = require('../shared/utils')

const { ConfigurationFileNotExist } = require('../services/config')

module.exports = exports = fileService => (modules, options) => {
  const localDeployment = options.local || false

  Promise.resolve()
    .then(_ => LogUtils.log({ type: 'info', message: `Deployment (${modules.join(', ')}) start.` }))
    .then(_ => {
      const files = fileService.modules
        .filter(element => modules.includes(element.module))
        .reduce((files, element) => {
          for (const file of element.settings) {
            files.push(file)
          }

          return files
        }, [])
        .filter(element => element.global === !localDeployment)

      // fileService.deployModules(modules, !localDeployment)
      return Promise.all(files.map(file => {
        if (file.global) {
          return fileService.deployGlobalFile(file)
        }

        return fileService.deployLocalFile(file)
      }))
    })
    .then(_ => LogUtils.log({ type: 'success', message: `Deployment task is finished.` }))
    .catch(error => {
      if (error instanceof ConfigurationFileNotExist) {
        LogUtils.log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
        return
      }

      LogUtils.log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
    })
}
