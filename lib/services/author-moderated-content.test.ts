import { describe, expect, it } from 'vitest'
import type { Post } from '@/lib/types'
import { laneLabel, laneOf, mergeAuthorLanes, unlistedLanePins } from './author-moderated-content'

const post = (id: string, at: number, moderation?: Post['moderation']) =>
  ({ id, createdAt: new Date(at), ...(moderation ? { moderation } : {}) }) as Post

describe('unlistedLanePins', () => {
  it('reads every v18 lane of an author listing but the listed one', () => {
    const lanes = unlistedLanePins([['live', '==', 1], ['mod', '==', null]])
    expect(lanes).toEqual([
      [['live', '==', 1], ['mod', '==', 1]],
      [['live', '==', 1], ['mod', '==', 2]],
      [['live', '==', 2], ['mod', '==', null]],
      [['live', '==', 2], ['mod', '==', 1]],
      [['live', '==', 2], ['mod', '==', 2]],
    ])
  })

  it('reads nothing before v18, where a listing has no lanes', () => {
    expect(unlistedLanePins([['live', '==', true]])).toEqual([])
    expect(unlistedLanePins([])).toEqual([])
  })
})

describe('laneOf and laneLabel', () => {
  it('files a post by its own marks', () => {
    expect(laneOf(post('a', 1))).toBeNull()
    expect(laneOf(post('a', 1, { mod: 1 }))).toEqual({ live: 1, mod: 1 })
    expect(laneOf(post('a', 1, { mod: 2 }))).toEqual({ live: 1, mod: 2 })
    expect(laneOf(post('a', 1, { restricted: true }))).toEqual({ live: 2, mod: null })
    expect(laneOf(post('a', 1, { restricted: true, mod: 1 }))).toEqual({ live: 2, mod: 1 })
  })

  it('names each lane in words', () => {
    expect(laneLabel({ live: 1, mod: 1 })).toBe('Hidden')
    expect(laneLabel({ live: 1, mod: 2 })).toBe('Hidden for legal reasons')
    expect(laneLabel({ live: 2, mod: null })).toBe('Restricted')
    expect(laneLabel({ live: 2, mod: 1 })).toBe('Restricted · hidden')
  })
})

describe('mergeAuthorLanes', () => {
  it('lists each unlisted post once, newest first, and counts them per lane', () => {
    const hiddenOld = post('h1', 10, { mod: 1 })
    const hiddenNew = post('h2', 30, { mod: 1 })
    const restricted = post('r1', 20, { restricted: true })
    const merged = mergeAuthorLanes([
      { items: [hiddenNew, hiddenOld], full: false },
      // A fanned-out read returns another lane's too, and a listed post never belongs here.
      { items: [restricted, hiddenNew, post('listed', 40)], full: false },
    ])
    expect(merged.items.map((item) => item.id)).toEqual(['h2', 'r1', 'h1'])
    expect(merged.lanes).toEqual([
      { lane: { live: 1, mod: 1 }, count: 2 },
      { lane: { live: 2, mod: null }, count: 1 },
    ])
    expect(merged.more).toBe(false)
  })

  it('says there may be more when a read filled its page', () => {
    expect(mergeAuthorLanes([{ items: [], full: true }]).more).toBe(true)
    expect(mergeAuthorLanes([]).lanes).toEqual([])
  })
})
