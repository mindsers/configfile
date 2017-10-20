import test from 'ava'

import { ConfigurationFileNotExist } from '../../../src/services/config'

test('should have Error as parent.', t => {
  const error = new ConfigurationFileNotExist()

  t.true(error instanceof Error)
})

test('should take error message as constructor parameter.', t => {
  const error = new ConfigurationFileNotExist('"test" does not exist')

  t.is(error.message, '"test" does not exist')
})
