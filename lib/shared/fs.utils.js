const fs = require('fs')
const util = require('util')
const path = require('path')

const { log } = require('./log.utils')

function fileExist(filename = '') {
  try {
    fs.accessSync(filename)
  } catch (e) {
    return false
  }

  return true
}

function mkdirp(pathname = '') {
  const pathParts = pathname.split('/')
  const mkdir = util.promisify(fs.mkdir)

  return pathParts.reduce((promise, part) => {
    return promise
      .then((previousPath) => {
        const newPath = path.join(previousPath, part)

        if (fileExist(newPath)) {
          return newPath
        }

        return mkdir(newPath)
          .catch(error => {
            if (error.code !== 'EEXIST') {
              throw new Error('dir_create_failed')
            }
          })
          .then(() => newPath)
      })
  }, Promise.resolve(pathname[0] === '/' ? '/' : ''))
}

class FsUtils {
  static get chmod() {
    return util.promisify(fs.chmod)
  }

  static fileExist(filename = '') {
    try {
      fs.accessSync(filename)
    } catch (e) {
      return false
    }

    return true
  }
}

module.exports = exports = {
  fileExist,
  writeFile: util.promisify(fs.writeFile),
  readFile: util.promisify(fs.readFile),
  mkdir: util.promisify(fs.mkdir),
  symlink: util.promisify(fs.symlink),
  mkdirp,
  FsUtils
}
