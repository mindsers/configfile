#!/usr/bin/env node

const program = require('commander')

const { initCommand, runCommand, deployCommand } = require('./lib/index')

const optionsFilePath = `${process.env.HOME}/.configfiles`

program
  .version('1.0.0')
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
