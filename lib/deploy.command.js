const path = require('path')
const fs = require('fs')

const { readFile } = require('./fs.utils')
const { log } = require('./log.utils')

module.exports = exports = configFilename => {
  return (modules, options) => {
    readFile(configFilename)
      .then(data => JSON.parse(data).folder_path)
      .then(folderPath => {
        return modules
          .map(name => {
            const addr = path.join(folderPath, 'files', name)
            const file = fs.readFileSync(path.join(addr, 'settings.json'))

            let settings = []
            try {
              settings = JSON.parse(file)
            } catch(e) {
              log({ type: 'warn', message: `Not able to load settings file for "${name}" module.` })
            }

            return { name, folder: addr, settings }
          })
          .filter(moduleConf => moduleConf.settings.length > 0)
      })
      .then(data => console.log(JSON.stringify(data)))
  }
}
