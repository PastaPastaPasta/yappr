import { beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

const query = vi.hoisted(() => vi.fn())
const TOKEN_ID = 'BQP2VQvGSKGZJbtJnSVfXfHytHJVgRKkm7VbP2Nk2Nkh'

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./token-service', () => ({ tokenService: { getTokenId: async () => TOKEN_ID } }))

import { tipHistoryService, matchesSentTip, type SentTransfer } from './tip-history-service'

const POST_ID = '9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9'
const OTHER_POST_ID = 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe'
const AUTHOR = '7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P'
const TIPPER = '64RTgHjGXhtiN9t5S4u6hVDps7oHuTBaaHrQEFYcxt9M'

/** A `transfer` document the way `toObject()` hands it over: identifier fields as raw bytes. */
function transferDoc(overrides: Record<string, unknown> = {}) {
  return {
    toObject: () => ({
      $id: 'DR5sJvjXkZm3hDZPzRRvqbYvJGLsPAGGvHLxbJqaCiz9',
      $ownerId: TIPPER,
      $createdAt: 1_700_000_000_000,
      tokenId: bs58.decode(TOKEN_ID),
      amount: BigInt(5),
      toIdentityId: bs58.decode(AUTHOR),
      publicNote: `yappr:tip:v1:post:${POST_ID}`,
      ...overrides,
    }),
  }
}

beforeEach(() => {
  query.mockReset()
  tipHistoryService.clearCache()
})

describe('reading transfers off the token-history contract', () => {
  it('reads the sender\'s OWN transfers off the `from` index, newest first, bounded', async () => {
    query.mockResolvedValueOnce(new Map())
    await tipHistoryService.getTipsSent(TIPPER)

    const shape = query.mock.calls[0][0]
    expect(shape.documentTypeName).toBe('transfer')
    expect(shape.where).toEqual([
      ['tokenId', '==', TOKEN_ID],
      ['$ownerId', '==', TIPPER],
    ])
    expect(shape.orderBy).toEqual([['tokenId', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']])
    expect(shape.limit).toBe(100)
  })

  it('maps a transfer document onto the sent-transfer shape', async () => {
    query.mockResolvedValueOnce(new Map([['a', transferDoc({ publicNote: `yappr:tip:v1:post:${POST_ID}\nnice` })]]))
    const [tip] = await tipHistoryService.getTipsSent(TIPPER)

    expect(tip.amount).toBe(BigInt(5))
    expect(tip.from).toBe(TIPPER)
    expect(tip.to).toBe(AUTHOR)
    expect(tip.postId).toBe(POST_ID)
    expect(tip.targetKind).toBe('post')
    expect(tip.message).toBe('nice')
    expect(tip.createdAt.getTime()).toBe(1_700_000_000_000)
  })

  it('keeps a transfer with no tip note, but attributes it to no post', async () => {
    query.mockResolvedValueOnce(new Map([['a', transferDoc({ publicNote: 'here you go' })]]))
    const [tip] = await tipHistoryService.getTipsSent(TIPPER)

    expect(tip.amount).toBe(BigInt(5))
    expect(tip.postId).toBeUndefined()
    expect(tip.message).toBeUndefined()
  })

  it('caches a page for the TTL rather than re-querying', async () => {
    query.mockResolvedValue(new Map([['a', transferDoc()]]))
    await tipHistoryService.getTipsSent(TIPPER)
    await tipHistoryService.getTipsSent(TIPPER)
    expect(query).toHaveBeenCalledTimes(1)

    tipHistoryService.clearCache()
    await tipHistoryService.getTipsSent(TIPPER)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('bypasses the cache with `fresh`, so polling for a landing tip sees it', async () => {
    query.mockResolvedValue(new Map())
    await tipHistoryService.getTipsSent(TIPPER)
    await tipHistoryService.getTipsSent(TIPPER)
    expect(query).toHaveBeenCalledTimes(1)

    await tipHistoryService.getTipsSent(TIPPER, { fresh: true })
    expect(query).toHaveBeenCalledTimes(2)
  })
})

describe('confirming a tip landed', () => {
  const sent: SentTransfer = {
    id: 'DR5sJvjXkZm3hDZPzRRvqbYvJGLsPAGGvHLxbJqaCiz9',
    amount: BigInt(5),
    from: TIPPER,
    to: AUTHOR,
    createdAt: new Date(2_000_000),
    postId: POST_ID,
    targetKind: 'post',
    message: 'nice',
  }
  const match = { to: AUTHOR, amount: BigInt(5), postId: POST_ID, message: 'nice', since: 1_000_000 }

  it('matches the tip it describes', () => {
    expect(matchesSentTip(sent, match)).toBe(true)
  })

  it.each([
    ['a different recipient', { ...match, to: TIPPER }],
    ['a different amount', { ...match, amount: BigInt(6) }],
    ['a different post', { ...match, postId: OTHER_POST_ID }],
    ['a different message', { ...match, message: 'other' }],
    ['a transfer older than the window', { ...match, since: 3_000_000 }],
  ])('rejects %s', (_label, wrong) => {
    expect(matchesSentTip(sent, wrong)).toBe(false)
  })

  it('does not treat an untagged transfer as a tip on a post', () => {
    const untagged: SentTransfer = { ...sent, postId: undefined, message: undefined }
    expect(matchesSentTip(untagged, match)).toBe(false)
    expect(matchesSentTip(untagged, { to: AUTHOR, amount: BigInt(5) })).toBe(true)
  })

  it('polls until the proof appears rather than trusting the broadcast', async () => {
    query
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([['a', transferDoc({ publicNote: `yappr:tip:v1:post:${POST_ID}\nnice` })]]))

    const found = await tipHistoryService.awaitSentTip(
      TIPPER,
      { to: AUTHOR, amount: BigInt(5), postId: POST_ID, message: 'nice' },
      { attempts: 3, delayMs: 0 }
    )
    expect(found?.amount).toBe(BigInt(5))
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('gives up rather than reporting a tip that never landed', async () => {
    query.mockResolvedValue(new Map())
    const found = await tipHistoryService.awaitSentTip(
      TIPPER,
      { to: AUTHOR, amount: BigInt(5) },
      { attempts: 2, delayMs: 0 }
    )
    expect(found).toBeNull()
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('keeps polling through a transient read failure', async () => {
    query
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Map([['a', transferDoc()]]))

    const found = await tipHistoryService.awaitSentTip(
      TIPPER,
      { to: AUTHOR, amount: BigInt(5), postId: POST_ID },
      { attempts: 3, delayMs: 0 }
    )
    expect(found).not.toBeNull()
  })
})
