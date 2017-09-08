const fs = require('fs')
const inquirer = require('inquirer')

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
      })
  }
}
  
function fileExist(filename) {
  try {
    fs.accessSync(filename)
  } catch (e) {
    return false
  }

  return true
}

const URL_REGEX = /^((?:(https?):\/\/)?((?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9]))|(?:(?:(?:\w+\.){1,2}[\w]{2,3})))(?::(\d+))?((?:\/[\w]+)*)(?:\/|(\/[\w]+\.[\w]{3,4})|(\?(?:([\w]+=[\w]+)&)*([\w]+=[\w]+))?|\?(?:(wsdl|wadl))))$/
const PATH_REGEX = /^(?:(?:~|\.{1,2})?\/)+(?:[a-zA-Z\.\-\_]+\/?)*$/
