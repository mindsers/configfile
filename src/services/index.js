const alteration = require('./ateration-logger')
const config = require('./config')
const file = require('./file')
const exec = require('./exec')

module.exports = exports = {
  ...alteration,
  ...config,
  ...file,
  ...exec
}
