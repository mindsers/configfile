import fs from 'fs'

import { ConfigurationFileNotExist } from '../shared/errors'
import { FsUtils } from '../shared/utils'

export class ConfigService {
  get repoUrl() {
    return this.getConfig('repo_url')
  }

  set repoUrl(url) {
    this.setConfig('repo_url', url)
  }

  get folderPath() {
    return this.getConfig('folder_path')
  }

  set folderPath(path) {
    this.setConfig('folder_path', path)
  }

  get scriptExtension() {
    const extentions = this.getConfig('script_extensions')

    if (extentions === null) {
      return ['.js', '.sh', '']
    }

    return extentions
  }

  set scriptExtension(extentions) {
    if (Array.isArray(extentions)) {
      this.setConfig('script_extensions', extentions)
    }
  }

  constructor(configPath = `${process.env.HOME}/.configfile`) {
    this.configPath = `${configPath}rc`
    this.configFolderPath = `${configPath}`

    if (!FsUtils.fileExist(this.configFolderPath)) {
      fs.mkdirSync(this.configFolderPath)
    }
  }

  configFileExist() {
    return FsUtils.fileExist(this.configPath)
  }

  configData() {
    if (!this.configFileExist()) {
      throw new ConfigurationFileNotExist()
    }

    return JSON.parse(fs.readFileSync(this.configPath))
  }

  getConfig(key) {
    const configData = this.configData()

    if (key in configData) {
      return configData[key]
    }

    return null
  }

  setConfig(key, value) {
    let configData = null

    try {
      configData = this.configData()
    } catch (e) {
      if (!(e instanceof ConfigurationFileNotExist)) {
        throw e
      }

      configData = {}
    }

    configData[key] = value

    fs.writeFileSync(this.configPath, JSON.stringify(configData, null, 4))
  }
}
