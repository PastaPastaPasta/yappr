import { beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

const query = vi.hoisted(() => vi.fn())
const count = vi.hoisted(() => vi.fn())

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query, count } }) }))
// v9 is what puts tip documents on the contract; every read here is gated on it.
vi.mock('../contract-topology', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../contract-topology')>()
  return {
    ...actual,
    provedTipsAvailable: () => true,
    tipSurfaceFor: (kind: 'post' | 'reply') =>
      kind === 'post'
        ? { docType: 'tip', tippedField: 'postId' }
        : { docType: 'tipReply', tippedField: 'replyId' },
  }
})

import { provedTipService, totalTipped } from './proved-tip-service'

const POST_ID = '9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9'
const REPLY_ID = 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe'
const AUTHOR = '7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P'
const TIPPER = '64RTgHjGXhtiN9t5S4u6hVDps7oHuTBaaHrQEFYcxt9M'
const TRANSFER_ID = 'DR5sJvjXkZm3hDZPzRRvqbYvJGLsPAGGvHLxbJqaCiz9'

/** A `tip` document as `toObject()` hands it over: identifier fields as raw bytes. */
function tipDoc(overrides: Record<string, unknown> = {}) {
  return {
    toObject: () => ({
      $id: '8fmYhuM2ypyQ9GGt4KpxMc9qe5mLf55i8K3SZbHvS9Ts',
      $ownerId: TIPPER,
      $createdAt: 1_700_000_000_000,
      transferId: bs58.decode(TRANSFER_ID),
      amount: 5,
      recipientId: bs58.decode(AUTHOR),
      postId: bs58.decode(POST_ID),
      ...overrides,
    }),
  }
}

beforeEach(() => {
  query.mockReset()
  count.mockReset()
  provedTipService.clearCache()
})

