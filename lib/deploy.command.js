const path = require('path')
const fs = require('fs')

const { readFile } = require('./fs.utils')

module.exports = exports = configFilename => {
  return (modules, options) => {
    readFile(configFilename)
      .then(data => JSON.parse(data).folder_path)
      .then(folderPath => {
        return modules
          .map(name => ({
            name,
            folder: path.join(folderPath, 'files', name),
            setting: path.join(folderPath, 'files', name, 'settings.json')
          }))
          .map(data => ({
            name: data.name,
            folder: data.folder,
            setting: JSON.parse(fs.readFileSync(data.setting))
          }))
      })
      .then(data => console.log(data))
  }
}
