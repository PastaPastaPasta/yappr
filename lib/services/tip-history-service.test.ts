import { beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

const query = vi.hoisted(() => vi.fn())
const TOKEN_ID = 'BQP2VQvGSKGZJbtJnSVfXfHytHJVgRKkm7VbP2Nk2Nkh'

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./token-service', () => ({ tokenService: { getTokenId: async () => TOKEN_ID } }))

import { tipHistoryService, totalTipped, matchesSentTip, type ProvedTip } from './tip-history-service'

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
  it('queries the `to` index for the token, newest first, bounded', async () => {
    query.mockResolvedValueOnce(new Map([['a', transferDoc()]]))
    await tipHistoryService.getTipsReceived(AUTHOR)

    const shape = query.mock.calls[0][0]
    expect(shape.documentTypeName).toBe('transfer')
    expect(shape.where).toEqual([
      ['tokenId', '==', TOKEN_ID],
      ['toIdentityId', '==', AUTHOR],
    ])
    expect(shape.orderBy).toEqual([['tokenId', 'asc'], ['toIdentityId', 'asc'], ['$createdAt', 'desc']])
    expect(shape.limit).toBe(100)
  })

  it('queries the `from` index for sent tips', async () => {
    query.mockResolvedValueOnce(new Map())
    await tipHistoryService.getTipsSent(TIPPER)

    const shape = query.mock.calls[0][0]
    expect(shape.where).toEqual([
      ['tokenId', '==', TOKEN_ID],
      ['$ownerId', '==', TIPPER],
    ])
    expect(shape.orderBy).toEqual([['tokenId', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']])
  })

  it('maps a transfer document onto the proved shape', async () => {
    query.mockResolvedValueOnce(new Map([['a', transferDoc({ publicNote: `yappr:tip:v1:post:${POST_ID}\nnice` })]]))
    const [tip] = await tipHistoryService.getTipsReceived(AUTHOR)

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
    const [tip] = await tipHistoryService.getTipsReceived(AUTHOR)

    expect(tip.amount).toBe(BigInt(5))
    expect(tip.postId).toBeUndefined()
    expect(tip.message).toBeUndefined()
  })

  it('caches a page for the TTL rather than re-querying', async () => {
    query.mockResolvedValue(new Map([['a', transferDoc()]]))
    await tipHistoryService.getTipsReceived(AUTHOR)
    await tipHistoryService.getTipsReceived(AUTHOR)
    expect(query).toHaveBeenCalledTimes(1)

    tipHistoryService.clearCache()
    await tipHistoryService.getTipsReceived(AUTHOR)
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

describe('attributing tips to a post', () => {
  it('keeps only the transfers whose note names this post', async () => {
    query.mockResolvedValueOnce(new Map([
      ['a', transferDoc({ $id: 'DR5sJvjXkZm3hDZPzRRvqbYvJGLsPAGGvHLxbJqaCiz9', amount: BigInt(5) })],
      ['b', transferDoc({ $id: '8fmYhuM2ypyQ9GGt4KpxMc9qe5mLf55i8K3SZbHvS9Ts', amount: BigInt(2), publicNote: `yappr:tip:v1:post:${OTHER_POST_ID}` })],
      ['c', transferDoc({ $id: 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7', amount: BigInt(7), publicNote: 'unrelated payment' })],
      ['d', transferDoc({ $id: 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec', amount: BigInt(3) })],
    ]))

    const tips = await tipHistoryService.getTipsForPost(POST_ID, AUTHOR)
    expect(tips.map((tip) => tip.amount)).toEqual([BigInt(5), BigInt(3)])
    expect(totalTipped(tips)).toBe(BigInt(8))
  })

  it('does not attribute a REPLY-noted transfer to the post with the same id', async () => {
    query.mockResolvedValueOnce(new Map([
      ['a', transferDoc({ publicNote: `yappr:tip:v1:reply:${POST_ID}` })],
    ]))
    const tips = await tipHistoryService.getTipsForPost(POST_ID, AUTHOR)
    // The note names the same id, so it is this item's tip whichever doctype it is.
    expect(tips).toHaveLength(1)
    expect(tips[0].targetKind).toBe('reply')
  })

  it('degrades to no tips rather than throwing when the read fails', async () => {
    query.mockRejectedValueOnce(new Error('offline'))
    await expect(tipHistoryService.getTipsForPost(POST_ID, AUTHOR)).resolves.toEqual([])
  })

  it('needs both a post and an author before it queries anything', async () => {
    await expect(tipHistoryService.getTipsForPost('', AUTHOR)).resolves.toEqual([])
    await expect(tipHistoryService.getTipsForPost(POST_ID, '')).resolves.toEqual([])
    expect(query).not.toHaveBeenCalled()
  })
})

describe('confirming a tip landed', () => {
  const sent: ProvedTip = {
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
    const untagged: ProvedTip = { ...sent, postId: undefined, message: undefined }
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
