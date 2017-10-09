#!/usr/bin/env node

const program = require('commander')
const fs = require('fs')
const path = require('path')

const { initCommand, runCommand, deployCommand } = require('./lib/index')

const optionsFilePath = `${process.env.HOME}/.configfiles`
const packageData = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json')))

program
  .version(packageData.version)
  .description('Config files manager')

program
  .command('init')
  .alias('i')
  .description('activate configfiles on user session.')
  .option('-f, --force', 'force parameters file overwrite.')
  .action(initCommand(optionsFilePath))

program
  .command('run <name>')
  .alias('r')
  .description('run custom configuration scripts.')
  .action(runCommand(optionsFilePath))

program
  .command('deploy [modules...]')
  .alias('d')
  .description('deploy configuration files.')
  .action(deployCommand(optionsFilePath))


program.parse(process.argv)
