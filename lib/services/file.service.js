const fs = require('fs')
const path = require('path')

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
      .map(element => ({
        file: element
      }))
  }

  get modules() {}

  constructor(configService) {
    this.configService = configService

    this._scripts = []
    this._modules = []
  }
}

module.exports = exports = { FileService }
