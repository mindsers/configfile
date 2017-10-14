const { FileNotDirectory } = require('./errors/file-not-directory.error')
const { FolderNotEmpty } = require('./errors/folder-not-empty.error')

exports.module = exports = {
  FileNotDirectory,
  FolderNotEmpty
}
