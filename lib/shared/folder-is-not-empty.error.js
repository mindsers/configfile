class FolderIsNotEmpty extends Error {
  constructor(message = 'Folder is not empty.') {
    super(message)
  }
}

module.exports = exports = { FolderIsNotEmpty }
