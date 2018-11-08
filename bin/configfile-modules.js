#!/usr/bin/env node

// program
//   .version(config.package.version)
//   .description('Configuration modules manager.')

const { FileService, TermApplication, ModulesListCommand, ModulesDeployCommand, DeployService } = require('../src')

;(() => {
  const cli = TermApplication.createInstance()

  cli.register(ModulesListCommand, [FileService])
  cli.register(ModulesDeployCommand, [FileService, DeployService])

  cli.provide(FileService)
  cli.provide(DeployService)

  cli.start()
})()
