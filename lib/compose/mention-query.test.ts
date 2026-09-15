import { describe, expect, it } from 'vitest'
import { detectActiveMention } from './mention-query'

describe('active mention query', () => {
  it('continues suggestions after a DPNS hyphen', () => {
    const content = 'Hello @ingrid-vinyl'
    expect(detectActiveMention(content, content.length)).toEqual({
      mention: 'ingrid-vinyl', start: 6, end: content.length,
    })
  })

  it('uses the cursor rather than text following it', () => {
    expect(detectActiveMention('@qa-multi-part trailing text', 9)).toEqual({
      mention: 'qa-multi', start: 0, end: 9,
    })
  })

  it('preserves ordinary, empty, and newline mention queries', () => {
    expect(detectActiveMention('@hamzak78', 9)?.mention).toBe('hamzak78')
    expect(detectActiveMention('hello @', 7)?.mention).toBe('')
    expect(detectActiveMention('hello\n@name', 11)?.mention).toBe('name')
  })

  it('does not cross whitespace, punctuation, or an email boundary', () => {
    for (const content of ['foo@bar', '@name ', '@name!', '@first another', '@name.dash']) {
      expect(detectActiveMention(content, content.length)).toBeNull()
    }
  })
})
