import { Command } from '../../core'
import { ConfigurationFileNotExist } from '../../shared/errors'

export class ListScriptsCommand extends Command {
  get commandName() {
    return 'list'
  }

  get alias() {
    return 'l'
  }

  get description() {
    return 'list all custom configuration scripts available.'
  }

  constructor(fileService, messageService) {
    super()

    this.fileService = fileService
    this.messageService = messageService
  }

  run() {
    let scripts = []

    try {
      scripts = this.fileService.scripts
    } catch (e) {
      if (e instanceof ConfigurationFileNotExist) {
        this.messageService.print('Unable to load scripts without knowing where are stored the data.')
        this.messageService.printError('No configuration file. You need to run the init command before.')
        return
      }
    }

    if (scripts.length < 1) {
      this.messageService.printInfo('No scripts found.')
      return
    }

    this.messageService.print(`${scripts.length} script(s) found.`)

    for (const { script } of scripts) {
      this.messageService.print(`- ${script}`)
    }
  }
}
