#!/usr/bin/env node

const program = require('commander')

const config = require('../src/configuration')

const { deployCommand, modulesCommand } = require('../src/commands')
const { FileService, DeployService, InjectorService } = require('../src/services')

const injector = InjectorService.getMainInstance()

program
  .version(config.package.version)
  .description('Configuration modules manager.')

program
  .command('list')
  .alias('l')
  .description('list all modules available.')
  .action(modulesCommand(injector.get(FileService)))

program
  .command('deploy [modules...]')
  .alias('d')
  .description('deploy configuration files.')
  .option('-l, --local', 'deploy only local files of the module(s) in the current folder')
  .action(deployCommand(injector.get(FileService), injector.get(DeployService)))

program.parse(process.argv)
