import { describe, expect, it } from 'vitest'
import { composeDraftKey, hasUnpostedContent, switchDraft } from './drafts'

describe('composeDraftKey', () => {
  it('keys a new post, a reply and a quote apart', () => {
    expect(composeDraftKey({})).toBe('post')
    expect(composeDraftKey({ replyingTo: null, quotingPost: null })).toBe('post')
    expect(composeDraftKey({ replyingTo: { id: 'X' } })).toBe('reply:X')
    expect(composeDraftKey({ quotingPost: { id: 'X' } })).toBe('quote:X')
  })

  it('gives different replies different keys', () => {
    expect(composeDraftKey({ replyingTo: { id: 'X' } })).not.toBe(composeDraftKey({ replyingTo: { id: 'Y' } }))
  })
})

describe('hasUnpostedContent', () => {
  it('is false for blank or whitespace-only parts', () => {
    expect(hasUnpostedContent([{ content: '' }])).toBe(false)
    expect(hasUnpostedContent([{ content: ' \n\t ' }, { content: '​' }])).toBe(false)
  })

  it('is true for text in any unposted part', () => {
    expect(hasUnpostedContent([{ content: '' }, { content: 'second' }])).toBe(true)
  })

  it('counts a teaser on its own', () => {
    expect(hasUnpostedContent([{ content: '', teaser: 'come see' }])).toBe(true)
  })

  it('ignores parts already posted', () => {
    expect(hasUnpostedContent([{ content: 'sent', postedPostId: 'p1' }, { content: '' }])).toBe(false)
  })
})

describe('switchDraft', () => {
  type Draft = { text: string }
  const isEmpty = (d: Draft) => d.text === ''
  const fresh = (): Draft => ({ text: '' })

  it('keeps the live draft and the stash when the key does not change', () => {
    const current = { text: 'hello' }
    const result = switchDraft({ currentKey: 'post', current, isEmpty, nextKey: 'post', stash: { 'reply:X': { text: 'x' } }, fresh })
    expect(result.draft).toBe(current)
    expect(result.stash).toEqual({ 'reply:X': { text: 'x' } })
  })

  it('stashes the draft being left and starts a fresh one for a new target', () => {
    const result = switchDraft({ currentKey: 'reply:X', current: { text: 'for X' }, isEmpty, nextKey: 'reply:Y', stash: {}, fresh })
    expect(result.draft).toEqual({ text: '' })
    expect(result.stash).toEqual({ 'reply:X': { text: 'for X' } })
  })

  it('never shows the draft for one reply under another', () => {
    const toY = switchDraft({ currentKey: 'reply:X', current: { text: 'for X' }, isEmpty, nextKey: 'reply:Y', stash: {}, fresh })
    expect(toY.draft.text).toBe('')
    const backToX = switchDraft({ currentKey: 'reply:Y', current: toY.draft, isEmpty, nextKey: 'reply:X', stash: toY.stash, fresh })
    expect(backToX.draft).toEqual({ text: 'for X' })
    expect(backToX.stash).toEqual({})
  })

  it('does not stash an empty draft', () => {
    const result = switchDraft({ currentKey: 'reply:X', current: { text: '' }, isEmpty, nextKey: 'post', stash: {}, fresh })
    expect(result.stash).toEqual({})
  })

  it('drops a stale stash entry for the key being left when its draft is now empty', () => {
    const result = switchDraft({ currentKey: 'post', current: { text: '' }, isEmpty, nextKey: 'reply:X', stash: { post: { text: 'old' } }, fresh })
    expect(result.stash).toEqual({})
  })

  it('does not mutate the stash it was given', () => {
    const stash = { 'reply:Y': { text: 'y' } }
    switchDraft({ currentKey: 'post', current: { text: 'a' }, isEmpty, nextKey: 'reply:Y', stash, fresh })
    expect(stash).toEqual({ 'reply:Y': { text: 'y' } })
  })
})
