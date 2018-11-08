#!/usr/bin/env node

// program
//   .version(config.package.version)
//   .description('Configuration modules manager.')

const { FileService, TermApplication, ModulesListCommand, ModulesDeployCommand, DeployService, ConfigService } = require('../src')
const { getOptionsFilePath, getPackageData } = require('../src/shared/utils')

;(() => {
  const cli = TermApplication.createInstance()
  const pkg = getPackageData()

  cli.version = pkg.version

  cli.register(ModulesListCommand, [FileService])
  cli.register(ModulesDeployCommand, [FileService, DeployService])

  cli.provide(FileService, [ConfigService])
  cli.provide(DeployService)
  cli.provide(ConfigService, [{ useValue: getOptionsFilePath() }])

  cli.start()
})()
