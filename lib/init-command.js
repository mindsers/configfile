const inquirer = require('inquirer')

module.exports = exports = (configFilename) => {
  return (env, options) => {
    const questions = [
      {
        name: 'file_exist',
        message: 'A configuration file already exist. Do you want to continue ?',
        type: 'confirm',
        when: () => fileExist(configFilename)
      },
      {
        name: 'repo_name',
        message: 'Url config file repo:',
        type: 'input',
        when: (data) => !fileExist(configFilename) || data.file_exist === true
      }
    ]

    inquirer.prompt(questions)
      .then((a) => {
        console.log(a)
      })
  }
}
  
function fileExist(filename) {
  try {
    fs.accessSync(configFilename)
  } catch (e) {
    return false
  }

  return true
}
