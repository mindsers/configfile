import fs from 'fs'
import path from 'path'

import { FsUtils } from '../shared/utils'

export class FileService {
  get scripts() {
    if (this._scripts.length < 1) {
      this._scripts = this.getScripts()
    }

    return this._scripts
  }

  get modules() {
    if (this._modules.length < 1) {
      this._modules = this.getModules()
    }

    return this._modules
  }

  constructor(configService, messageService) {
    this.configService = configService
    this.messageService = messageService

    this._modules = []
    this._scripts = []
  }

  scriptByName(scriptName) {
    return this.scripts
      .filter(({ script: name }) => name === scriptName)
      .shift()
  }

  getScripts() {
    const folderContent = fs.readdirSync(path.join(this.configService.folderPath, 'scripts'))
    const authorizedExtensions = this.configService.scriptExtension

    return folderContent
      .map(element => {
        const stats = fs.statSync(path.join(this.configService.folderPath, 'scripts', element))

        if (!stats.isDirectory()) {
          return element
        }

        for (const ext of authorizedExtensions) {
          if (FsUtils.fileExist(path.join(this.configService.folderPath, 'scripts', element, `index${ext}`))) {
            return `${element}/index${ext}`
          }
        }
      })
      .filter(element => {
        const hasAuthorizedExtension = item => authorizedExtensions
          .map(ext => item.includes(ext))
          .filter(el => el === true)
          .length > 0

        return element != null && hasAuthorizedExtension(element)
      })
      .map(element => {
        const [scriptPath] = element.split('.')
        const [scriptName] = scriptPath.split('/')
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

  getModules() {
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
          const data = JSON.parse(file)

          element.files = data
        } catch (e) {
          this.messageService.printWarning(`Unable to load settings file for "${name}" module.`)
          element.files = []
        }

        return element
      })
      .map(element => {
        element.files = element.files
          .map(file => ({
            source: path.resolve(element.path, file['source_path']),
            target: path.resolve(file['target_path'].replace('~', process.env.HOME)),
            global: file.global
          }))

        return element
      })
  }
}
