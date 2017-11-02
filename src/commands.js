const initCommand = require('./commands/init/init.command')
const runCommand = require('./commands/run.command')
const deployCommand = require('./commands/deploy/deploy.command')
const scriptsCommand = require('./commands/scripts.command')
const modulesCommand = require('./commands/modules.command')

module.exports = exports = {
  initCommand,
  runCommand,
  deployCommand,
  scriptsCommand,
  modulesCommand
}
