const { FileNotDirectory } = require('./errors/file-not-directory.error')
const { FolderNotEmpty } = require('./errors/folder-not-empty.error')

module.exports = exports = {
  FileNotDirectory,
  FolderNotEmpty
}
