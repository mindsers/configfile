#!/usr/bin/env node
const React = require('react')
const importJsx = require('import-jsx')
const program = require('commander')
const { render } = require('ink')

program
  .version('0.4.0')
  .description('Configuration files manager.')

program
  .command('init <url>')
  .alias('i')
  .description('activate configfiles on user session.')
  .option('-f, --force', 'force parameters file overwrite.')
  .action((url, cmd) => {
    render(
      React.createElement(
        importJsx('../src/commands/init/init.js'),
        { cmd, url }
      )
    )
  })

program
  .command('scripts', 'work with custom scripts available.')
  .alias('s')

program
  .command('modules', 'work with modules available.')
  .alias('m')

program.parse(process.argv)
