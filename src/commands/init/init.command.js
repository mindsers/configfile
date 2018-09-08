const fs = require('fs')
const path = require('path')
const inquirer = require('inquirer')

const { FsUtils, LogUtils, GitUtils } = require('../../shared/utils')
const { FolderNotEmpty, FileNotDirectory } = require('../../shared/errors')

const { InitStopedByUser } = require('./init-stop-by-user.error')

module.exports = exports = configService => options => {
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
      validate: url => GitUtils.isGitUrl(url),
      default: () => {
        if (configService.configFileExist()) {
          return configService.repoUrl
        }
      },
      when: data => !configService.configFileExist() || data.overwrite_file || userForceOverwrite
    },
    {
      name: 'folder_path',
      message: 'Folder path:',
      type: 'input',
      validate: path => FsUtils.isFilePath(path),
      default: () => {
        if (configService.configFileExist()) {
          return configService.folderPath
        }
      },
      when: data => !configService.configFileExist() || data.overwrite_file || userForceOverwrite
    }
  ]

  inquirer.prompt(questions)
    .then(({ repo_url: repoUrl = null, folder_path: folderPath, overwrite_file: overwriteFile = true }) => {
      if (!overwriteFile) {
        throw new InitStopedByUser('You stopped the command. Nothing has be made.')
      }

      folderPath = folderPath.replace('~', process.env.HOME)
      folderPath = path.resolve(folderPath)

      configService.repoUrl = repoUrl
      configService.folderPath = folderPath
    })
    .then(() => {
      const folderPath = configService.folderPath
      if (!FsUtils.fileExist(folderPath)) {
        LogUtils.log({ type: 'info', message: 'Folder does not exist. It will be created.' })
        fs.mkdirSync(folderPath)
      }

      const isDirectory = fs.statSync(folderPath).isDirectory()
      if (!isDirectory) {
        throw new FileNotDirectory()
      }

      const folderIsEmpty = fs.readdirSync(folderPath).length < 1
      if (!folderIsEmpty) {
        throw new FolderNotEmpty()
      }
    })
    .then(() => {
      if (configService.repoUrl == null) {
        LogUtils.log({ type: 'warn', message: 'Unable to cloned git repository. Need repository URL.' })
        return
      }

      return GitUtils.clone(configService.repoUrl, configService.folderPath)
        .then(repo => {
          LogUtils.log({ type: 'info', message: 'Git repository cloned successuly.' })
        })
    })
    .catch(error => {
      if (error instanceof InitStopedByUser) {
        LogUtils.log({ message: error.message })
        return
      }

      if (error instanceof FolderNotEmpty) {
        LogUtils.log({ type: 'error', message: error.message })
        return
      }

      if (error instanceof FileNotDirectory) {
        LogUtils.log({ type: 'error', message: error.message })
        return
      }

      LogUtils.log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
    })
}
