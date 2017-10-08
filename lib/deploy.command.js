const path = require('path')
const fs = require('fs')

const { readFile, fileExist, mkdirp, symlink } = require('./shared/fs.utils')
const { log } = require('./shared/log.utils')

module.exports = exports = configFilename => (modules, options) => {
  if (!fileExist(configFilename)) {
    log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
    return
  }

  readFile(configFilename)
    .then(data => JSON.parse(data))
    .then(data => {
      data.files = processModuleData(modules, data.folder_path)

      return data
    })
    .then(data => createDirs(data.files).then(() => data))
    .then(data => createLinks(data.files)
      .then(createdLinks => {
        if (createdLinks.length < data.files.length) {
          throw new Error('symlink_already_exist')
        }
      })
      .then(() => data)
    )
    .then(data => {

      return data
    })
    .then(data => console.log(JSON.stringify(data, null, 2)))
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
        () => successFulLink.push(file.to),
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
