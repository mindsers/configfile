const test = require('ava')

const { Command } = require('./command.js')

test('Default command structure', t => {
  const cmd = new Command()

  t.deepEqual(cmd.alias, null, `command shouldn't have alias by default`)
  t.deepEqual(cmd.commandName, null, `command shouldn't have name by default`)
  t.deepEqual(cmd.description, '', `command description should be a blank line by default`)
  t.deepEqual(cmd.options, [], `command description shouldn't have options by default`)
  t.deepEqual(cmd.run, undefined, `command shouldn't have a run function by default`)
})
