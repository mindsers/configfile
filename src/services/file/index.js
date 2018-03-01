const { FileService } = require('./file.service')
const { TargetFileAlreadyExist } = require('./target-file-already-exist.error')

module.exports = exports = {
  FileService,
  TargetFileAlreadyExist
}
