const fs = require('fs')
const inquirer = require('inquirer')

const { fileExist, writeFile } = require('./fs.utils')
const { log } = require('./log.utils')
const { gitClone } = require('./git.utils')

module.exports = exports = (configFilename) => {
  return (options) => {
    const userForceOverwrite = options.force || false
    const questions = [
      {
        name: 'overwrite_file',
        message: 'A configuration file already exist. Do you want to continue ?',
        type: 'confirm',
        when: () => fileExist(configFilename) && !userForceOverwrite
      },
      {
        name: 'repo_name',
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
      .then(data => {
        const { repo_name = null, folder_path, overwrite_file = true } = data

        if (!overwrite_file) {
          throw new Error('user_stop_init')
        }

        if (!fileExist(folder_path)) {
          log('info', 'Folder does not exist. It will be created.', ' Info ')
          fs.mkdirSync(folder_path)
        }
        
        const folderStat = fs.statSync(folder_path)
        if (!folderStat.isDirectory()) {
          throw new Error('folder_is_not_directory')
        }
        
        const folderIsEmpty = fs.readdirSync(folder_path).length < 1
        if (!folderIsEmpty) {
          throw new Error('folder_is_not_empty')
        }
        
        return { repo_name, folder_path }
      })
      .then(({ repo_name, folder_path }) => {
        if (repo_name == null) {
          log('warn', 'Impossible to cloned git repository. Need repository URL.', ' Warn ')
          return { repo_name, folder_path }
        }
        
        return gitClone(repo_name, folder_path)
          .then((repo) => {
            log('info', 'Git repository cloned successuly.', ' Info ')
            return { repo_name, folder_path }
          })
      })
      .then(data => writeFile(configFilename, JSON.stringify(data, null, 4)))
      .catch((error) => {
        switch (error.message) {
          case 'folder_is_not_directory':
            log('error', `${folder_path} is not a folder.`, ' Abort ')
            break
          case 'folder_is_not_empty':
            log('error', 'Folder is not empty.', ' Abort ')
            break
          case 'user_stop_init':
            log('', 'You stopped the command. Nothing has be made.')
            break
          default:
            log('error', 'An error occured.', ' Fail ')
            console.log(error)
        }
      })
  }
}

const URL_REGEX = /^((?:(https?):\/\/)?((?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9]))|(?:(?:(?:\w+\.){1,2}[\w]{2,3})))(?::(\d+))?((?:\/[\w]+)*)(?:\/|(\/[\w]+\.[\w]{3,4})|(\?(?:([\w]+=[\w]+)&)*([\w]+=[\w]+))?|\?(?:(wsdl|wadl))))$/
const PATH_REGEX = /^(?:(?:~|\.{1,2})?\/)+(?:[a-zA-Z\.\-\_]+\/?)*$/
