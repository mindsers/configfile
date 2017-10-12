const initCommand = require('./init/init.command')
const runCommand = require('./run/run.command')
const deployCommand = require('./deploy/deploy.command')
const scriptsCommand = require('./scripts.command')
const modulesCommand = require('./modules.command')

module.exports = exports = {
  initCommand,
  runCommand,
  deployCommand,
  scriptsCommand,
  modulesCommand
}
