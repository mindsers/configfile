#!/usr/bin/env node

const program = require('commander')
const fs = require('fs')
const path = require('path')

const { runCommand, scriptsCommand } = require('../src/commands')

const { ConfigService } = require('../src/services/config')
const { FileService } = require('../src/services/file')

const optionsFilePath = `${process.env.HOME}/.configfile`
const packageData = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json')))

const configService = new ConfigService(optionsFilePath)
const fileService = new FileService(configService)

program
  .version(packageData.version)
  .description('Custom scripts manager.')

program
  .command('list')
  .alias('l')
  .description('list all custom configuration scripts available.')
  .action(scriptsCommand(fileService))

program
  .command('run <name>')
  .alias('r')
  .description('run custom configuration scripts.')
  .action(runCommand(configService, fileService))

program.parse(process.argv)
