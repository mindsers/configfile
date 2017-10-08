const { ConfigService } = require('./config/config.service')
const { ConfigurationFileNotExist } = require('./config/config-file-not-exist.error')

module.exports = exports = {
  ConfigService,
  ConfigurationFileNotExist
}
