import { Command } from '../../core/command'
import { ConfigurationFileNotExist } from '../../shared/errors'

export class ListModulesCommand extends Command {
  get commandName() {
    return 'list'
  }

  get alias() {
    return 'l'
  }

  get description() {
    return 'list all modules available.'
  }

  constructor(fileService, messageService) {
    super()

    this.fileService = fileService
    this.messageService = messageService
  }

  run() {
    let modules = []

    try {
      modules = this.fileService.modules
    } catch (e) {
      if (e instanceof ConfigurationFileNotExist) {
        this.messageService.print('Unable to load modules without knowing where are stored the data.')
        this.messageService.printError('No configuration file. You need to run the init command before.')
        return
      }
    }

    if (modules.length < 1) {
      this.messageService.printInfo('No module found.')
      return
    }

    this.messageService.print(`${modules.length} module(s) found.`)

    for (const { module: name } of modules) {
      this.messageService.print(`- ${name}`)
    }
  }
}
