const fs = require('fs')

function fileExist(filename = '') {
  try {
    fs.accessSync(filename)
  } catch (e) {
    return false
  }

  return true
}

module.exports = exports = {
  fileExist
}
