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
}

module.exports = exports = { AlterationLoggerService }
