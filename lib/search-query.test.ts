import { describe, expect, it } from 'vitest'
import { isSearchable } from './search-query'

describe('isSearchable', () => {
  it('counts the term the lookups search, not a leading @ or #', () => {
    expect(isSearchable('ali')).toBe(true)
    expect(isSearchable('  ali  ')).toBe(true)
    expect(isSearchable('@ali')).toBe(true)
    expect(isSearchable('#dash')).toBe(true)
    expect(isSearchable('@ab')).toBe(false)
    expect(isSearchable('#ab')).toBe(false)
    expect(isSearchable('ab')).toBe(false)
  })
})
