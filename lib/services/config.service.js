const fs = require('fs')

const { ConfigurationFileNotExist } = require('./config-file-not-exist.error')
const { FsUtils } = require('../shared/fs.utils')

class ConfigService {
  get repoUrl() {
    return this.get('repo_url')
  }

  set repoUrl(url) {
    this.set('repo_url', url)
  }

  get folderPath() {
    return this.get('folder_path')
  }

  set folderPath(path) {
    this.set('folder_path', path)
  }

  get scriptExtension() {
    const extentions = this.get('script_extensions')

    if (extentions === null) {
      return ['.js', '.sh', '']
    }

    return extentions
  }

  set scriptExtension(extentions) {
    if (Array.isArray(extentions)) {
      this.set('script_extensions', extentions)
    }
  }

  constructor(configPath = `${process.env.HOME}/.configfile`) {
    this.configPath = configPath
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

  get(key) {
    const configData = this.configData()

    if (key in configData) {
      return configData[key]
    }

    return null
  }

  set(key, value) {
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

module.exports = exports = { ConfigService }
