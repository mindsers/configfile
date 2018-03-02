#!/usr/bin/env node

const program = require('commander')

const config = require('../src/configuration')

const { runCommand, scriptsCommand } = require('../src/commands')
const { ExecService, FileService, InjectorService } = require('../src/services')

const injector = InjectorService.getMainInstance()

program
  .version(config.package.version)
  .description('Custom scripts manager.')

program
  .command('list')
  .alias('l')
  .description('list all custom configuration scripts available.')
  .action(scriptsCommand(injector.get(FileService)))

program
  .command('run <name>')
  .alias('r')
  .description('run custom configuration scripts.')
  .action(runCommand(injector.get(ExecService), injector.get(FileService)))

program.parse(process.argv)
