const config = require('./config')
const file = require('./file.service')
const exec = require('./exec')
const deploy = require('./deploy')
const injector = require('./injector.service')

module.exports = exports = {
  ...config,
  ...file,
  ...exec,
  ...deploy,
  ...injector
}
