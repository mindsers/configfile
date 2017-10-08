const fs = require('fs')
const path = require('path')

const { FsUtils } = require('../../shared/fs.utils')
const { ProcessUtils } = require('../../shared/process.utils')
const { log } = require('../../shared/log.utils')

const { ScriptNotExist } = require('./script-not-exist.error')
const { BadScriptPermission } = require('./bad-script-permission.error')

class FileService {
  get scripts() {
    const folderContent = fs.readdirSync(path.join(this.configService.folderPath, 'scripts'))
    const authorizedExtensions = this.configService.scriptExtension

    return folderContent
      .filter(element => {
        const foundResults = []
        for (const extension of authorizedExtensions) {
          foundResults.push(element.includes(extension))
        }

        return foundResults.filter(element => element).length > 0
      })
      .map(element => {
        const [scriptName] = element.split('.')
        const scriptSlug = scriptName
          .toLowerCase()
          .replace(/ /g,'-')
          .replace(/[^\w-]+/g,'')

        return {
          script: scriptSlug,
          file : element,
          path: path.join(this.configService.folderPath, 'scripts', element)
        }
      })
  }

  get modules() {}

  constructor(configService) {
    this.configService = configService

    this._scripts = []
    this._modules = []
  }

  runScript(scriptName) {
    const script = this.scripts
      .filter(({ script: name }) => name === scriptName)
      .shift()

    if (script == null) {
      return Promise.reject(new ScriptNotExist(scriptName))
    }

    return FsUtils.chmod(script.path, '0700')
    .then(() => {
      const child = ProcessUtils.execFile(script.path)
      child.stdout.on('data', data => {
        log({ message: data.trim() })
      })
      child.stderr.on('data', data => {
        log({ type: 'error', message: data.trim(), prefix: '' })
      })

      return child.toPromise()
    })
    .catch(error => {
      if (error.code === 'EACCES') {
        throw new BadScriptPermission(scriptName)
      }

      throw error
    })
  }
}

module.exports = exports = { FileService }
