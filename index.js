#!/usr/bin/env node

const program = require('commander')

const { initCommand } = require('./lib/index')

const optionsFilePath = `${process.env.HOME}/.configfiles`

program
  .version('1.0.0')
  .description('Config files manager')

program
  .command('init')
  .alias('i')
  .action(initCommand(optionsFilePath))


program.parse(process.argv)
