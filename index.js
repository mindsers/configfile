#!/usr/bin/env node

const program = require('commander')

program
  .version('1.0.0')
  .description('Config files manager')

program
  .command('init')
  .alias('i')
  .action((env, options) => {
    console.log('x init')
  })

program.parse(process.argv)
