import { describe, expect, it } from 'vitest'
import { characterCount, contentOverage, hasVisibleContent, isOverContentLimit, utf8ByteCount } from './limits'

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

describe('utf8ByteCount', () => {
  it('counts UTF-8 bytes, as the contract maxBytes does', () => {
    expect(utf8ByteCount('hello')).toBe(5)
    expect(utf8ByteCount('é')).toBe(2)
    expect(utf8ByteCount('日本')).toBe(6)
    expect(utf8ByteCount('😀')).toBe(4)
    expect(utf8ByteCount('👨‍👩‍👧‍👦')).toBe(25)
  })
})

describe('contentOverage', () => {
  const v10 = { maxLength: 1000, maxBytes: 2000 }

  it('lets ASCII reach the character limit', () => {
    expect(contentOverage('a'.repeat(1000), 0, v10)).toEqual({ charactersOver: 0, bytesOver: 0 })
    expect(contentOverage('a'.repeat(1001), 0, v10)).toEqual({ charactersOver: 1, bytesOver: 0 })
  })

  it('binds on bytes before characters for four-byte text', () => {
    // 501 emoji: 501 characters, 2004 bytes.
    expect(contentOverage('😀'.repeat(501), 0, v10)).toEqual({ charactersOver: 0, bytesOver: 4 })
    expect(contentOverage('😀'.repeat(500), 0, v10)).toEqual({ charactersOver: 0, bytesOver: 0 })
  })

  it('counts appended ASCII against both limits', () => {
    expect(contentOverage('😀'.repeat(500), 3, v10)).toEqual({ charactersOver: 0, bytesOver: 3 })
    expect(contentOverage('a'.repeat(998), 3, v10)).toEqual({ charactersOver: 1, bytesOver: 0 })
  })

  it('never reports bytes where the contract declares no byte ceiling', () => {
    expect(contentOverage('😀'.repeat(500), 0, { maxLength: 500, maxBytes: null })).toEqual({ charactersOver: 0, bytesOver: 0 })
    expect(contentOverage('😀'.repeat(501), 0, { maxLength: 500, maxBytes: null })).toEqual({ charactersOver: 1, bytesOver: 0 })
  })
})

describe('isOverContentLimit (configured topology: v2)', () => {
  it('uses the v2 500-character limit with no byte ceiling', () => {
    expect(isOverContentLimit('a'.repeat(500))).toBe(false)
    expect(isOverContentLimit('a'.repeat(501))).toBe(true)
    expect(isOverContentLimit('a'.repeat(498), 3)).toBe(true)
    expect(isOverContentLimit('😀'.repeat(500))).toBe(false)
  })
})
