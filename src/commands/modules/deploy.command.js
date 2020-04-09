import inquirer from 'inquirer'

import { Command } from '../../core'
import { ConfigurationFileNotExist, TargetFileAlreadyExist } from '../../shared/errors'

import { DeployStopedByUser } from './deploy-stop-by-user.error'

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

  constructor(fileService, deployService, messageService) {
    super()

    this.fileService = fileService
    this.deployService = deployService
    this.messageService = messageService
  }

  async run(modules, options) {
    const localDeployment = options.local || false
    let modulesToDeploy = modules

    try {
      modulesToDeploy = await this._getModuleListToDeploy(modules)
    } catch (error) {
      if (error instanceof ConfigurationFileNotExist) {
        this.messageService.printError('No configuration file. You need to run the init command before.')
        return
      }

      if (error instanceof DeployStopedByUser) {
        this.messageService.print(`${error.message} No modules to deploy.`)
        return
      }
    }

    this.messageService.printInfo(`Deployment (${modulesToDeploy.join(', ')}) start.`)
    await this._deployModules(modulesToDeploy, localDeployment)
    this.messageService.printSuccess(`Deployment task is finished.`)
  }

  async _deployModules(modulesToDeploy, localDeployment) {
    for (const mod of this.fileService.modules) {
      if (!modulesToDeploy.includes(mod.module)) {
        continue
      }

      for (const file of mod.files) {
        if (file.global !== !localDeployment) {
          continue
        }

        try {
          if (file.global) {
            await this.deployService.deployGlobalFile(file, mod.module)
            continue
          }

          await this.deployService.deployLocalFile(file)
        } catch (error) {
          if (error instanceof TargetFileAlreadyExist) {
            const { overwrite_file: overwriteFile } = await inquirer.prompt([{
              name: 'overwrite_file',
              message: `File ${file.target} already exist. Do you want to overwrite it ?`,
              type: 'confirm',
              default: false
            }])

            if (overwriteFile) {
              await this.fileService.deployLocalFile(file, true)
            }
            return
          }

          throw error
        }
      }
    }
  }

  async _getModuleListToDeploy(modules = []) {
    if (modules.length <= 0) {
      const { all_module: deployAllModule } = await inquirer.prompt([{
        type: 'confirm',
        message: 'No modules was passed in parameter. Do you want to deploy all available modules ?',
        name: 'all_module',
        default: false
      }])

      if (!deployAllModule) {
        throw new DeployStopedByUser()
      }

      return this.fileService.modules.map(el => el.module)
    }

    return modules
  }
}
