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

  get modules() {
    const folderContent = fs.readdirSync(path.join(this.configService.folderPath, 'files'))

    return folderContent
      .map(element => {
        const moduleSlug = element
          .toLowerCase()
          .replace(/ /g,'-')
          .replace(/[^\w-]+/g,'')

        return {
          module: moduleSlug,
          path: path.join(this.configService.folderPath, 'files', element),
          settingsPath: path.join(this.configService.folderPath, 'files', element, 'settings.json')
        }
      })
      .filter(({ path }) => fs.statSync(path).isDirectory())
      .filter(({ settingsPath: path }) => FsUtils.fileExist(path))
      .map(element => {
        const path = element.settingsPath
        const name = element.module

        try {
          const file = fs.readFileSync(path)
          element.settings = JSON.parse(file)
        } catch(e) {
          log({ type: 'warn', message: `Unable to load settings file for "${name}" module.` })
          element.settings = []
        }

        return element
      })
      .map(element => {
        element.settings = element.settings
          .map(file => ({
            source: path.resolve(element.path, file['filename']),
            target: path.resolve(file['target-path'].replace('~', process.env.HOME)),
            global: file.global
          }))

        return element
      })
  }

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

  deployModule(moduleName, global = true) {
    const files = this.modules
      .filter(element => element.module === moduleName)
      .reduce((files, element) => {
        for (const file of element.settings) {
          files.push(file)
        }

        return files
      }, [])
      .filter(element => element.global === global)

    const dirCreation = files
      .map(file => path.dirname(file.target))
      .filter(dir => !FsUtils.fileExist(dir))
      .map(dir => FsUtils.mkdirp(dir))

    return Promise.all(dirCreation).then(() => {
      const linkCreation = files
        .map(file => {
          return FsUtils.symlink(file.source, file.target)
            .catch(error => {
              if (error.code !== 'EEXIST') {
                throw error
              }

              log({ type: 'warn', message: `Unable to link "${file.source}" => "${file.target}".` })
            })
        })

      return Promise.all(linkCreation)
    })
  }

  deployModules(moduleNames, global = true) {
    const modulesPromises = moduleNames.map(moduleName => this.deployModule(moduleName, global))

    return Promise.all(modulesPromises)
  }
}

module.exports = exports = { FileService }
