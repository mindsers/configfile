import fs from 'fs'
import path from 'path'

import { FsUtils, LogUtils } from '../shared/utils'

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

  constructor(configService) {
    this.configService = configService

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
          LogUtils.log({ type: 'warn', message: `Unable to load settings file for "${name}" module.` })
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
