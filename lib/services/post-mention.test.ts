/**
 * v10 indexes a post's or reply's mentions inline: `createPost` and
 * `createReply` resolve the first @mention of the PUBLIC content and write it
 * as the document's own `mentionedUserId`; v15 writes the first eight as
 * `mentionedUserIds`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

const { resolveIdentity, prepareOwnerEncryption, prepareInheritedEncryption } = vi.hoisted(() => ({ resolveIdentity: vi.fn(), prepareOwnerEncryption: vi.fn(), prepareInheritedEncryption: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: vi.fn() }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('./dpns-service', () => ({ dpnsService: { resolveIdentity } }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))
vi.mock('./private-feed-service', () => ({ prepareOwnerEncryption, prepareInheritedEncryption }))

const BOB = bs58.encode(new Uint8Array(32).fill(7))

beforeEach(() => {
  vi.resetModules()
  resolveIdentity.mockReset().mockImplementation(async (name: string) => (name === 'bob' ? BOB : null))
  prepareOwnerEncryption.mockReset()
  prepareInheritedEncryption.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** The data `createPost` hands to the document write, on `topology`. */
async function written(topology: string, content: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  const { postService } = await import('./post-service')
  const create = vi.spyOn(postService, 'create').mockResolvedValue({} as Awaited<ReturnType<typeof postService.create>>)
  await postService.createPost('owner', content, options)
  return create.mock.calls[0][1]
}

describe('inline post mention (v10)', () => {
  it('writes the first resolvable mention as mentionedUserId; the rest stay text', async () => {
    const data = await written('v10', 'hey @Bob.dash and @carol')
    expect(resolveIdentity).toHaveBeenCalledTimes(1)
    expect(resolveIdentity).toHaveBeenCalledWith('bob')
    expect(data.mentionedUserId).toEqual(bs58.decode(BOB))
  })

  it('omits the property when there is no mention or the first one does not resolve', async () => {
    expect(await written('v10', 'no mentions')).not.toHaveProperty('mentionedUserId')
    expect(resolveIdentity).not.toHaveBeenCalled()
    expect(await written('v10', '@carol then @bob')).not.toHaveProperty('mentionedUserId')
    expect(resolveIdentity).toHaveBeenCalledWith('carol')
  })

  it('indexes a private post from its public teaser, never from the encrypted text', async () => {
    prepareOwnerEncryption.mockResolvedValue({ success: true, data: { encryptedContent: new Uint8Array(1), epoch: 1, nonce: new Uint8Array(1), teaser: 'teaser for @bob' } })
    const withTeaser = await written('v10', 'secret for @carol', { encryption: { type: 'owner', teaser: 'teaser for @bob' } })
    expect(withTeaser.mentionedUserId).toEqual(bs58.decode(BOB))
    expect(resolveIdentity).not.toHaveBeenCalledWith('carol')

    prepareOwnerEncryption.mockResolvedValue({ success: true, data: { encryptedContent: new Uint8Array(1), epoch: 1, nonce: new Uint8Array(1) } })
    const noTeaser = await written('v10', 'secret for @bob', { encryption: { type: 'owner' } })
    expect(noTeaser).not.toHaveProperty('mentionedUserId')
  })

  it('writes no inline mention on v9 or v2', async () => {
    for (const topology of ['v9', 'v2']) {
      vi.resetModules()
      expect(await written(topology, 'hey @bob'), topology).not.toHaveProperty('mentionedUserId')
    }
    expect(resolveIdentity).not.toHaveBeenCalled()
  })
})

/** The data `createReply` hands to the document write, on `topology`. */
async function writtenReply(topology: string, content: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  const { replyService } = await import('./reply-service')
  const create = vi.spyOn(replyService, 'create').mockResolvedValue({} as Awaited<ReturnType<typeof replyService.create>>)
  const ROOT = bs58.encode(new Uint8Array(32).fill(1))
  await replyService.createReply('owner', content, { rootPostId: ROOT, parentOwnerId: BOB }, options)
  return create.mock.calls[0][1]
}

