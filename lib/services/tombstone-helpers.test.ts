/**
 * The tombstone is the delete path for `canBeDeleted: false` doctypes, and on
 * v8 every reference it carries is a `deletableDocument` one that a replace
 * re-validates. The two branches that matter are pinned here: a post whose
 * quote target a moderator removed must be tombstoned with the reference
 * CLEARED (keeping it is 40120, and clearing it is the one change the
 * `immutable` check lets through), while on v7 — where nothing a post points
 * at can disappear — the preserve set is sent verbatim and never retried.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, updateDocument } = vi.hoisted(() => ({ get: vi.fn(), updateDocument: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }))

const contractId = '11111111111111111111111111111111'
const postId = '11111111111111111111111111111112'
const ownerId = '11111111111111111111111111111113'
const quotedPostId = '11111111111111111111111111111114'
const quotedOwnerId = '11111111111111111111111111111115'

/** A stored quote post, in the raw shape `documents.get` hands back. */
function storedQuotePost() {
  return {
    toObject: () => ({
      $id: postId,
      $ownerId: ownerId,
      $revision: 3,
      content: 'quoting a post that has since been removed',
      language: 'en',
      quotedPostId,
      quotedPostOwnerId: quotedOwnerId,
    }),
  }
}

const REFERENCE_NOT_FOUND = 'referenced document 1111 not found for path quotedPostId, code=40120'

/** The data of the n-th replace attempt. */
const attempt = (n: number) => updateDocument.mock.calls[n][4] as Record<string, unknown>

async function tombstone(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  const [{ tombstoneDocument }, { tombstonePreservationFor }] = await Promise.all([
    import('./tombstone-helpers'),
    import('@/lib/contract-topology'),
  ])
  return tombstoneDocument({
    contractId,
    documentType: 'post',
    documentId: postId,
    ownerId,
    preserve: tombstonePreservationFor('post'),
  })
}

beforeEach(() => {
  get.mockReset().mockResolvedValue(storedQuotePost())
  updateDocument.mockReset()
})

describe('tombstoning a quote of a removed post', () => {
  it('retries once with the dead reference cleared on v8', async () => {
    updateDocument
      .mockResolvedValueOnce({ success: false, error: REFERENCE_NOT_FOUND })
      .mockResolvedValueOnce({ success: true })

    await expect(tombstone('v8')).resolves.toBe(true)
    expect(updateDocument).toHaveBeenCalledTimes(2)

    // The first attempt preserves the quote graph, as every tombstone does.
    expect(attempt(0)).toMatchObject({ content: '', deleted: true })
    expect(attempt(0).quotedPostId).toBeInstanceOf(Uint8Array)
    // The retry drops the dead REFERENCE and nothing else: quotedPostOwnerId
    // is not a reference, so dropping it would be a plain 40128.
    expect(attempt(1)).not.toHaveProperty('quotedPostId')
    expect(attempt(1).quotedPostOwnerId).toBeInstanceOf(Uint8Array)
    expect(attempt(1)).toMatchObject({ content: '', deleted: true })
    // Same revision: the refused replace never bumped it.
    expect(updateDocument.mock.calls[1][5]).toBe(updateDocument.mock.calls[0][5])
  })

  it('does not retry on v7, where a reference cannot go dead', async () => {
    updateDocument.mockResolvedValue({ success: false, error: REFERENCE_NOT_FOUND })
    await expect(tombstone('v7')).resolves.toBe(false)
    expect(updateDocument).toHaveBeenCalledTimes(1)
    expect(attempt(0).quotedPostId).toBeInstanceOf(Uint8Array)
  })

  it('does not retry a rejection that is not a dead reference', async () => {
    updateDocument.mockResolvedValue({ success: false, error: 'property content is immutable on replace, code=40128' })
    await expect(tombstone('v8')).resolves.toBe(false)
    expect(updateDocument).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the post carries no clearable reference', async () => {
    get.mockResolvedValue({
      toObject: () => ({ $id: postId, $ownerId: ownerId, $revision: 1, content: 'plain post', language: 'en' }),
    })
    updateDocument.mockResolvedValue({ success: false, error: REFERENCE_NOT_FOUND })
    await expect(tombstone('v8')).resolves.toBe(false)
    expect(updateDocument).toHaveBeenCalledTimes(1)
  })

  it('reports failure when the cleared retry is refused too', async () => {
    updateDocument
      .mockResolvedValueOnce({ success: false, error: REFERENCE_NOT_FOUND })
      .mockResolvedValueOnce({ success: false, error: REFERENCE_NOT_FOUND })
    await expect(tombstone('v8')).resolves.toBe(false)
    expect(updateDocument).toHaveBeenCalledTimes(2)
  })

  it('sends one replace and preserves the quote when nothing is dead', async () => {
    updateDocument.mockResolvedValue({ success: true })
    await expect(tombstone('v8')).resolves.toBe(true)
    expect(updateDocument).toHaveBeenCalledTimes(1)
    expect(attempt(0).quotedPostId).toBeInstanceOf(Uint8Array)
  })
})
