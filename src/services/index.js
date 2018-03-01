const alteration = require('./ateration-logger')
const config = require('./config')
const file = require('./file')
const exec = require('./exec.service')

module.exports = exports = {
  ...alteration,
  ...config,
  ...file,
  ...exec
}
