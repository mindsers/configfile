class FolderNotEmpty extends Error {
  constructor(message = 'Folder is not empty.') {
    super(message)
  }
}

module.exports = exports = { FolderNotEmpty }
