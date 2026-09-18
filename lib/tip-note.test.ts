import { describe, expect, it } from 'vitest'
import { encodeTipNote, parseTipNote, TIP_MESSAGE_MAX_LENGTH } from './tip-note'

const POST_ID = '9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9'
const REPLY_ID = 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe'

describe('tip note encoding', () => {
  it('encodes a post tip as a versioned note', () => {
    expect(encodeTipNote('post', POST_ID)).toBe(`yappr:tip:v1:post:${POST_ID}`)
  })

  it('encodes a reply tip', () => {
    expect(encodeTipNote('reply', REPLY_ID)).toBe(`yappr:tip:v1:reply:${REPLY_ID}`)
  })

  it('puts the message on its own line', () => {
    expect(encodeTipNote('post', POST_ID, '  nice thread  ')).toBe(`yappr:tip:v1:post:${POST_ID}\nnice thread`)
  })

  it('omits an empty message rather than leaving a dangling newline', () => {
    expect(encodeTipNote('post', POST_ID, '   ')).toBe(`yappr:tip:v1:post:${POST_ID}`)
  })

  it('caps the message so the note stays inside the 2048-char publicNote limit', () => {
    const note = encodeTipNote('post', POST_ID, 'x'.repeat(5000))
    expect(note.length).toBe(`yappr:tip:v1:post:${POST_ID}\n`.length + TIP_MESSAGE_MAX_LENGTH)
    expect(note.length).toBeLessThan(2048)
  })

  it('refuses a target that is not a 32-byte identifier', () => {
    expect(() => encodeTipNote('post', 'not-an-id')).toThrow()
    expect(() => encodeTipNote('post', '')).toThrow()
  })

  it('round-trips through the parser', () => {
    expect(parseTipNote(encodeTipNote('post', POST_ID, 'thanks'))).toEqual({
      kind: 'post',
      targetId: POST_ID,
      message: 'thanks',
    })
  })
})

describe('tip note parsing', () => {
  it('parses a note with no message', () => {
    expect(parseTipNote(`yappr:tip:v1:reply:${REPLY_ID}`)).toEqual({
      kind: 'reply',
      targetId: REPLY_ID,
      message: '',
    })
  })

  it('keeps a multi-line message intact', () => {
    const parsed = parseTipNote(`yappr:tip:v1:post:${POST_ID}\nline one\nline two`)
    expect(parsed?.message).toBe('line one\nline two')
  })

  it.each([
    ['a free-text note', 'thanks for the post!'],
    ['another app’s note', `otherapp:tip:v1:post:${POST_ID}`],
    ['an unknown version', `yappr:tip:v2:post:${POST_ID}`],
    ['an unknown target kind', `yappr:tip:v1:blog:${POST_ID}`],
    ['a target that is not an identifier', 'yappr:tip:v1:post:hello'],
    ['a truncated identifier', `yappr:tip:v1:post:${POST_ID.slice(0, 20)}`],
    ['a header with no separator', 'yappr:tip:v1:post'],
    ['an empty note', ''],
  ])('rejects %s', (_label, note) => {
    expect(parseTipNote(note)).toBeNull()
  })

  it.each([[undefined], [null], [42], [{}]])('rejects the non-string note %s', (note) => {
    expect(parseTipNote(note)).toBeNull()
  })
})
