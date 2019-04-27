#!/usr/bin/env node
const { LoggerService } = require('yabf')
const {
  TermApplication,
  Command,
  InitCommand,
  SettingsService,
  OPTION_PATH_FILE_TOKEN,
  getOptionsFilePath,
  getPackageData,
  MessageService
} = require('../src');

(() => {
  const cli = TermApplication.createInstance()
  const pkg = getPackageData()

  cli.version = pkg.version
  cli.description = 'Configuration files manager.'

  cli.provide({ identity: OPTION_PATH_FILE_TOKEN, useValue: getOptionsFilePath() })

  cli.provide(SettingsService, [OPTION_PATH_FILE_TOKEN])

  cli.register(InitCommand, [SettingsService, LoggerService, MessageService])
  cli.register(class extends Command { // modules namespace
    get commandName() {
      return 'modules'
    }

    get alias() {
      return 'm'
    }

    get description() {
      return 'work with modules available.'
    }
  })

  cli.register(class extends Command { // scripts namespace
    get commandName() {
      return 'scripts'
    }

    get alias() {
      return 's'
    }

    get description() {
      return 'work with custom scripts available.'
    }
  })

  cli.start()
})()
