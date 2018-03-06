const alteration = require('./alteration.service')
const config = require('./config')
const file = require('./file.service')
const exec = require('./exec')
const deploy = require('./deploy')
const injector = require('./injector.service')
const eventManager = require('./event-manager')

module.exports = exports = {
  ...alteration,
  ...config,
  ...file,
  ...exec,
  ...deploy,
  ...injector,
  ...eventManager
}
