const fs = require('fs')
const util = require('util')
const path = require('path')

class FsUtils {
  static get chmod() {
    return util.promisify(fs.chmod)
  }

  static get readFile() {
    return util.promisify(fs.readFile)
  }

  static get copyFile() {
    return util.promisify(fs.copyFile)
  }

  static get symlink() {
    return util.promisify(fs.symlink)
  }

  static get writeFile() {
    return util.promisify(fs.writeFile)
  }

  static get mkdir() {
    return util.promisify(fs.mkdir)
  }

  static get rename() {
    return util.promisify(fs.rename)
  }

  static get lstat() {
    return util.promisify(fs.lstat)
  }

  static get readlink() {
    return util.promisify(fs.readlink)
  }

  static get unlink() {
    return util.promisify(fs.unlink)
  }

  static fileExist(filename = '', followLink = true) {
    try {
      if (followLink) {
        fs.accessSync(filename)
      } else {
        fs.lstatSync(filename)
      }
    } catch (e) {
      return false
    }

    return true
  }

  static mkdirp(pathname = '') {
    const pathParts = pathname.split('/')

    return pathParts.reduce((promise, part) => promise
      .then(previousPath => {
        const newPath = path.join(previousPath, part)

        if (FsUtils.fileExist(newPath)) {
          return newPath
        }

        return FsUtils.mkdir(newPath)
          .catch(error => {
            if (error.code !== 'EEXIST') {
              throw new Error('dir_create_failed')
            }
          })
          .then(() => newPath)
      }), Promise.resolve(pathname[0] === '/' ? '/' : ''))
  }
}

module.exports = exports = { FsUtils }
