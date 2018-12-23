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

    this._verifyStructure()
    this._loadAlterations()
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

  addAlteration(moduleName, { type, originPath, recoveryName } = {}) {
    if (type == null || originPath == null) {
      return
    }

    const alterations = this._getAlterations(module)
    const data = { type, originPath, recoveryName, date: Date.now() }

    alterations.push(data)

    fs.writeFileSync(
      `${this.configFolderPath}/alterations/${moduleName}.json`,
      JSON.stringify(alterations, null, 4)
    )
  }

  _verifyStructure() {
    const folders = [
      this.configFolderPath,
      `${this.configFolderPath}/logs`,
      `${this.configFolderPath}/recovery`,
      `${this.configFolderPath}/alterations`
    ]

    for (const path of folders) {
      if (!FsUtils.fileExist(path)) {
        fs.mkdirSync(path)
      }
    }
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

  _getAlterations(moduleName) {
    if (moduleName == null) {
      return
    }

    return this.alterations.filter(alteration => alteration.modules.includes(moduleName))
  }

  _getAlterationsFromFS(moduleName) {
    if (!this._hasRCFile()) {
      throw new ConfigurationFileNotExist()
    }

    if (moduleName == null) {
      return
    }

    const dataText = fs.readFileSync(`${this.configFolderPath}/alterations/${moduleName}.json`)

    if (dataText == null || dataText.length < 1) {
      return []
    }

    return JSON.parse(dataText)
  }

  async _loadAlterations() {
    if (!this._hasRCFile()) {
      throw new ConfigurationFileNotExist()
    }

    const alterationFiles = await FsUtils.readdir(`${this.configFolderPath}/alterations/`)
    let alterations = []

    for (const file of alterationFiles) {
      const moduleName = file.replace('.json', '')
      const alts = this._getAlterationsFromFS(moduleName)

      for (const alt of alts) {
        const alteration = alterations.find(item => item.path === alt.path && item.type === alt.type) || alt
        const others = alterations.filter(item => item.path !== alt.path || item.type !== alt.type)

        if (!Array.isArray(alteration.modules)) {
          alteration.modules = [moduleName]
        } else {
          alteration.modules.push(moduleName)
        }

        alterations = [...others, alteration]
      }
    }

    this.alterations = alterations
  }
}
