#!/usr/bin/env node

// const config = require('../src/configuration')

// program
//   .version(config.package.version)
//   .description('Custom scripts manager.')

const { FileService, ExecService, TermApplication, ScriptsListCommand, ScriptsRunCommand, ConfigService } = require('../src')
const { getOptionsFilePath, getPackageData } = require('../src/shared/utils')

;(() => {
  const cli = TermApplication.createInstance()
  const pkg = getPackageData()

  cli.version = pkg.version

  cli.register(ScriptsRunCommand, [ExecService, FileService])
  cli.register(ScriptsListCommand, [FileService])

  cli.provide(FileService, [ConfigService])
  cli.provide(ExecService)
  cli.provide(ConfigService, [{ useValue: getOptionsFilePath() }])

  cli.start()
})()
