const path = require('path')

const { readFile, fileExist, chmod } = require('./shared/fs.utils')
const { execFile } = require('./shared/process.utils')
const { log } = require('./shared/log.utils')

module.exports = exports = configService => {
  return (scriptName, options) => {
    if (!configService.configFileExist) {
      log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
      return
    }

    Promise.resolve()
      .then(() => {
        const extentions = ['.js', '.sh', '']
        for (const ext of extentions) {
          const scriptPath = path.join(configService.folderPath, 'scripts', scriptName + ext)
          if (fileExist(scriptPath)) {
            return scriptPath
          }
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
