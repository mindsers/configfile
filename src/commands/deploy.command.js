const inquirer = require('inquirer')

const { LogUtils } = require('../shared/utils')

const { ConfigurationFileNotExist } = require('../services/config')
const { TargetFileAlreadyExist } = require('../services/file')

module.exports = exports = fileService => (modules, options) => {
  const localDeployment = options.local || false

  Promise.resolve()
    .then(_ => LogUtils.log({ type: 'info', message: `Deployment (${modules.join(', ')}) start.` }))
    .then(_ => {
      const files = fileService.modules
        .filter(element => modules.includes(element.module))
        .reduce((files, element) => {
          for (const file of element.files) {
            files.push(file)
          }

          return files
        }, [])
        .filter(element => element.global === !localDeployment)

      const failedFiles = []
      const deployPromises = files.map(file => {
        if (file.global) {
          return fileService.deployGlobalFile(file)
        }

        return fileService.deployLocalFile(file)
          .catch(error => {
            if (error instanceof TargetFileAlreadyExist) {
              failedFiles.push(file)
              return
            }

            throw error
          })
      })

      return Promise.all(deployPromises)
        .then(_ => { // User choices to relaunch deployment
          if (failedFiles.length <= 0) {
            return
          }

          return failedFiles
            .reduce((queue, file) => queue
              .then(_ => inquirer
                .prompt([{ name: 'overwrite_file', message: `File ${file.target} already exist. Do you want to overwrite it ?`, type: 'confirm', default: false }])
                .then(({ overwrite_file: overwriteFile }) => {
                  if (overwriteFile) {
                    return fileService.deployLocalFile(file, true)
                  }
                })), Promise.resolve())
        })
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
