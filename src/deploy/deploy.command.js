const path = require('path')
const fs = require('fs')

const { readFile, fileExist, mkdirp, symlink } = require('../shared/fs.utils')
const { log } = require('../shared/log.utils')

module.exports = exports = configService => (modules, options) => {
  if (!configService.configFileExist()) {
    log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
    return
  }

  Promise.resolve()
    .then(() => processModuleData(modules, configService.folderPath))
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
    .map(file => path.dirname(file.to))
    .filter(dir => !fileExist(dir))
    .map(dir => mkdirp(dir))

  return Promise.all(mkdirPromises).then(() => files)
}

function createLinks(files) {
  const successFulLinks = []
  const linkPromises = files
    .map(file => symlink(file.from, file.to)
      .then(
        () => successFulLinks.push(file.to),
        error => {
          if (error.code !== 'EEXIST') {
            throw error
          }
        }
      )
    )
  return Promise.all(linkPromises).then(() => successFulLinks)
}

function processModuleData(moduleNames, folderPath) {
  return moduleNames
    .map(name => {
      const addr = path.join(folderPath, 'files', name)

      let settings = []
      try {
        const file = fs.readFileSync(path.join(addr, 'settings.json'))
        settings = JSON.parse(file)
      } catch(e) {
        log({ type: 'warn', message: `Not able to load settings file for "${name}" module.` })
      }

      return { name, folder: addr, settings }
    })
    .filter(moduleConf => moduleConf.settings.length > 0)
    .map(moduleConf => {
      return moduleConf.settings
        .filter(file => file.global)
        .map(file => ({
          from: path.resolve(moduleConf.folder, file.filename),
          to: path.resolve(file['target-path'].replace('~', process.env.HOME))
        }))
    })
    .reduce((files, modules) => {
      for (const file of modules) {
        files.push(file)
      }

      return files
    }, [])
}
