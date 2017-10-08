const path = require('path')

const { readFile, chmod } = require('../shared/fs.utils')
const { execFile } = require('../shared/process.utils')
const { log } = require('../shared/log.utils')

const { ConfigurationFileNotExist } = require('../services/config-file-not-exist.error')
const { ScriptNotExist } = require('./script-not-exist.error')
const { BadScriptPermission } = require('./bad-script-permission.error')

module.exports = exports = (configService, fileService) => {
  return (scriptName, options) => {
    Promise.resolve()
      .then(() => {
        const scriptPaths = fileService.scripts
          .filter(({ script: name }) => name === scriptName)
          .map(script => script.path)

        if (scriptPaths.length > 0) {
          return scriptPaths[0]
        }

        throw new ScriptNotExist(scriptName)
      })
      .then(scriptPath => chmod(scriptPath, '0700').then(() => scriptPath))
      .then(scriptPath => {
        log({ type: 'info', message: `Running "${scriptName}" script.` })

        const child = execFile(scriptPath)
        child.stdout.on('data', data => {
          log({ message: data.trim() })
        })
        child.stderr.on('data', data => {
          log({ type: 'error', message: data.trim(), prefix: '' })
        })

        return child.toPromise()
      })
      .then(
        () => log({ type: 'success', message: `"${scriptName}" script execution is finished.` }),
        error => {
          if (error.code === 'EACCES') {
            throw new BadScriptPermission(scriptName)
          }

          throw error
        }
      )
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
      })
  }
}
