const fs = require('fs')
const inquirer = require('inquirer')
const git = require('gift')

const { fileExist } = require('./fs.utils')
const { log } = require('./log.utils')

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
        console.log(data)
        const { repo_name = null, folder_path, overwrite_file = true } = data

        if (!overwrite_file) {
          return
        }

        if (!fileExist(folder_path)) {
          log('info', 'Folder does not exist. It will be created.', ' Info ')
          fs.mkdirSync(folder_path)
        }

        const folderStat = fs.statSync(folder_path)
        if (!folderStat.isDirectory()) {
          log('error', `${folder_path} is not a folder.`, ' Abort ')
          return
        }
        
        const folderIsEmpty = fs.readdirSync(folder_path).length < 1
        if (!folderIsEmpty) {
          log('error', 'Folder is not empty', ' Abort ')
          return
        }

        if (repo_name == null) {
          return
        }

        git.clone(repo_name, folder_path, (error, result) => {
          console.log(error, result)
        })

        fs.writeFileSync(configFilename, JSON.stringify({ repo_name, folder_path }, null, 4))
      })
  }
}

const URL_REGEX = /^((?:(https?):\/\/)?((?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9]))|(?:(?:(?:\w+\.){1,2}[\w]{2,3})))(?::(\d+))?((?:\/[\w]+)*)(?:\/|(\/[\w]+\.[\w]{3,4})|(\?(?:([\w]+=[\w]+)&)*([\w]+=[\w]+))?|\?(?:(wsdl|wadl))))$/
const PATH_REGEX = /^(?:(?:~|\.{1,2})?\/)+(?:[a-zA-Z\.\-\_]+\/?)*$/
