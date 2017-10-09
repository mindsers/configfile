const path = require('path')
const fs = require('fs')

const { readFile, fileExist, mkdirp, symlink } = require('../shared/fs.utils')
const { log } = require('../shared/log.utils')

const { ConfigurationFileNotExist } = require('../services/config')

module.exports = exports = fileService => (modules, options) => {
  Promise.resolve()
    .then(() => {
      return fileService.modules
        .filter(element => modules.includes(element.module))
        .reduce((files, element) => {
          for (const file of element.settings) {
            files.push(file)
          }

          return files
        }, [])
        .filter(element => element.global)
    })
    .then(files => createDirs(files))
    .then(files => createLinks(files)
      .then(createdLinks => {
        if (createdLinks.length < files.length) {
          throw new Error('symlink_already_exist')
        }
      })
      .then(() => files)
    )
    .catch(error => {
      if (error instanceof ConfigurationFileNotExist) {
        log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
        return
      }

      switch (error.message) {
        case 'symlink_already_exist':
          log({ type: 'warn', message: 'Unable to link some files. This files already exist.' })
          break
        default:
          log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
          console.error(error)
      }
    })
}

function createDirs(files) {
  const mkdirPromises = files
    .map(file => path.dirname(file.target))
    .filter(dir => !fileExist(dir))
    .map(dir => mkdirp(dir))

  return Promise.all(mkdirPromises).then(() => files)
}

function createLinks(files) {
  const successFulLinks = []
  const linkPromises = files
    .map(file => symlink(file.source, file.target)
      .then(
        () => successFulLinks.push(file.target),
        error => {
          if (error.code !== 'EEXIST') {
            throw error
          }
        }
      )
    )
  return Promise.all(linkPromises).then(() => successFulLinks)
}
