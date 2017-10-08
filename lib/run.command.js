const path = require('path')

const { readFile, chmod } = require('./shared/fs.utils')
const { execFile } = require('./shared/process.utils')
const { log } = require('./shared/log.utils')

const { ConfigurationFileNotExist } = require('./services/config-file-not-exist.error')

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

        throw new Error('script_not_exist')
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
            throw new Error('script_no_permission')
          }

          throw error
        }
      )
      .catch(error => {
        if (error instanceof ConfigurationFileNotExist) {
          log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
          return
        }

        switch (error.message) {
          case 'script_not_exist':
            log({ type: 'error', message: `Script "${scriptName}" doesn't exist.` })
            break
          case 'script_no_permission':
            log({ type: 'error', message: `Bad permission on "${scriptName}" script.`, prefix: ' Fail ' })
            break
          default:
            log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
        }
      })
  }
}
