#!/usr/bin/env node

const {
  FileService,
  TermApplication,
  ListModulesCommand,
  DeployModuleCommand,
  DeployService,
  ConfigService,
  OPTION_PATH_FILE_TOKEN,
  getOptionsFilePath,
  getPackageData
} = require('../src')

;(() => {
  const cli = TermApplication.createInstance()
  const pkg = getPackageData()

  cli.version = pkg.version
  cli.description = 'Configuration modules manager.'

  cli.register(ListModulesCommand, [FileService])
  cli.register(DeployModuleCommand, [FileService, DeployService])

  cli.provide({ identity: OPTION_PATH_FILE_TOKEN, useValue: getOptionsFilePath() })
  cli.provide(FileService, [ConfigService])
  cli.provide(DeployService)
  cli.provide(ConfigService, [OPTION_PATH_FILE_TOKEN])

  cli.start()
})()
