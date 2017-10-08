const fs = require('fs')
const path = require('path')
const inquirer = require('inquirer')

const { FsUtils } = require('../shared/fs.utils')
const { log } = require('../shared/log.utils')
const { gitClone } = require('../shared/git.utils')

const { InitStopedByUser } = require('./init-stop-by-user.error')
const { FolderIsNotEmpty } = require('../shared/folder-is-not-empty.error')

const URL_REGEX = /^((?:(https?):\/\/)?((?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9])\.)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[0-9][0-9]|[0-9]))|(?:(?:(?:\w+\.){1,2}[\w]{2,3})))(?::(\d+))?((?:\/[\w]+)*)(?:\/|(\/[\w]+\.[\w]{3,4})|(\?(?:([\w]+=[\w]+)&)*([\w]+=[\w]+))?|\?(?:(wsdl|wadl))))$/
const PATH_REGEX = /^(?:(?:~|\.{1,2})?\/)+(?:[a-zA-Z\.\-\_]+\/?)*$/

module.exports = exports = configService => {
  return options => {
    const userForceOverwrite = options.force || false
    const questions = [
      {
        name: 'overwrite_file',
        message: 'A configuration file already exist. Do you want to continue ?',
        type: 'confirm',
        when: () => configService.configFileExist() && !userForceOverwrite
      },
      {
        name: 'repo_url',
        message: 'Repository url:',
        type: 'input',
        validate: url => URL_REGEX.test(url),
        when: data => !configService.configFileExist() || data.overwrite_file || userForceOverwrite
      },
      {
        name: 'folder_path',
        message: 'Folder path:',
        type: 'input',
        validate: path => PATH_REGEX.test(path),
        when: data => !configService.configFileExist() || data.overwrite_file || userForceOverwrite
      }
    ]

    inquirer.prompt(questions)
      .then(({ repo_url = null, folder_path, overwrite_file = true }) => {
        if (!overwrite_file) {
          throw new InitStopedByUser('You stopped the command. Nothing has be made.')
        }

        folder_path = folder_path.replace('~', process.env.HOME)
        folder_path = path.resolve(folder_path)

        configService.repoUrl = repo_url
        configService.folderPath = folder_path
      })
      .then(() => {
        const folderPath  = configService.folderPath
        if (!FsUtils.fileExist(folderPath)) {
          log({ type: 'info', message: 'Folder does not exist. It will be created.' })
          fs.mkdirSync(folderPath)
        }

        const isDirectory = fs.statSync(folderPath).isDirectory()
        if (!isDirectory) {
          throw new Error('folder_is_not_directory')
        }

        const folderIsEmpty = fs.readdirSync(folderPath).length < 1
        if (!folderIsEmpty) {
          throw new FolderIsNotEmpty()
        }
      })
      .then(() => {
        if (configService.repoUrl == null) {
          log({ type: 'warn', message: 'Impossible to cloned git repository. Need repository URL.' })
          return
        }

        return gitClone(configService.repoUrl, configService.folderPath)
          .then(repo => {
            log({ type: 'info', message: 'Git repository cloned successuly.' })
            return
          })
      })
      .catch(error => {
        if (error instanceof InitStopedByUser) {
          log({ message: error.message })
          return
        }

        if (error instanceof FolderIsNotEmpty) {
          log({ type: 'error', message: error.message })
          return
        }

        switch (error.message) {
          case 'folder_is_not_directory':
            log({ type: 'error', message: `Path doesn't corresponding to a folder.` })
            break
          default:
            log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
        }
      })
  }
}
