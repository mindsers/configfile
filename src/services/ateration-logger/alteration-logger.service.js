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

  resetAlterations(moduleName) {
    if (!FsUtils.fileExist(this.alterationFilePath(moduleName))) {
      return
    }

    fs.unlinkSync(this.alterationFilePath(moduleName))
  }

  addAlteration(moduleName, path, type) {
    fs.writeFileSync(this.alterationFilePath(moduleName), JSON.stringify({}, null, 4))
  }
}

module.exports = exports = { AlterationLoggerService }
