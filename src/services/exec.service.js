import { FsUtils, ProcessUtils } from '../shared/utils'
import { ScriptNotExist, BadScriptPermission } from '../shared/errors'

export class ExecService {
  constructor(messageService) {
    this.messageService = messageService
  }

  async runScript(script) {
    if (script == null) {
      throw new ScriptNotExist(script.script)
    }

    await FsUtils.chmod(script.path, '0700')

    const child = ProcessUtils.execFile(script.path)

    child.stdout.on('data', data => {
      this.messageService.printRawText(data.trim())
    })
    child.stderr.on('data', data => {
      this.messageService.printRawError(data.trim())
    })

    try {
      return await child.toPromise()
    } catch (error) {
      if (error.code === 'EACCES') {
        throw new BadScriptPermission(script.script)
      }

      throw error
    }
  }
}
