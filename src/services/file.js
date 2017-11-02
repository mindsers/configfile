const { FileService } = require('./file/file.service')
const { BadScriptPermission } = require('./file/bad-script-permission.error')
const { ScriptNotExist } = require('./file/script-not-exist.error')
const { TargetFileAlreadyExist } = require('./file/target-file-already-exist.error')

module.exports = exports = {
  FileService,
  BadScriptPermission,
  ScriptNotExist,
  TargetFileAlreadyExist
}
