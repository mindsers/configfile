import { Command } from '../core/command'
import { ConfigurationFileNotExist } from '../services/config'
import { LogUtils } from '../shared/utils'

export class ScriptsListCommand extends Command {
  get commandName() {
    return 'list'
  }

  get alias() {
    return 'l'
  }

  get description() {
    return 'list all custom configuration scripts available.'
  }

  constructor(fileService) {
    super()

    this.fileService = fileService
  }

  run() {
    let scripts = []

    try {
      scripts = this.fileService.scripts
    } catch (e) {
      if (e instanceof ConfigurationFileNotExist) {
        LogUtils.log({ message: 'Unable to load scripts without knowing where are stored the data.' })
        LogUtils.log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
        return
      }
    }

    if (scripts.length < 1) {
      LogUtils.log({ type: 'info', message: `No scripts found.` })
      return
    }

    LogUtils.log({ message: `${scripts.length} script(s) found.` })

    for (const { script } of scripts) {
      LogUtils.log({ message: `- ${script}` })
    }
  }
}
