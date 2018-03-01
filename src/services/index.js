const alteration = require('./ateration-logger')
const config = require('./config')
const file = require('./file')
const exec = require('./exec')
const deploy = require('./deploy')

module.exports = exports = {
  ...alteration,
  ...config,
  ...file,
  ...exec,
  ...deploy
}
