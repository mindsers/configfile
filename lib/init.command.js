const fs = require('fs')
const inquirer = require('inquirer')

const { fileExist, writeFile } = require('./fs.utils')
const { log } = require('./log.utils')
const { gitClone } = require('./git.utils')

const URL_REGEX = /^((?:(https?):\/\/)?((?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9]))|(?:(?:(?:\w+\.){1,2}[\w]{2,3})))(?::(\d+))?((?:\/[\w]+)*)(?:\/|(\/[\w]+\.[\w]{3,4})|(\?(?:([\w]+=[\w]+)&)*([\w]+=[\w]+))?|\?(?:(wsdl|wadl))))$/
const PATH_REGEX = /^(?:(?:~|\.{1,2})?\/)+(?:[a-zA-Z\.\-\_]+\/?)*$/

module.exports = exports = configFilename => {
  return options => {
    const userForceOverwrite = options.force || false
    const questions = [
      {
        name: 'overwrite_file',
        message: 'A configuration file already exist. Do you want to continue ?',
        type: 'confirm',
        when: () => fileExist(configFilename) && !userForceOverwrite
      },
      {
        name: 'repo_url',
        message: 'Repository url:',
        type: 'input',
        validate: url => URL_REGEX.test(url),
        when: data => !fileExist(configFilename) || data.overwrite_file || userForceOverwrite
      },
      {
        name: 'folder_path',
        message: 'Folder path:',
        type: 'input',
        validate: path => PATH_REGEX.test(path),
        when: data => !fileExist(configFilename) || data.overwrite_file || userForceOverwrite
      }
    ]

    inquirer.prompt(questions)
      .then(({ repo_url = null, folder_path, overwrite_file = true }) => {
        if (!overwrite_file) {
          throw new Error('user_stop_init')
        }

        return writeFile(configFilename, JSON.stringify(data, null, 4))
          .then(() => ({ repoUrl: repo_url, folderPath: folder_path }))
      })
      .then(data => {
        const { folderPath } = data
        if (!fileExist(folderPath)) {
          log({ type: 'info', message: 'Folder does not exist. It will be created.' })
          fs.mkdirSync(folderPath)
        }
        
        const isDirectory = fs.statSync(folderPath).isDirectory()
        if (!isDirectory) {
          throw new Error('folder_is_not_directory')
        }
        
        const folderIsEmpty = fs.readdirSync(folderPath).length < 1
        if (!folderIsEmpty) {
          throw new Error('folder_is_not_empty')
        }
        
        return data
      })
      .then(data => {
        if (data.repoUrl == null) {
          log({ type: 'warn', message: 'Impossible to cloned git repository. Need repository URL.' })
          return data
        }
        
        return gitClone(data.repoUrl, data.folderPath)
          .then(repo => {
            log({ type: 'info', message: 'Git repository cloned successuly.' })
            return data
          })
      })
      .catch(error => {
        switch (error.message) {
          case 'folder_is_not_directory':
            log({ type: 'error', message: `Path doesn't corresponding to a folder.` })
            break
          case 'folder_is_not_empty':
            log({ type: 'error', message: 'Folder is not empty.' })
            break
          case 'user_stop_init':
            log({ message: 'You stopped the command. Nothing has be made.' })
            break
          default:
            log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
        }
      })
  }
}
