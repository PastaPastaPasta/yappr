/**
 * v10 indexes one mention per post or reply, inline: `createPost` and
 * `createReply` resolve the first @mention of the PUBLIC content and write it
 * as the document's own `mentionedUserId`.
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
