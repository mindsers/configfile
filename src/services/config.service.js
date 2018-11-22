import fs from 'fs'

import { ConfigurationFileNotExist } from '../shared/errors'
import { FsUtils } from '../shared/utils'

export class ConfigService {
  get repoUrl() {
    return this.getValueForKey('repo_url')
  }

  set repoUrl(url) {
    this.setValueForKey('repo_url', url)
  }

  get folderPath() {
    return this.getValueForKey('folder_path')
  }

  set folderPath(path) {
    this.setValueForKey('folder_path', path)
  }

  get scriptExtension() {
    const extentions = this.getValueForKey('script_extensions')

    if (extentions === null) {
      return ['.js', '.sh', '']
    }

    return extentions
  }

  set scriptExtension(extentions) {
    if (Array.isArray(extentions)) {
      this.setValueForKey('script_extensions', extentions)
    }
  }

  constructor(configPath = `${process.env.HOME}/.configfile`) {
    this.configPath = `${configPath}rc`
    this.configFolderPath = `${configPath}`

    if (!FsUtils.fileExist(this.configFolderPath)) {
      fs.mkdirSync(this.configFolderPath)
    }
  }

  getValueForKey(key) {
    const configData = this._getConfiguration()

    if (key in configData) {
      return configData[key]
    }

    return null
  }

  setValueForKey(key, value) {
    let configData = null

    try {
      configData = this._getConfiguration()
    } catch (e) {
      if (!(e instanceof ConfigurationFileNotExist)) {
        throw e
      }

      configData = {}
    }

    configData[key] = value

    fs.writeFileSync(this.configPath, JSON.stringify(configData, null, 4))
  }

  _hasRCFile() {
    return FsUtils.fileExist(this.configPath)
  }

  _getConfiguration() {
    if (!this._hasRCFile()) {
      throw new ConfigurationFileNotExist()
    }

    return JSON.parse(fs.readFileSync(this.configPath))
  }
}
