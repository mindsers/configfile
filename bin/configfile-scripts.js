#!/usr/bin/env node

const {
  FileService,
  ExecService,
  TermApplication,
  ScriptsListCommand,
  ScriptsRunCommand,
  ConfigService,
  OPTION_PATH_FILE_TOKEN,
  getOptionsFilePath,
  getPackageData
} = require('../src')

;(() => {
  const cli = TermApplication.createInstance()
  const pkg = getPackageData()

  cli.version = pkg.version
  cli.description = 'Custom scripts manager.'

  cli.register(ScriptsRunCommand, [ExecService, FileService])
  cli.register(ScriptsListCommand, [FileService])

  cli.provide({ identity: OPTION_PATH_FILE_TOKEN, useValue: getOptionsFilePath() })
  cli.provide(FileService, [ConfigService])
  cli.provide(ExecService)
  cli.provide(ConfigService, [OPTION_PATH_FILE_TOKEN])

  cli.start()
})()
