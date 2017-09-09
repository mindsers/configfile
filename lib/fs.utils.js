const fs = require('fs')

function fileExist(filename = '') {
  try {
    fs.accessSync(filename)
  } catch (e) {
    return false
  }

  return true
}

function writeFile(filename, data) {
  return new Promise((resolve, reject) => {
    fs.writeFile(filename, data, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

module.exports = exports = {
  fileExist,
  writeFile
}
