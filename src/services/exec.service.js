import { FsUtils, ProcessUtils, LogUtils } from '../shared/utils'
import { ScriptNotExist, BadScriptPermission } from '../shared/errors'

export class ExecService {
  async runScript(script) {
    if (script == null) {
      throw new ScriptNotExist(script.script)
    }

    await FsUtils.chmod(script.path, '0700')

    const child = ProcessUtils.execFile(script.path)

    child.stdout.on('data', data => {
      LogUtils.log({ message: data.trim() })
    })
    child.stderr.on('data', data => {
      LogUtils.log({ type: 'error', message: data.trim(), prefix: '' })
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
