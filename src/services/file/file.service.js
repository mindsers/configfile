const fs = require('fs')
const path = require('path')

const { FsUtils, ProcessUtils, LogUtils } = require('../../shared/utils')
const { ScriptNotExist } = require('./script-not-exist.error')
const { BadScriptPermission } = require('./bad-script-permission.error')
const { TargetFileAlreadyExist } = require('./target-file-already-exist.error')

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
          .replace(/ /g, '-')
          .replace(/[^\w-]+/g, '')

        return {
          script: scriptSlug,
          file: element,
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
          .replace(/ /g, '-')
          .replace(/[^\w-]+/g, '')

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
        } catch (e) {
          LogUtils.log({ type: 'warn', message: `Unable to load settings file for "${name}" module.` })
          element.settings = []
        }

        return element
      })
      .map(element => {
        element.settings = element.settings
          .map(file => ({
            source: path.resolve(element.path, file['source_path']),
            target: path.resolve(file['target_path'].replace('~', process.env.HOME)),
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
          LogUtils.log({ message: data.trim() })
        })
        child.stderr.on('data', data => {
          LogUtils.log({ type: 'error', message: data.trim(), prefix: '' })
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

  deployLocalFile({ source, target, global: isGlobalFile }, force = false) {
    const deployPrommise = Promise.resolve()

    if (isGlobalFile) {
      deployPrommise.then(_ => { throw new TypeError('Unable to deploy global file as a local one.') })
    }

    const dirname = path.dirname(target)
    if (!FsUtils.fileExist(dirname)) {
      deployPrommise.then(_ => FsUtils.mkdirp(dirname))
    }

    return deployPrommise
      .then(_ => FsUtils.lstat(target))
      .catch(error => {
        if (error.code !== 'ENOENT') {
          throw error
        }

        return null // No file exist at target. No stats data to provide
      })
      .then(fileStats => {
        if (fileStats != null && force === false) {
          throw new TargetFileAlreadyExist(target)
        }

        return FsUtils.copyFile(source, target)
      })
      .catch(error => {
        if (error.code !== 'EEXIST') {
          throw error
        }

        LogUtils.log({ type: 'warn', message: `Unable to make a local copy ("${source}" => "${target}").` })
      })
  }

  deployGlobalFile({ source, target, global: isGlobalFile }) {
    const deployPrommise = Promise.resolve()

    if (!isGlobalFile) {
      deployPrommise.then(_ => { throw new TypeError('Unable to deploy local file as a global one.') })
    }

    const dirname = path.dirname(target)
    if (!FsUtils.fileExist(dirname)) {
      deployPrommise.then(_ => FsUtils.mkdirp(dirname))
    }

    return deployPrommise
      .then(_ => FsUtils.lstat(target))
      .then(targetStat => {
        if (targetStat.isSymbolicLink()) {
          return FsUtils.readlink(target)
            .then(linkSource => {
              if (linkSource === source) {
                return FsUtils.unlink(target)
              }
            })
        }

        if (targetStat.isFile() || targetStat.isDirectory()) {
          return FsUtils.rename(target, `${target}.old`)
        }
      })
      .catch(error => {
        if (error.code !== 'ENOENT') { // No file exist at file.target
          throw error
        }
      })
      .then(_ => FsUtils.symlink(source, target))
      .catch(error => {
        if (error.code !== 'EEXIST') {
          throw error
        }

        LogUtils.log({ type: 'warn', message: `Unable to link "${source}" => "${target}".` })
      })
  }
}

module.exports = exports = { FileService }
