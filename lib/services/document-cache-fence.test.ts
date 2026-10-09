/**
 * The document cache is fenced against reads an invalidation overtakes: a
 * response that was in flight when its document was dropped from the cache
 * answers its own caller but is not cached, so the read that refreshed the
 * document never gets the old copy back (RC16-I-04, a quote of a reply
 * deleted on another device).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: m.query, get: m.get } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('./dpns-service', () => ({ dpnsService: { resolveUsernamesBatch: async () => new Map() } }))
vi.mock('./unified-profile-service', () => ({
  unifiedProfileService: { getProfilesByIdentityIds: async () => [], getAvatarUrlsBatch: async () => new Map() },
}))

const reply = (content: string) => ({ $id: 'replyR', $ownerId: 'owner1', $createdAt: 1000, content })

/** A response the test hands back when it chooses. */
function deferred<V>() {
  let resolve: (value: V) => void = () => undefined
  const promise = new Promise<V>((done) => { resolve = done })
  return { promise, resolve }
}

async function freshReplyService() {
  vi.resetModules()
  m.query.mockReset()
  m.get.mockReset()
  return (await import('./reply-service')).replyService
}

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9'))
afterEach(() => vi.unstubAllEnvs())

describe('document cache fence', () => {
  it('does not cache a batched read that its document was invalidated during', async () => {
    const replyService = await freshReplyService()
    const before = deferred<Map<string, unknown>>()
    m.query.mockReturnValueOnce(before.promise)

    // An earlier quote lookup asks for R before the delete.
    const earlier = replyService.getRepliesByIds(['replyR'])
    await vi.waitFor(() => expect(m.query).toHaveBeenCalledTimes(1))

    // R is deleted on another device; a refresh forgets it.
    replyService.clearCache('replyR')
    // The earlier lookup's pre-delete response lands after that.
    before.resolve(new Map([['replyR', reply('text from before the delete')]]))
    expect((await earlier).map((entry) => entry.content)).toEqual(['text from before the delete'])

    // The refresh's own lookup reads Platform again and finds nothing.
    m.query.mockResolvedValueOnce(new Map())
    expect(await replyService.getRepliesByIds(['replyR'])).toEqual([])
    expect(m.query).toHaveBeenCalledTimes(2)
  })

  it('does not cache a single read its document was invalidated during', async () => {
    const replyService = await freshReplyService()
    const before = deferred<unknown>()
    m.get.mockReturnValueOnce(before.promise)

    const earlier = replyService.get('replyR')
    await vi.waitFor(() => expect(m.get).toHaveBeenCalledTimes(1))
    replyService.clearCache()
    before.resolve(reply('text from before the delete'))
    expect((await earlier)?.content).toBe('text from before the delete')

    m.get.mockResolvedValueOnce(null)
    expect(await replyService.get('replyR')).toBeNull()
    expect(m.get).toHaveBeenCalledTimes(2)
  })

  it('still caches reads nothing invalidated, including one that started after an invalidation', async () => {
    const replyService = await freshReplyService()
    replyService.clearCache('replyR')
    m.query.mockResolvedValueOnce(new Map([['replyR', reply('current text')]]))
    await replyService.getRepliesByIds(['replyR'])

    expect((await replyService.getRepliesByIds(['replyR'])).map((entry) => entry.content)).toEqual(['current text'])
    expect(m.query).toHaveBeenCalledTimes(1)
  })
})
