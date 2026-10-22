/**
 * v18 "hide, don't delete": a moderator hides a post or reply by setting `mod`
 * (and `modLabel`), and the author's tombstone must carry both through
 * unchanged, because a replace that drops one is a moderator-field change
 * (refused 41124). The marks are read from the CURRENT stored document right
 * before the write: a hide placed after the client loaded the card is kept.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, updateDocument } = vi.hoisted(() => ({ get: vi.fn(), updateDocument: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }))

const contractId = '11111111111111111111111111111111'
const postId = '11111111111111111111111111111112'
const ownerId = '11111111111111111111111111111113'
const rootPostId = '11111111111111111111111111111116'

const stored = (fields: Record<string, unknown>) => ({
  toObject: () => ({ $id: postId, $ownerId: ownerId, $revision: 4, content: 'x', ...fields }),
})

/** The data of the first replace attempt. */
const sent = () => updateDocument.mock.calls[0][4] as Record<string, unknown>

async function tombstone(topology: string, documentType: 'post' | 'reply' = 'post') {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  const [{ tombstoneDocument }, { tombstonePreservationFor }] = await Promise.all([
    import('./tombstone-helpers'),
    import('@/lib/contract-topology'),
  ])
  return tombstoneDocument({ contractId, documentType, documentId: postId, ownerId, preserve: tombstonePreservationFor(documentType) })
}

beforeEach(() => {
  get.mockReset()
  updateDocument.mockReset().mockResolvedValue({ success: true })
})

describe('v18 tombstones carry the moderator marks through', () => {
  it('keeps mod and modLabel of a post hidden after the client loaded it, from the revision just read', async () => {
    get.mockResolvedValue(stored({ live: 1, tags: ['dash'], mod: 1, modLabel: 7, $moderatedAt: 1_790_000_000_000 }))

    await expect(tombstone('v18')).resolves.toBe(true)

    expect(get).toHaveBeenCalledTimes(1)
    // The tombstone, the tags and the moderator's fields only: `live` and the content go, and the
    // platform's own `$moderated*` stamps are never written.
    expect(sent()).toEqual({ deleted: true, tags: ['dash'], mod: 1, modLabel: 7 })
    expect(updateDocument.mock.calls[0][5]).toBe(4)
  })

  it('writes no moderator field for a post nobody hid', async () => {
    get.mockResolvedValue(stored({ live: 1 }))

    await expect(tombstone('v18')).resolves.toBe(true)

    expect(sent()).toEqual({ deleted: true })
  })

  it('keeps mod and modLabel on a reply beside its thread linkage', async () => {
    get.mockResolvedValue(stored({ live: 2, rootPostId, mod: 2, modLabel: 3 }))

    await expect(tombstone('v18', 'reply')).resolves.toBe(true)

    expect(sent()).toMatchObject({ deleted: true, mod: 2, modLabel: 3 })
    expect(sent().rootPostId).toBeInstanceOf(Uint8Array)
    expect(sent()).not.toHaveProperty('live')
    expect(sent()).not.toHaveProperty('content')
  })

  it('writes no moderator field on v17, which has none', async () => {
    get.mockResolvedValue(stored({ live: true, tags: ['dash'], mod: 1 }))

    await expect(tombstone('v17')).resolves.toBe(true)

    expect(sent()).not.toHaveProperty('mod')
  })
})