describe('reading a post\'s tips', () => {
  it('queries the tip doctype on its tipped-and-time index, newest first', async () => {
    query.mockResolvedValueOnce(new Map([['a', tipDoc()]]))
    await provedTipService.getTipsFor('post', POST_ID)

    const shape = query.mock.calls[0][0]
    expect(shape.documentTypeName).toBe('tip')
    expect(shape.where).toEqual([['postId', '==', POST_ID]])
    expect(shape.orderBy).toEqual([['postId', 'asc'], ['$createdAt', 'desc']])
    expect(shape.limit).toBe(100)
  })

  it('never reads token history: the amount comes off the tip document itself', async () => {
    query.mockResolvedValueOnce(new Map([['a', tipDoc({ amount: 25 })]]))
    const [tip] = await provedTipService.getTipsFor('post', POST_ID)

    expect(tip.amount).toBe(BigInt(25))
    expect(tip.from).toBe(TIPPER)
    expect(tip.to).toBe(AUTHOR)
    expect(tip.tippedId).toBe(POST_ID)
    expect(tip.transferId).toBe(TRANSFER_ID)
    expect(tip.messageReplyId).toBeUndefined()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('carries the reply a tip was written with, when there was one', async () => {
    query.mockResolvedValueOnce(new Map([['a', tipDoc({ messageReplyId: bs58.decode(REPLY_ID) })]]))
    const [tip] = await provedTipService.getTipsFor('post', POST_ID)
    expect(tip.messageReplyId).toBe(REPLY_ID)
  })

  it('drops a document missing a field the contract requires rather than rendering a hole', async () => {
    query.mockResolvedValueOnce(new Map([['a', tipDoc({ transferId: undefined })]]))
    await expect(provedTipService.getTipsFor('post', POST_ID)).resolves.toEqual([])
  })

  it('sums a set of tips', async () => {
    query.mockResolvedValueOnce(new Map([
      ['a', tipDoc({ $id: '8fmYhuM2ypyQ9GGt4KpxMc9qe5mLf55i8K3SZbHvS9Ts', amount: 5 })],
      ['b', tipDoc({ $id: 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7', amount: 3 })],
    ]))
    expect(totalTipped(await provedTipService.getTipsFor('post', POST_ID))).toBe(BigInt(8))
  })

  it('caches per tipped document, then re-reads once cleared', async () => {
    query.mockResolvedValue(new Map([['a', tipDoc()]]))
    await provedTipService.getTipsFor('post', POST_ID)
    await provedTipService.getTipsFor('post', POST_ID)
    expect(query).toHaveBeenCalledTimes(1)

    provedTipService.clearCache()
    await provedTipService.getTipsFor('post', POST_ID)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('degrades to no tips rather than throwing when the read fails', async () => {
    query.mockRejectedValueOnce(new Error('offline'))
    await expect(provedTipService.getTipsFor('post', POST_ID)).resolves.toEqual([])
  })

  it('queries nothing without a target', async () => {
    await expect(provedTipService.getTipsFor('post', '')).resolves.toEqual([])
    expect(query).not.toHaveBeenCalled()
  })
})

describe('reading tips on a thread\'s replies', () => {
  it('asks only about the replies it was given, keyed by reply', async () => {
    query.mockResolvedValueOnce(new Map([
      ['a', tipDoc({ postId: undefined, replyId: bs58.decode(REPLY_ID), amount: 2 })],
      ['b', tipDoc({ $id: 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7', postId: undefined, replyId: bs58.decode(REPLY_ID), amount: 4 })],
    ]))

    const byReply = await provedTipService.getTipsForReplies([REPLY_ID])
    const shape = query.mock.calls[0][0]
    expect(shape.documentTypeName).toBe('tipReply')
    expect(shape.where).toEqual([['replyId', 'in', [REPLY_ID]]])
    expect(totalTipped(byReply.get(REPLY_ID) ?? [])).toBe(BigInt(6))
  })

  it('asks in small batches, so one heavily tipped reply cannot crowd out a whole page', async () => {
    query.mockResolvedValue(new Map())
    const ids = Array.from({ length: 50 }, (_, index) => `${REPLY_ID.slice(0, -3)}${index.toString().padStart(3, '0')}`)
    await provedTipService.getTipsForReplies(ids)

    const batchSizes = query.mock.calls.map((call) => call[0].where[0][2].length)
    expect(batchSizes).toEqual([20, 20, 10])
    // Every batch is far smaller than the document limit it shares.
    expect(Math.max(...batchSizes)).toBeLessThan(query.mock.calls[0][0].limit)
  })

  it('caches per reply, including the replies with no tips, so scrolling does not re-ask', async () => {
    query.mockResolvedValueOnce(new Map([['a', tipDoc({ postId: undefined, replyId: bs58.decode(REPLY_ID) })]]))
    await provedTipService.getTipsForReplies([REPLY_ID, POST_ID])
    expect(query).toHaveBeenCalledTimes(1)

    const again = await provedTipService.getTipsForReplies([REPLY_ID, POST_ID])
    expect(query).toHaveBeenCalledTimes(1)
    expect(again.get(REPLY_ID)).toHaveLength(1)
    expect(again.has(POST_ID)).toBe(false)
  })

  it('queries nothing for an empty thread', async () => {
    await expect(provedTipService.getTipsForReplies([])).resolves.toEqual(new Map())
    expect(query).not.toHaveBeenCalled()
  })
})

describe('proved counts', () => {
  it('counts a post\'s tips off the count tree', async () => {
    count.mockResolvedValueOnce(new Map([['', BigInt(12)]]))
    await expect(provedTipService.countTipsFor('post', POST_ID)).resolves.toBe(12)
    expect(count.mock.calls[0][0].where).toEqual([['postId', '==', POST_ID]])
  })

  it('counts tips received across both tip doctypes', async () => {
    count
      .mockResolvedValueOnce(new Map([['', BigInt(7)]]))
      .mockResolvedValueOnce(new Map([['', BigInt(2)]]))

    await expect(provedTipService.countTipsReceived(AUTHOR)).resolves.toBe(9)
    expect(count.mock.calls.map((call) => call[0].documentTypeName)).toEqual(['tip', 'tipReply'])
    expect(count.mock.calls[0][0].where).toEqual([['recipientId', '==', AUTHOR]])
  })

  it('reports zero rather than throwing when a count tree read fails', async () => {
    count.mockRejectedValue(new Error('offline'))
    await expect(provedTipService.countTipsReceived(AUTHOR)).resolves.toBe(0)
  })
})
