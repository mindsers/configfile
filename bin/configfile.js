#!/usr/bin/env node

const {
  TermApplication,
  Command,
  InitCommand,
  ConfigService,
  OPTION_PATH_FILE_TOKEN,
  getOptionsFilePath,
  getPackageData,
  LoggerService,
  APP_LOG_LEVEL,
  APP_LOG_LEVEL_TOKEN
} = require('../src');

(() => {
  const cli = TermApplication.createInstance()
  const pkg = getPackageData()

  cli.version = pkg.version
  cli.description = 'Configuration files manager.'

  cli.provide({ identity: OPTION_PATH_FILE_TOKEN, useValue: getOptionsFilePath() })
  cli.provide({ identity: APP_LOG_LEVEL_TOKEN, useValue: APP_LOG_LEVEL })

  cli.provide(ConfigService, [OPTION_PATH_FILE_TOKEN])
  cli.provide(LoggerService, [APP_LOG_LEVEL_TOKEN])

  cli.register(InitCommand, [ConfigService, LoggerService])
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
