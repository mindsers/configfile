const fs = require('fs')

const { FsUtils } = require('../shared/utils')

class AlterationService {
  get dataPath() {
    return `${this.configService.configFolderPath}/alterations`
  }

  constructor(configService, eventManager) {
    this.configService = configService
    this.eventManager = eventManager

    if (!FsUtils.fileExist(this.dataPath)) {
      fs.mkdirSync(this.dataPath)
    }

    this._registerEvent()
  }

  alterationFilePath(moduleName) {
    return `${this.dataPath}/${moduleName}.json`
  }

  alterationFile(moduleName) {
    return FsUtils
      .readFile(this.alterationFilePath(moduleName))
      .then(data => JSON.parse(data))
  }

  resetAlterations(moduleName) {
    if (!FsUtils.fileExist(this.alterationFilePath(moduleName))) {
      return
    }

    fs.unlinkSync(this.alterationFilePath(moduleName))
  }

  addAlteration(moduleName, path, type = 'created') {
    if (!['created', 'renamed'].includes(type)) {
      return Promise.reject(new Error('Bad type'))
    }

    return this
      .alterationFile(moduleName)
      .catch(error => {
        if (error.code !== 'ENOENT') {
          throw error
        }

        return FsUtils
          .writeFile(this.alterationFilePath(moduleName), JSON.stringify([]))
          .then(_ => [])
      })
      .then(alterations => {
        if (alterations.filter(alteration => alteration.path === path).length < 1) {
          alterations.push({
            path,
            type
          })
        }

        return FsUtils.writeFile(this.alterationFilePath(moduleName), JSON.stringify(alterations, null, 4))
      })
  }

  _registerEvent() {
    this.eventManager.register('deploy.created', this, '_onCreate')
    this.eventManager.register('deploy.renamed', this, '_onRename')
    this.eventManager.register('deploy.removed', this, '_onRemove')
  }

  _onCreate(path) { console.log(`deploy.created : ${path}`) }
  _onRename(infos) { console.log(`deploy.renamed : ${infos.new}`) }
  _onRemove(infos) { console.log(`deploy.removed : ${infos}`) }
}

module.exports = exports = { AlterationService }
