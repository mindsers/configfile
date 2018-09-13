import test from 'ava'

import { BadScriptPermission } from '../../../src/services/exec/bad-script-permission.error'

test('should have Error as parent.', t => {
  const error = new BadScriptPermission()

  t.true(error instanceof Error)
})

test('should take error message as constructor parameter.', t => {
  const error = new BadScriptPermission(null, '"test" does not exist')

  t.is(error.message, '"test" does not exist')
})

test('should provide scriptName attribute.', t => {
  const error = new BadScriptPermission('testScript')

  t.is(error.scriptName, 'testScript')
})