describe('inline reply mention (v10)', () => {
  it('writes the first resolvable mention of a reply as its mentionedUserId, like a post', async () => {
    const data = await writtenReply('v10', 'agreed @Bob.dash, cc @carol')
    expect(resolveIdentity).toHaveBeenCalledTimes(1)
    expect(resolveIdentity).toHaveBeenCalledWith('bob')
    expect(data.mentionedUserId).toEqual(bs58.decode(BOB))
  })

  it('omits it without a resolvable first mention', async () => {
    expect(await writtenReply('v10', 'no mentions')).not.toHaveProperty('mentionedUserId')
    expect(await writtenReply('v10', '@carol then @bob')).not.toHaveProperty('mentionedUserId')
  })

  it('never indexes a mention out of an encrypted reply: only its public teaser or placeholder', async () => {
    prepareInheritedEncryption.mockResolvedValue({ success: true, data: { encryptedContent: new Uint8Array(1), epoch: 1, nonce: new Uint8Array(1) } })
    const inherited = await writtenReply('v10', 'secret for @bob', { encryption: { type: 'inherited', source: { ownerId: BOB, epoch: 1 } } })
    expect(inherited).not.toHaveProperty('mentionedUserId')
    expect(resolveIdentity).not.toHaveBeenCalled()

    prepareOwnerEncryption.mockResolvedValue({ success: true, data: { encryptedContent: new Uint8Array(1), epoch: 1, nonce: new Uint8Array(1), teaser: 'teaser for @bob' } })
    const withTeaser = await writtenReply('v10', 'secret for @carol', { encryption: { type: 'owner', teaser: 'teaser for @bob' } })
    expect(withTeaser.mentionedUserId).toEqual(bs58.decode(BOB))
    expect(resolveIdentity).not.toHaveBeenCalledWith('carol')
  })

  it('writes no reply mention on v9 or v2', async () => {
    for (const topology of ['v9', 'v2']) {
      vi.resetModules()
      expect(await writtenReply(topology, 'hey @bob'), topology).not.toHaveProperty('mentionedUserId')
    }
    expect(resolveIdentity).not.toHaveBeenCalled()
  })
})

describe('inline mentions on v15 (mentionedUserIds, up to 8)', () => {
  const ids = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((name, n) => [name, bs58.encode(new Uint8Array(32).fill(10 + n))]))
  const mentioned = (data: Record<string, unknown>) => (data.mentionedUserIds as Uint8Array[] | undefined)?.map((bytes) => bs58.encode(bytes))

  beforeEach(() => {
    // `alias` is a second name of b's identity; `ghost` resolves to nobody.
    resolveIdentity.mockImplementation(async (name: string) => (name === 'alias' ? ids.b : ids[name] ?? null))
  })

  it('writes the distinct mentions in order of appearance as raw identifiers', async () => {
    const data = await written('v15', 'hi @C and @a.dash, then @c again and @b')
    expect(mentioned(data)).toEqual([ids.c, ids.a, ids.b])
    expect((data.mentionedUserIds as Uint8Array[])[0]).toBeInstanceOf(Uint8Array)
    expect(data).not.toHaveProperty('mentionedUserId')
    expect(resolveIdentity.mock.calls.map(([name]) => name)).toEqual(['c', 'a', 'b'])
  })

  it('fills all 8 slots: skips a name that does not resolve and names an identity once', async () => {
    const data = await written('v15', '@a @ghost @alias @b @c @d @e @f @g @h @i')
    // ghost is skipped and alias is b, so the 8 identities run to h; i is the ninth.
    expect(mentioned(data)).toEqual([ids.a, ids.b, ids.c, ids.d, ids.e, ids.f, ids.g, ids.h])
    expect(resolveIdentity).toHaveBeenCalledTimes(11)
  })

  it('looks up at most 16 names, in one batch', async () => {
    const ghosts = Array.from({ length: 15 }, (_, n) => `@ghost${n}`).join(' ')
    const data = await written('v15', `${ghosts} @a @b`)
    expect(mentioned(data)).toEqual([ids.a])
    expect(resolveIdentity).toHaveBeenCalledTimes(16)
    expect(resolveIdentity).not.toHaveBeenCalledWith('b')
  })

  it('writes no mentions, and still posts, when the username lookup cannot load', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v15')
    const { postService } = await import('./post-service')
    const create = vi.spyOn(postService, 'create').mockResolvedValue({} as Awaited<ReturnType<typeof postService.create>>)
    // Only the lazy lookup fails to load, after the post module itself has.
    vi.doMock('./dpns-service', () => {
      throw new Error('chunk failed to load')
    })
    try {
      await postService.createPost('owner', 'hi @a')
      expect(create).toHaveBeenCalledTimes(1)
      expect(create.mock.calls[0][1]).not.toHaveProperty('mentionedUserIds')
      expect(resolveIdentity).not.toHaveBeenCalled()
    } finally {
      vi.doMock('./dpns-service', () => ({ dpnsService: { resolveIdentity } }))
    }
  })

  it('omits the property when nothing resolves (an empty list is refused)', async () => {
    expect(await written('v15', 'no mentions')).not.toHaveProperty('mentionedUserIds')
    expect(await written('v15', 'only @ghost')).not.toHaveProperty('mentionedUserIds')
  })

  it('writes a reply\'s mentions the same way', async () => {
    expect(mentioned(await writtenReply('v15', 'agreed @b, cc @a'))).toEqual([ids.b, ids.a])
  })

  it('keeps v14 at one mentionedUserId, the first name', async () => {
    const data = await written('v14', 'hi @a and @b')
    expect(data.mentionedUserId).toEqual(bs58.decode(ids.a))
    expect(data).not.toHaveProperty('mentionedUserIds')
    expect(resolveIdentity).toHaveBeenCalledTimes(1)
  })
})
