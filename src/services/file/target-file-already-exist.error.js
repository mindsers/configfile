class TargetFileAlreadyExist extends Error {
  constructor(filename, message = `Target file "${filename}" already exist.`) {
    super(message)

    this.filename = filename
  }
}

module.exports = exports = { TargetFileAlreadyExist }
