import { FsUtils } from '../shared/utils'

export class AlterationService {
  constructor(configService) {
    this.configService = configService

    this.loadAll()
  }

  createAlteration(moduleName, { type, originPath, recoveryName } = {}) {
    if (type == null || originPath == null) {
      return
    }

    const [alteration, others] = this._findOneAndOthers(originPath, type)

    if (alteration != null) {
      this._alterations = [...others, Object.assign({}, alteration, {
        updateDate: Date.now(),
        modules: [...alteration.modules, moduleName]
      })]

      return
    }

    this._alterations = [...this._alterations, {
      type,
      originPath,
      recoveryName,
      creationDate: Date.now(),
      updateDate: Date.now()
    }]
  }

  async saveAll() {
    const alteratedModules = this._alterations
      .reduce((modules, alteration) => [...modules, ...alteration.modules], [])
      .reduce((modules, moduleName) => {
        if (!modules.includes(moduleName)) {
          return [...modules, moduleName]
        }

        return modules
      }, [])

    for (const moduleName of alteratedModules) {
      const alterations = this._getAlterations(moduleName)

      await FsUtils.writeFile(
        `${this.configService.configFolderPath}/alterations/${moduleName}.json`,
        JSON.stringify(alterations, null, 4)
      )
    }
  }

  async loadAll() {
    const alterationFiles = await FsUtils.readdir(`${this.configService.configFolderPath}/alterations/`)
    let alterations = []

    for (const file of alterationFiles) {
      const moduleName = file.replace('.json', '')
      const alts = await this._getAlterationsFromFS(moduleName)

      for (const alt of alts) {
        const [alteration = alt, others] = this._findOneAndOthers(alt.path, alt.type)

        if (Array.isArray(alteration.modules)) {
          alteration.modules.push(moduleName)
        } else {
          alteration.modules = [moduleName]
        }

        alterations = [...others, alteration]
      }
    }

    this._alterations = alterations
  }

  /**
   * Find an alteration given its path and type
   *
   * @param {string} path the path of the file which has an alteration
   * @param {string} type the kind of alteration
   * @returns the matched alteration at index 0 and the others alterations at index 1
   */
  _findOneAndOthers(path, type) {
    return [
      this._alterations.find(alteration => alteration.path === path && alteration.type === type),
      this._alterations.filter(alteration => alteration.path !== path || alteration.type !== type)
    ]
  }

  _getAlterations(moduleName) {
    if (moduleName == null) {
      return
    }

    return this._alterations.filter(alteration => alteration.modules.includes(moduleName))
  }

  async _getAlterationsFromFS(moduleName) {
    if (moduleName == null) {
      return
    }

    const dataText = await FsUtils.readFile(`${this.configService.configFolderPath}/alterations/${moduleName}.json`)

    if (dataText == null || dataText.length < 1) {
      return []
    }

    return JSON.parse(dataText)
  }
}
