const fs = require('fs')
const util = require('util')

function fileExist(filename = '') {
  try {
    fs.accessSync(filename)
  } catch (e) {
    return false
  }

  return true
}

module.exports = exports = {
  fileExist,
  writeFile: util.promisify(fs.writeFile),
  readFile: util.promisify(fs.readFile),
  chmod: util.promisify(fs.chmod)
}
