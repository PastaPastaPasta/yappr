import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../scripts/clean-test-content.mjs'
import { socialShapes } from '../scripts/social-shapes.mjs'
import { cleanupTargets, isTransient, ownerQueries, parseSince, refuseIdentities, storedOf } from '../scripts/test-content-cleanup.mjs'
import v10 from '../contracts/yappr-social-contract-v10.json'
import v12 from '../contracts/yappr-social-contract-v12.json'
import v15 from '../contracts/yappr-social-contract-v15.json'
import v16 from '../contracts/yappr-social-contract-v16.json'

// The pure half of the test-content cleanup (scripts/test-content-cleanup.mjs): the tombstone each
// cut takes, which documents a run's cleanup touches, and whom it refuses. The chain half is
// exercised live by verify-v10's end-of-run cleanup and the devnet e2e job.

const id = (fill: number) => new Uint8Array(32).fill(fill)
const b58 = (fill: number) => bs58.encode(id(fill))

describe('the author tombstone a cleanup writes', () => {
  it('keeps a v15 post\'s one hashtag and drops its content, quote, mentions and live marker', () => {
    const shapes = socialShapes(v15)
    const stored = { content: 'xxxx', live: true, hashtag: 'battery', quotedPostId: b58(3), quotedPostOwnerId: b58(4), mentionedUserIds: [b58(5)] }
    expect(shapes.tombstone('post', stored)).toEqual({ deleted: true, hashtag: 'battery' })
  })

  it('keeps a v16 post\'s whole tag list, in order', () => {
    const shapes = socialShapes(v16)
    const tombstone = shapes.tombstone('post', { content: '€€€€', live: true, tags: ['b', 'a', 'dash_cashtag'] })
    expect(tombstone).toEqual({ deleted: true, tags: ['b', 'a', 'dash_cashtag'] })
    expect(shapes.check('post', tombstone)).toEqual([])
  })

  it('leaves an untagged post\'s tags absent rather than empty', () => {
    expect(socialShapes(v16).tombstone('post', { content: 'plain', live: true })).toEqual({ deleted: true })
  })

  it('keeps a reply\'s rootPostId and replyToReplyId as bytes, whether read as base58 or bytes', () => {
    const shapes = socialShapes(v16)
    const expected = { deleted: true, rootPostId: id(1), replyToReplyId: id(2) }
    expect(shapes.tombstone('reply', { content: 'hi', rootPostId: b58(1), replyToReplyId: b58(2), mentionedUserIds: [b58(7)] })).toEqual(expected)
    expect(shapes.tombstone('reply', { content: 'hi', rootPostId: id(1), replyToReplyId: id(2) })).toEqual(expected)
  })

  it('leaves a top-level reply\'s replyToReplyId absent', () => {
    expect(socialShapes(v16).tombstone('reply', { content: 'hi', rootPostId: b58(1) })).toEqual({ deleted: true, rootPostId: id(1) })
  })

  it('keeps the stored reply owners the cut still freezes (v12)', () => {
    const tombstone = socialShapes(v12).tombstone('reply', { content: 'hi', rootPostId: b58(1), parentOwnerId: b58(6) })
    expect(tombstone).toEqual({ deleted: true, rootPostId: id(1), parentOwnerId: id(6) })
  })

  it('refuses a cut whose authors delete for real (v10)', () => {
    expect(() => socialShapes(v10).tombstone('post', {})).toThrow(/no author tombstone/)
  })
})

