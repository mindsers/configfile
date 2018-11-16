import { Command } from '../../core'
import { ConfigurationFileNotExist, BadScriptPermission, ScriptNotExist } from '../../shared/errors'

export class RunScriptCommand extends Command {
  get commandName() {
    return 'run <name>'
  }

  get alias() {
    return 'r'
  }

  get description() {
    return 'run custom configuration scripts.'
  }

  constructor(execService, fileService, messageService) {
    super()

    this.fileService = fileService
    this.execService = execService
    this.messageService = messageService
  }

  async run(scriptName) {
    this.messageService.printInfo(`Running "${scriptName}" script.`)

    const script = this.fileService.scriptByName(scriptName)

    try {
      await this.execService.runScript(script)

      this.messageService.printSuccess(`"${scriptName}" script execution is finished.`)
    } catch (error) {
      if (error instanceof ConfigurationFileNotExist) {
        this.messageService.printError('No configuration file. You need to run the init command before.')
        return
      }

      if (error instanceof ScriptNotExist) {
        this.messageService.printError(error.message)
        return
      }

      if (error instanceof BadScriptPermission) {
        this.messageService.printError('Fail', error.message)
        return
      }

      throw error
    }
  }
}
