#!/usr/bin/env node

const program = require('commander')
const fs = require('fs')
const path = require('path')

const { initCommand, runCommand, deployCommand, scriptsCommand, modulesCommand } = require('./src/commands')

const { ConfigService } = require('./src/services/config')
const { FileService } = require('./src/services/file')

const optionsFilePath = `${process.env.HOME}/.configfile`
const packageData = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json')))

const configService = new ConfigService(optionsFilePath)
const fileService = new FileService(configService)

program
  .version(packageData.version)
  .description('Config files manager')

program
  .command('init')
  .alias('i')
  .description('activate configfiles on user session.')
  .option('-f, --force', 'force parameters file overwrite.')
  .action(initCommand(configService))

program
  .command('scripts')
  .description('list all custom configuration scripts available.')
  .action(scriptsCommand(fileService))

program
  .command('run <name>')
  .alias('r')
  .description('run custom configuration scripts.')
  .action(runCommand(configService, fileService))

program
  .command('modules')
  .description('list all custom configuration scripts available.')
  .action(modulesCommand(fileService))

program
  .command('deploy [modules...]')
  .alias('d')
  .description('deploy configuration files.')
  .action(deployCommand(fileService))


program.parse(process.argv)
