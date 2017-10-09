class FileNotDirectory extends Error {
  constructor(message = `Path doesn't corresponding to a folder.`) {
    super(message)
  }
}

module.exports = exports = { FileNotDirectory }
