import { Command } from '../core/command'
import { ConfigurationFileNotExist } from '../services/config'
import { LogUtils } from '../shared/utils'

export class ModulesListCommand extends Command {
  get commandName() {
    return 'list'
  }

  get alias() {
    return 'l'
  }

  get description() {
    return 'list all modules available.'
  }

  constructor(fileService) {
    super()

    this.fileService = fileService
  }

  run() {
    let modules = []

    try {
      modules = this.fileService.modules
    } catch (e) {
      if (e instanceof ConfigurationFileNotExist) {
        LogUtils.log({ message: 'Unable to load modules without knowing where are stored the data.' })
        LogUtils.log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
        return
      }
    }

    if (modules.length < 1) {
      LogUtils.log({ type: 'info', message: `No module found.` })
      return
    }

    LogUtils.log({ message: `${modules.length} module(s) found.` })

    for (const { module: name } of modules) {
      LogUtils.log({ message: `- ${name}` })
    }
  }
}
