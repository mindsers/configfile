import { describe, expect, it } from 'vitest'

import { plural } from '../src/output.ts'

describe('plural', () => {
  it('adds an s, or uses the plural given', () => {
    expect(plural(1, 'file')).toBe('1 file')
    expect(plural(0, 'file')).toBe('0 files')
    expect(plural(2, 'file')).toBe('2 files')
    expect(plural(1, 'entry', 'entries')).toBe('1 entry')
    expect(plural(2, 'entry', 'entries')).toBe('2 entries')
  })
})
