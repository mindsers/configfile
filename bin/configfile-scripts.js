#!/usr/bin/env node

// const config = require('../src/configuration')

// program
//   .version(config.package.version)
//   .description('Custom scripts manager.')

const { FileService, ExecService, TermApplication, ScriptsListCommand, ScriptsRunCommand } = require('../src')

;(() => {
  const cli = TermApplication.createInstance()

  cli.register(ScriptsRunCommand, [ExecService, FileService])
  cli.register(ScriptsListCommand, [FileService])

  cli.provide(FileService)
  cli.provide(ExecService)

  cli.start()
})()
