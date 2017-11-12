const fs = require('fs')

const { FsUtils } = require('../../shared/utils')

class AlterationLoggerService {
  get dataPath() {
    return `${this.configService.configFolderPath}/alterations`
  }

  constructor(configService) {
    this.configService = configService

    if (!FsUtils.fileExist(this.dataPath)) {
      fs.mkdirSync(this.dataPath)
    }
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

  addAlteration(moduleName, path, type) {
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
        alterations.push({
          path,
          type
        })

        return FsUtils.writeFile(this.alterationFilePath(moduleName), JSON.stringify(alterations, null, 4))
      })
  }
}

module.exports = exports = { AlterationLoggerService }
