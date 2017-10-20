import test from 'ava'

import { FileNotDirectory } from '../../../src/shared/errors'

test('should have Error as parent.', t => {
  const error = new FileNotDirectory()

  t.true(error instanceof Error)
})

test('should take error message as constructor parameter.', t => {
  const error = new FileNotDirectory('"test" does not exist')

  t.is(error.message, '"test" does not exist')
})
