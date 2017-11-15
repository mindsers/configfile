import test from 'ava'

import { ScriptNotExist } from '../../../src/services/file'

test('should have Error as parent.', t => {
  const error = new ScriptNotExist()

  t.true(error instanceof Error)
})

test('should take error message as constructor parameter.', t => {
  const error = new ScriptNotExist(null, '"test" does not exist')

  t.is(error.message, '"test" does not exist')
})

test('should provide scriptName attribute.', t => {
  const error = new ScriptNotExist('testScript')

  t.is(error.scriptName, 'testScript')
})
