import { Command } from '../core/command'
import { ConfigurationFileNotExist } from '../services/config'
import { LogUtils } from '../shared/utils'
import { BadScriptPermission } from '../services/exec/bad-script-permission.error'
import { ScriptNotExist } from '../services/exec/script-not-exist.error'

export class ScriptsRunCommand extends Command {
  get commandName() {
    return 'run <name>'
  }

  get alias() {
    return 'r'
  }

  get description() {
    return 'run custom configuration scripts.'
  }

  constructor(execService, fileService) {
    super()

    this.fileService = fileService
    this.execService = execService
  }

  async run(scriptName) {
    LogUtils.log({ type: 'info', message: `Running "${scriptName}" script.` })

    const script = this.fileService.scriptByName(scriptName)

    try {
      await this.execService.runScript(script)

      LogUtils.log({ type: 'success', message: `"${scriptName}" script execution is finished.` })
    } catch (error) {
      if (error instanceof ConfigurationFileNotExist) {
        LogUtils.log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
        return
      }

      if (error instanceof ScriptNotExist) {
        LogUtils.log({ type: 'error', message: error.message })
        return
      }

      if (error instanceof BadScriptPermission) {
        LogUtils.log({ type: 'error', message: error.message, prefix: ' Fail ' })
        return
      }

      LogUtils.log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
    }
  }
}
