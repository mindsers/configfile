#!/usr/bin/env node

const program = require('commander')

const config = require('../src/configuration')

const { ConfigService, InjectorService } = require('../src/services')
const { initCommand } = require('../src/commands')

const injector = InjectorService.getMainInstance()

program
  .version(config.package.version)
  .description('Configuration files manager.')

program
  .command('init')
  .alias('i')
  .description('activate configfiles on user session.')
  .option('-f, --force', 'force parameters file overwrite.')
  .action(initCommand(injector.get(ConfigService)))

program
  .command('scripts', 'work with custom scripts available.')
  .alias('s')

program
  .command('modules', 'work with modules available.')
  .alias('m')

program.parse(process.argv)