describe('what a cleanup touches', () => {
  const owner = b58(9)
  const doc = (fill: number, createdAt: number, extra: Record<string, unknown> = {}) => ({ $id: b58(fill), $ownerId: owner, $createdAt: createdAt, $revision: 1, ...extra })

  it('takes the identity\'s live documents created at or after since', () => {
    const docs = [doc(1, 1000), doc(2, 2000), doc(3, 3000), doc(4, 2500, { deleted: true })]
    expect(cleanupTargets(docs, { ownerId: owner, since: 2000 }).map(({ id }) => id)).toEqual([b58(2), b58(3)])
  })

  it('takes every live document without since', () => {
    expect(cleanupTargets([doc(1, 1000), doc(2, 2000)], { ownerId: owner }).map(({ id }) => id)).toEqual([b58(1), b58(2)])
  })

  it('never takes another identity\'s document, nor one with no readable time when since is set', () => {
    const docs = [{ ...doc(1, 5000), $ownerId: b58(8) }, { $id: b58(2), $ownerId: owner }]
    expect(cleanupTargets(docs, { ownerId: owner, since: 1 })).toEqual([])
  })

  it('reads a stored document\'s id, owner, time and revision off the SDK shape', () => {
    const stored = storedOf({ $id: id(1), $ownerId: id(9), $createdAt: 1700000000000n, $revision: 3n, content: 'x' })
    expect(stored).toMatchObject({ id: b58(1), ownerId: owner, createdAt: 1700000000000, revision: 3n })
  })

  it('reads the owner indexes newest first, live posts only from v13, from since', () => {
    const queries = ownerQueries(socialShapes(v16), owner, 5)
    expect(queries.post).toEqual({
      where: [['live', '==', true], ['$ownerId', '==', owner], ['$createdAt', '>=', 5]],
      orderBy: [['live', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']],
    })
    expect(queries.reply).toEqual({ where: [['$ownerId', '==', owner], ['$createdAt', '>=', 5]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']] })
    expect(ownerQueries(socialShapes(v12), owner).post.where).toEqual([['$ownerId', '==', owner]])
  })
})

describe('whom a cleanup refuses', () => {
  const maker = b58(7)

  it('refuses the maker or the contract owner', () => {
    expect(() => refuseIdentities([{ id: b58(1), label: 'bot0' }, { id: maker, label: 'bot9' }], [maker, null])).toThrow(/refusing to clean bot9/)
  })

  it('lets test identities through', () => {
    expect(() => refuseIdentities([{ id: b58(1), label: 'ci0' }], [maker, undefined])).not.toThrow()
  })
})

describe('the cleanup CLI', () => {
  it('reads --since as epoch milliseconds or an ISO time', () => {
    expect(parseSince('1791904855115')).toBe(1791904855115)
    expect(parseSince('2026-10-13T00:00:00Z')).toBe(Date.UTC(2026, 9, 13))
    expect(() => parseSince('yesterday')).toThrow(/--since/)
    expect(() => parseSince('')).toThrow(/--since/)
  })

  it('refuses epoch seconds or a bare year, which would reach back to 1970', () => {
    expect(() => parseSince('1791904855')).toThrow(/--since/)
    expect(() => parseSince('2026')).toThrow(/--since/)
  })

  it('takes the whole CI pool, or its first n slots', () => {
    const since = '1791904855115'
    expect(parseArgs(['--plan', '--ci-pool']).ciPool).toBe('all')
    expect(parseArgs(['--live', '--ci-pool', '2', '--since', since]).ciPool).toBe(2)
    expect(parseArgs(['--plan', '--ci-pool', '--since', since]).since).toBe(1791904855115)
  })

  it('reads bots as seed indexes, optionally naming the identity', () => {
    expect(parseArgs(['--plan', '--bots', '0,3:abc']).bots).toEqual([{ index: 0, id: null }, { index: 3, id: 'abc' }])
  })

  it('needs exactly one mode and at least one identity source', () => {
    expect(() => parseArgs(['--bots', '0'])).toThrow(/--plan/)
    expect(() => parseArgs(['--plan', '--live', '--bots', '0'])).toThrow(/one of/)
    expect(() => parseArgs(['--live'])).toThrow(/name the identities/)
    expect(() => parseArgs(['--live', '--ci-pool', '--maker'])).toThrow(/unknown argument/)
  })

  it('tells a transient DAPI fault from a refusal', () => {
    expect(isTransient('no available addresses to retry')).toBe(true)
    expect(isTransient('invalid quorum: Quorum not found')).toBe(true)
    expect(isTransient('request timed out after 30000ms')).toBe(true)
    expect(isTransient('code=40128 immutable property changed')).toBe(false)
    expect(isTransient("transport error: grpc error: code: 'Client specified an invalid argument', message: \"where clause on non indexed property\"")).toBe(false)
  })
})
