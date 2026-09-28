import { describe, expect, it } from 'vitest'
import { characterCount, hasVisibleContent } from './limits'

describe('characterCount', () => {
  it('counts code points, as the contract maxLength does', () => {
    expect(characterCount('hello')).toBe(5)
    expect(characterCount('😀')).toBe(1)
    expect(characterCount('😀'.repeat(251))).toBe(251)
    expect(characterCount('a'.repeat(499) + '😀')).toBe(500)
    // A ZWJ family is several code points, each counted by the chain.
    expect(characterCount('👨‍👩‍👧‍👦')).toBe(7)
  })
})

describe('hasVisibleContent', () => {
  it('rejects whitespace and zero-width-only text', () => {
    expect(hasVisibleContent('')).toBe(false)
    expect(hasVisibleContent('  \n\t ')).toBe(false)
    expect(hasVisibleContent('​​​')).toBe(false)
    expect(hasVisibleContent('﻿')).toBe(false)
    expect(hasVisibleContent(' ‌‍⁠­ ')).toBe(false)
  })

  it('accepts text with a visible character', () => {
    expect(hasVisibleContent('​hi​')).toBe(true)
    expect(hasVisibleContent('😀')).toBe(true)
    expect(hasVisibleContent('.')).toBe(true)
  })
})
