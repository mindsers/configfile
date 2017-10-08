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
}

module.exports = exports = { FileService }
