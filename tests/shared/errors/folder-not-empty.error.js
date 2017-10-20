import test from 'ava'

import { FolderNotEmpty } from '../../../src/shared/errors'

test('should have Error as parent.', t => {
  const error = new FolderNotEmpty()

  t.true(error instanceof Error)
})

test('should take error message as constructor parameter.', t => {
  const error = new FolderNotEmpty('"test" does not exist')

  t.is(error.message, '"test" does not exist')
})
