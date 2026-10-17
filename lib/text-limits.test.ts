import { describe, expect, it } from 'vitest'
import { acceptsTextChange, fitTextChange, fitsText, limitText, textBytes } from './text-limits'

describe('contract text limits', () => {
  it('counts Unicode code points and UTF-8 independently', () => {
    expect(textBytes('A界😀')).toBe(8)
    expect(limitText('A界😀z', { maxLength: 3, maxBytes: 8 })).toBe('A界😀')
    expect(limitText('A界😀', { maxLength: 10, maxBytes: 7 })).toBe('A界')
  })
  it('never splits a surrogate pair and caps a pasted value', () => {
    expect(limitText('😀😀😀', { maxLength: 10, maxBytes: 9 })).toBe('😀😀')
    expect(fitsText('😀'.repeat(375), { maxLength: 500, maxBytes: 1500 })).toBe(true)
    expect(fitsText('😀'.repeat(376), { maxLength: 500, maxBytes: 1500 })).toBe(false)
  })
  it('rejects formatting or insertion over the cap without dropping the draft tail', () => {
    const current = 'abc😀tail'
    expect(acceptsTextChange(current, '**abc**😀tail', { maxBytes: 12 })).toBe(false)
    expect(acceptsTextChange(current, 'abc😀😀tail', { maxBytes: 12 })).toBe(false)
    expect(acceptsTextChange(current, 'abc😀tailXYZ', { maxBytes: 12 })).toBe(false)
    expect(acceptsTextChange('a'.repeat(20), 'a'.repeat(19), { maxLength: 10 })).toBe(true)
  })
  it('caps inserted text while preserving the existing ending and complete Unicode', () => {
    const fits = (value: string) => fitsText(value, { maxLength: 10, maxBytes: 13 })
    expect(fitTextChange('abcTAIL', 'abc123456TAIL', fits)).toBe('abc123TAIL')
    expect(fitTextChange('abcTAIL', 'abc😀😀TAIL', fits)).toBe('abc😀TAIL')
    expect(fitTextChange('abcdefghij', 'abcXYZdefghij', fits)).toBe('abcdefghij')
    expect(fitTextChange('abcdefghij', 'abc😀ghij', fits)).toBe('abc😀ghij')
    expect(fitTextChange('x'.repeat(20), 'x'.repeat(19), fits)).toBe('x'.repeat(19))
    expect(fitTextChange('x'.repeat(20), 'y' + 'x'.repeat(20), fits)).toBe('x'.repeat(20))
  })
  it('preserves order-note text within the encoded JSON byte budget', () => {
    const fits = (value: string) => textBytes(JSON.stringify({ message: value })) <= 26
    expect(fitTextChange('abcTAIL', 'abc"""""TAIL', fits)).toBe('abc""TAIL')
  })
  it('handles URL caps and schemas without a byte cap', () => {
    expect(limitText('é'.repeat(200), { maxLength: 200, maxBytes: 200 })).toHaveLength(100)
    expect(limitText('界'.repeat(500), { maxLength: 500 })).toHaveLength(500)
    expect(limitText('a', { maxBytes: 0 })).toBe('')
  })
})
