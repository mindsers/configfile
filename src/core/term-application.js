import { AbstractApplication } from 'yabf'
import program from 'commander'

import { Command } from './command'
import { LogUtils } from '../shared/utils'

export class TermApplication extends AbstractApplication {
  buildInstructions() {
    return [
      { provide: TermApplication, dependencies: [] }
    ]
  }

  register(command, deps = []) {
    if (!(command.prototype instanceof Command)) {
      return null
    }

    this.commands = [command, ...(this.commands || [])]
    this.injectorService.provide(command, deps, false)
  }

  start() {
    if (!Array.isArray(this.commands) || this.commands.length < 1) {
      LogUtils.log({ message: `No command found in Term Application` })
      LogUtils.log({ type: 'error', message: `Application failed to initialize` })
      return
    }

    for (const commandClass of this.commands) {
      const controller = this.injectorService.get(commandClass)

      let command = program.command(controller.commandName)

      if (controller.alias != null) {
        command = command.alias(controller.alias)
      }

      if (controller.alias != null && controller.description.length > 0) {
        command = command.description(controller.description)
      }

      if (Array.isArray(controller.options)) {
        for (const [option, optionDesc] of controller.options) {
          command = command.option(option, optionDesc)
        }
      }

      if ('run' in controller && typeof controller.run === 'function') {
        command.action(controller.run.bind(controller))
      }
    }

    program.parse(process.argv)
  }
}
