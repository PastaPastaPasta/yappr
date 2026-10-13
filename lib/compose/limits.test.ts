import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('mentionLimitHint', () => {
  const people = (n: number) => Array.from({ length: n }, (_, i) => `@person${i}`).join(' ')
  async function hintOn(topology: string, text: string) {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
    return (await import('./limits')).mentionLimitHint(text)
  }
  afterEach(() => vi.unstubAllEnvs())

  it('says so once a v15 post mentions more than 8 distinct people', async () => {
    expect(await hintOn('v15', people(8))).toBeNull()
    expect(await hintOn('v15', `${people(8)} @person0 @Person1.dash`)).toBeNull()
    expect(await hintOn('v15', people(9))).toBe('Only the first 8 people you mention will be notified.')
  })

  it('hints an encrypted first post from its public teaser only, never from the body', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v15')
    const { firstPostMentionHints } = await import('./limits')
    const hint = 'Only the first 8 people you mention will be notified.'
    expect(firstPostMentionHints({ body: people(9), encrypted: false })).toEqual({ body: hint, teaser: null })
    // Private, or a reply inheriting encryption: the body is ciphertext and indexes nothing.
    expect(firstPostMentionHints({ body: people(9), encrypted: true })).toEqual({ body: null, teaser: null })
    expect(firstPostMentionHints({ body: people(9), encrypted: true, teaser: 'hi @a' })).toEqual({ body: null, teaser: null })
    expect(firstPostMentionHints({ body: 'secret', encrypted: true, teaser: people(9) })).toEqual({ body: null, teaser: hint })
  })

  it('says nothing elsewhere, as before', async () => {
    for (const topology of ['v2', 'v9', 'v10', 'v14']) expect(await hintOn(topology, people(9)), topology).toBeNull()
  })
})

describe('tagLimitProblem', () => {
  const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(' ')
  async function limitsOn(topology: string) {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
    return import('./limits')
  }
  afterEach(() => vi.unstubAllEnvs())

  it('refuses a v16 post naming more than 4 distinct tags, cashtags included', async () => {
    const { tagLimitProblem } = await limitsOn('v16')
    expect(tagLimitProblem(tags(4))).toBeNull()
    expect(tagLimitProblem(`${tags(4)} #TAG0 #tag1`)).toBeNull()
    expect(tagLimitProblem(tags(5))).toBe('A post can have at most 4 tags. Remove 1 tag.')
    expect(tagLimitProblem(`${tags(5)} $DASH`)).toBe('A post can have at most 4 tags. Remove 2 tags.')
  })

  it('refuses nothing before v16, as before', async () => {
    for (const topology of ['v2', 'v9', 'v15']) expect((await limitsOn(topology)).tagLimitProblem(tags(5)), topology).toBeNull()
  })
})
