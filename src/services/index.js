const alteration = require('./alteration-logger.service')
const config = require('./config')
const file = require('./file.service')
const exec = require('./exec')
const deploy = require('./deploy')
const injector = require('./injector.service')

module.exports = exports = {
  ...alteration,
  ...config,
  ...file,
  ...exec,
  ...deploy,
  ...injector
}
