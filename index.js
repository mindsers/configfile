#!/usr/bin/env node

const program = require('commander')

const { initCommand, runCommand, deployCommand } = require('./src/commands')

const { ConfigService } = require('./src/services/config')
const { FileService } = require('./src/services/file')

const optionsFilePath = `${process.env.HOME}/.configfiles`

const configService = new ConfigService(optionsFilePath)
const fileService = new FileService(configService)

program
  .version('1.0.0')
  .description('Config files manager')

program
  .command('init')
  .alias('i')
  .description('activate configfiles on user session.')
  .option('-f, --force', 'force parameters file overwrite.')
  .action(initCommand(configService))

program
  .command('run <name>')
  .alias('r')
  .description('run custom configuration scripts.')
  .action(runCommand(configService, fileService))

program
  .command('deploy [modules...]')
  .alias('d')
  .description('deploy configuration files.')
  .action(deployCommand(configService))


program.parse(process.argv)
