const path = require('path')
const fs = require('fs')

const { FsUtils } = require('../shared/fs.utils')
const { log } = require('../shared/log.utils')

const { ConfigurationFileNotExist } = require('../services/config')

module.exports = exports = fileService => (modules, options) => {
  Promise.resolve()
    .then(scriptPath => log({ type: 'info', message: `Deployment (${modules.join(', ')}) start.` }))
    .then(() => fileService.deployModules(modules))
    .then(scriptPath => log({ type: 'success', message: `Deployment task is finished.` }))
    .catch(error => {
      if (error instanceof ConfigurationFileNotExist) {
        log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
        return
      }

      switch (error.message) {
        case 'symlink_already_exist':
          log({ type: 'warn', message: 'Unable to link some files. This files already exist.' })
          break
        default:
          log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
          console.error(error)
      }
    })
}
