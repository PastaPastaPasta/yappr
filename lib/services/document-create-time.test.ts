/**
 * A write returns the document it built, which Platform has not stamped with
 * `$createdAt` yet. The created post or reply must still carry a real time:
 * an Invalid Date renders as no time at all (QA D-L3a-004, D-L3i-001).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

const { createDocument } = vi.hoisted(() => ({ createDocument: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: vi.fn() }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument } }))
vi.mock('./dpns-service', () => ({ dpnsService: { resolveIdentity: vi.fn(async () => null) } }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))

const ID = bs58.encode(new Uint8Array(32).fill(3))
const OWNER = bs58.encode(new Uint8Array(32).fill(5))
const ROOT = bs58.encode(new Uint8Array(32).fill(1))
const NOW = Date.UTC(2026, 9, 3, 1, 6)

/** What `createDocument` returns for a write it did not read back. */
const built = (type: string, data: Record<string, unknown>) => ({
  success: true,
  transactionHash: ID,
  document: { $id: ID, $ownerId: OWNER, $type: type, ...data },
  confirmed: true,
})

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
  createDocument.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('a created document without $createdAt', () => {
  it('gives a new post the time the write went through', async () => {
    createDocument.mockImplementation(async (_contract, type, _owner, data) => built(type, data))
    const { postService } = await import('./post-service')
    const post = await postService.createPost(OWNER, 'hello')
    expect(post.id).toBe(ID)
    expect(post.createdAt.getTime()).toBe(NOW)
  })

  it('gives a new reply the time the write went through', async () => {
    createDocument.mockImplementation(async (_contract, type, _owner, data) => built(type, data))
    const { replyService } = await import('./reply-service')
    const reply = await replyService.createReply(OWNER, 'hi', { rootPostId: ROOT, parentOwnerId: OWNER })
    expect(reply.createdAt.getTime()).toBe(NOW)
  })

  it('keeps the block time of a document Platform returned', async () => {
    const blockTime = NOW - 5_000
    createDocument.mockImplementation(async (_contract, type, _owner, data) => {
      const result = built(type, data)
      return { ...result, document: { ...result.document, $createdAt: blockTime } }
    })
    const { postService } = await import('./post-service')
    const post = await postService.createPost(OWNER, 'hello')
    expect(post.createdAt.getTime()).toBe(blockTime)
  })
})

describe('withCreationTime', () => {
  it('stamps only a document with no creation time', async () => {
    const { withCreationTime } = await import('./document-service')
    expect(withCreationTime({ $id: ID }, 42)).toEqual({ $id: ID, $createdAt: 42 })
    const stamped = { $id: ID, $createdAt: 7 }
    expect(withCreationTime(stamped, 42)).toBe(stamped)
    const legacy = { id: ID, createdAt: 7 }
    expect(withCreationTime(legacy, 42)).toBe(legacy)
  })
})
