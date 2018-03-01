const { FileService } = require('./file.service')
const { BadScriptPermission } = require('./bad-script-permission.error')
const { ScriptNotExist } = require('./script-not-exist.error')
const { TargetFileAlreadyExist } = require('./target-file-already-exist.error')

module.exports = exports = {
  FileService,
  BadScriptPermission,
  ScriptNotExist,
  TargetFileAlreadyExist
}
