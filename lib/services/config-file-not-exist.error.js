class ConfigurationFileNotExist extends Error {
  constructor(message = 'No configuration file found. You need to run the init command ot create it.') {
    super(message)
  }
}

module.exports = exports = { ConfigurationFileNotExist }
