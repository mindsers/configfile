import inquirer from 'inquirer'

import { Command } from '../../core/command'
import { ConfigurationFileNotExist } from '../../services/config'
import { LogUtils } from '../../shared/utils'
import { DeployStopedByUser } from './deploy-stop-by-user.error'
import { TargetFileAlreadyExist } from '../../services'

export class DeployModuleCommand extends Command {
  get commandName() {
    return 'deploy [modules...]'
  }

  get alias() {
    return 'd'
  }

  get description() {
    return 'deploy configuration files.'
  }

  get options() {
    return [
      ['-l, --local', 'deploy only local files of the module(s) in the current folder']
    ]
  }

  constructor(fileService, deployService) {
    super()

    this.fileService = fileService
    this.deployService = deployService
  }

  run(modules, options) {
    const localDeployment = options.local || false
    let modulesToDeploy = modules

    Promise.resolve()
      .then(_ => {
        if (modules.length <= 0) {
          return inquirer.prompt([{
            type: 'confirm',
            message: 'No modules was passed in parameter. Do you want to deploy all available modules ?',
            name: 'all_module',
            default: false
          }])
            .then(({ all_module: deployAllModule }) => {
              if (!deployAllModule) {
                throw new DeployStopedByUser()
              }

              modulesToDeploy = this.fileService.modules.map(el => el.module)
            })
        }
      })
      .then(_ => LogUtils.log({ type: 'info', message: `Deployment (${modulesToDeploy.join(', ')}) start.` }))
      .then(_ => {
        const files = this.fileService.modules
          .filter(element => modulesToDeploy.includes(element.module))
          .reduce((files, element) => {
            for (const file of element.files) {
              files.push(file)
            }

            return files
          }, [])
          .filter(element => element.global === !localDeployment)

        const failedFiles = []
        const deployPromises = files.map(file => {
          if (file.global) {
            return this.deployService.deployGlobalFile(file)
          }

          return this.deployService.deployLocalFile(file)
            .catch(error => {
              if (error instanceof TargetFileAlreadyExist) {
                failedFiles.push(file)
                return
              }

              throw error
            })
        })

        return Promise.all(deployPromises)
          .then(_ => { // User choices to relaunch deployment
            if (failedFiles.length <= 0) {
              return
            }

            return failedFiles
              .reduce((queue, file) => queue
                .then(_ => inquirer
                  .prompt([{ name: 'overwrite_file', message: `File ${file.target} already exist. Do you want to overwrite it ?`, type: 'confirm', default: false }])
                  .then(({ overwrite_file: overwriteFile }) => {
                    if (overwriteFile) {
                      return this.fileService.deployLocalFile(file, true)
                    }
                  })), Promise.resolve())
          })
      })
      .then(_ => LogUtils.log({ type: 'success', message: `Deployment task is finished.` }))
      .catch(error => {
        if (error instanceof ConfigurationFileNotExist) {
          LogUtils.log({ type: 'error', message: 'No configuration file. You need to run the init command before.' })
          return
        }

        if (error instanceof DeployStopedByUser) {
          LogUtils.log({ message: `${error.message} No modules to deploy.` })
          return
        }

        LogUtils.log({ type: 'error', message: 'An error occured.', prefix: ' Fail ' })
      })
  }
}
