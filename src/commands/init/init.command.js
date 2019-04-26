import inquirer from 'inquirer'
import fs from 'fs'
import path from 'path'

import { Command } from '../../core/command'
import { FsUtils, GitUtils } from '../../shared/utils'
import { FileNotDirectory, FolderNotEmpty } from '../../shared/errors'

import { InitStopedByUser } from './init-stop-by-user.error'

export class InitCommand extends Command {
  get commandName() {
    return 'init'
  }

  get alias() {
    return 'i'
  }

  get description() {
    return 'activate configfiles on user session.'
  }

  get options() {
    return [
      ['-f, --force', 'force parameters file overwrite.']
    ]
  }

  constructor(configService, loggerService, messageService) {
    super()

    this.configService = configService
    this.loggerService = loggerService
    this.messageService = messageService

    this.log = this.loggerService.registerScope('configfile:cmd:init')
  }

  async run(options) {
    this.log('Init command started')

    try {
      await this._getUserData(options)
    } catch (error) {
      this.log('Error in _getUserData')

      if (error instanceof InitStopedByUser) {
        this.log('Error is an instance of InitStopedByUser')
        this.messageService.printError(error.message)
        return
      }
    }

    try {
      this._checkFileSystem()
    } catch (error) {
      this.log('Error in _checkFileSystem')

      if (error instanceof FolderNotEmpty) {
        this.log('Error is an instance of FolderNotEmpty')
        this.messageService.printError(error.message)
        return
      }

      if (error instanceof FileNotDirectory) {
        this.log('Error is an instance of FileNotDirectory')
        this.messageService.printError(error.message)
        return
      }
    }

    this._cloneGitRepo()
  }

  async _getUserData(commandOptions) {
    this.log('Start asking people informations for installing configuration file')
    const userForceOverwrite = commandOptions.force || false

    const questions = [
      {
        name: 'overwrite_file',
        message: 'A configuration file already exist. Do you want to continue ?',
        type: 'confirm',
        when: () => this.configService.configFileExist() && !userForceOverwrite
      },
      {
        name: 'repo_url',
        message: 'Repository url:',
        type: 'input',
        validate: url => GitUtils.isGitUrl(url),
        default: () => {
          if (this.configService.configFileExist()) {
            return this.configService.repoUrl
          }
        },
        when: data => !this.configService.configFileExist() || data.overwrite_file || userForceOverwrite
      },
      {
        name: 'folder_path',
        message: 'Folder path:',
        type: 'input',
        validate: path => FsUtils.isFilePath(path),
        default: () => {
          if (this.configService.configFileExist()) {
            return this.configService.folderPath
          }
        },
        when: data => !this.configService.configFileExist() || data.overwrite_file || userForceOverwrite
      }
    ]

    const { repo_url: REPO_URL = null, folder_path: FOLDER_PATH, overwrite_file: OVERWRITE_FILE = true } = await inquirer.prompt(questions)

    if (!OVERWRITE_FILE) {
      this.log('User stop the command execution. A file already exist. No override allowed.')
      throw new InitStopedByUser('You stopped the command. Nothing has be made.')
    }

    let folderPath = FOLDER_PATH.replace('~', process.env.HOME)
    folderPath = path.resolve(folderPath)

    this.log('Save validated user answers in config service')
    this.configService.repoUrl = REPO_URL
    this.configService.folderPath = folderPath
  }

  _checkFileSystem() {
    this.log('Check file system - Start')

    const folderPath = this.configService.folderPath
    if (!FsUtils.fileExist(folderPath)) {
      this.log(`Folder ${folderPath} doesn't exist.`)
      this.messageService.printInfo('Folder does not exist. It will be created.')
      fs.mkdirSync(folderPath)
    }

    const isDirectory = fs.statSync(folderPath).isDirectory()
    if (!isDirectory) {
      this.log(`Folder ${folderPath} is not a folder.`)
      throw new FileNotDirectory()
    }

    const folderIsEmpty = fs.readdirSync(folderPath).length < 1
    if (!folderIsEmpty) {
      this.log(`Folder ${folderPath} isn't empty.`)
      throw new FolderNotEmpty()
    }
  }

  async _cloneGitRepo() {
    this.log(`Clone git repo - Start`)
    if (this.configService.repoUrl == null) {
      this.log(`No URL provided to allow to clone the repo`)
      this.messageService.printWarn('Unable to cloned git repository. Need repository URL.')
      return
    }

    try {
      await GitUtils.clone(this.configService.repoUrl, this.configService.folderPath)
      this.messageService.printInfo('Git repository cloned successuly.')
    } catch (error) {
      this.log(error.message)
      throw error
    }
  }
}
