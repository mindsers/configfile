#!/usr/bin/env node

const program = require('commander')
const fs = require('fs')
const path = require('path')

const { ConfigService } = require('../src/services')

const { initCommand } = require('../src/commands')

const packageData = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json')))
const optionsFilePath = packageData.config.optionsFilePath.replace('~', process.env.HOME)

const configService = new ConfigService(optionsFilePath)

program
  .version(packageData.version)
  .description('Configuration files manager.')

program
  .command('init')
  .alias('i')
  .description('activate configfiles on user session.')
  .option('-f, --force', 'force parameters file overwrite.')
  .action(initCommand(configService))

program
  .command('scripts', 'work with custom scripts available.')
  .alias('s')

program
  .command('modules', 'work with modules available.')
  .alias('m')

program.parse(process.argv)
