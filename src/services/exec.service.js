import { FsUtils, ProcessUtils } from '../shared/utils'
import { ScriptNotExist, BadScriptPermission } from '../shared/errors'

export class ExecService {
  async runScript(script) {
    if (script == null) {
      throw new ScriptNotExist(script.script)
    }

    await FsUtils.chmod(script.path, '0700')

    try {
      return await ProcessUtils.spawn(script.path)
    } catch (error) {
      if (error.code === 'EACCES') {
        throw new BadScriptPermission(script.script)
      }

      throw error
    }
  }
}
