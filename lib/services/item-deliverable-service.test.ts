import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from '@noble/hashes/utils.js'

const { query, updateDocument, settleSupersededReplaces } = vi.hoisted(() => ({ query: vi.fn(), updateDocument: vi.fn(), settleSupersededReplaces: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }))
vi.mock('./identity-nonce', () => ({ settleSupersededReplaces }))
import { itemDeliverableService, KitWriteUncertainError } from './item-deliverable-service'
import { encryptForSelf } from '../crypto/digital-delivery'
import { encodeKit } from './digital-delivery-plan'
import type { ItemDeliverable, ItemDeliverablePayload } from '../../types'

const seller = '11111111111111111111111111111111'
const itemId = '22222222222222222222222222222222'
const sellerKey = randomBytes(32)
const existing: ItemDeliverable = { id: 'kit-doc', ownerId: seller, itemId, createdAt: new Date(0), $revision: 4, encryptedPayload: new Uint8Array([1]) }
const kit: ItemDeliverablePayload = { v: 1, assets: [], deliverWhen: 'on_order', licenseKeys: ['k2', 'k3'] }

/** The kit document as a query returns it, at `revision`, holding `content`. */
async function onChain(revision: number, content: ItemDeliverablePayload) {
  return { $id: 'kit-doc', $ownerId: seller, $createdAt: 0, $revision: revision, itemId, encryptedPayload: await encryptForSelf(encodeKit(content), sellerKey, itemId) }
}

beforeEach(() => {
  vi.useFakeTimers()
  query.mockReset()
  updateDocument.mockReset()
  settleSupersededReplaces.mockReset()
  settleSupersededReplaces.mockResolvedValue(1)
})
afterEach(() => {
  vi.useRealTimers()
})

/** Run `saveKit`, skipping its reconciliation waits. */
async function save(from: ItemDeliverable | null = existing) {
  const promise = itemDeliverableService.saveKit(seller, itemId, kit, sellerKey, from)
  promise.catch(() => undefined)
  await vi.runAllTimersAsync()
  return promise
}

/** A failed replace that records the ciphertext it tried to write. */
function failingReplace(error: string) {
  const attempt: { bytes?: Uint8Array } = {}
  updateDocument.mockImplementation(async (...args: unknown[]) => {
    attempt.bytes = (args[4] as { encryptedPayload: Uint8Array }).encryptedPayload
    return { success: false, error }
  })
  return attempt
}

describe('saveKit', () => {
  it('replaces at the revision it read, not a fresh one', async () => {
    updateDocument.mockResolvedValue({ success: true, document: await onChain(5, kit) })
    const saved = await save()
    expect(updateDocument.mock.calls[0][5]).toBe(4)
    expect(saved.$revision).toBe(5)
  })

  it('treats a write that landed despite a failed response as saved (matched by its exact ciphertext)', async () => {
    const attempt = failingReplace('gateway timeout')
    query.mockImplementation(async () => [{ ...(await onChain(5, kit)), encryptedPayload: attempt.bytes }])
    const saved = await save()
    expect(saved.$revision).toBe(5)
  })

  it('settles the pending SDK nonce of a replace it found landed, so the next write is not held back', async () => {
    const attempt = failingReplace('gateway timeout')
    query.mockImplementation(async () => [{ ...(await onChain(5, kit)), encryptedPayload: attempt.bytes }])
    settleSupersededReplaces.mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    await save()
    expect(settleSupersededReplaces).toHaveBeenCalledTimes(2)
    expect(settleSupersededReplaces.mock.calls[0][0]).toBe(seller)
  })

  it('does not settle anything for a write that was refused', async () => {
    failingReplace('stale revision')
    query.mockResolvedValue([await onChain(5, kit)])
    await expect(save()).rejects.toThrow('stale revision')
    expect(settleSupersededReplaces).not.toHaveBeenCalled()
  })

  it('does not take another tab\'s identical reservation for its own', async () => {
    failingReplace('stale revision')
    // Same plaintext pool, encrypted by the other tab: different ciphertext.
    query.mockResolvedValue([await onChain(5, kit)])
    await expect(save()).rejects.toThrow('stale revision')
  })

  it('reports an unknown outcome when the kit has moved past the revision this write needed', async () => {
    // This write may have landed at 5 and been replaced by another device since.
    failingReplace('gateway timeout')
    query.mockResolvedValue([await onChain(6, kit)])
    await expect(save()).rejects.toBeInstanceOf(KitWriteUncertainError)
  })

  it('reports an unknown outcome when an unconfirmed create finds a kit already replaced', async () => {
    const create = vi.spyOn(itemDeliverableService, 'create')
    create.mockRejectedValue(new Error('gateway timeout'))
    query.mockResolvedValue([await onChain(2, kit)])
    await expect(save(null)).rejects.toBeInstanceOf(KitWriteUncertainError)
    query.mockResolvedValue([await onChain(1, kit)])
    await expect(save(null)).rejects.toThrow('gateway timeout')
    create.mockRestore()
  })

  it('reports an unknown outcome when the chain still shows the old revision', async () => {
    failingReplace('gateway timeout')
    query.mockResolvedValue([await onChain(4, kit)])
    await expect(save()).rejects.toBeInstanceOf(KitWriteUncertainError)
  })

  it('does not take an unconfirmed create for saved until the chain shows it', async () => {
    const create = vi.spyOn(itemDeliverableService, 'create')
    const attempt: { bytes?: Uint8Array } = {}
    create.mockImplementation(async (...args: unknown[]) => {
      attempt.bytes = (args[1] as { encryptedPayload: Uint8Array }).encryptedPayload
      return { id: 'kit-doc', ownerId: seller, itemId, createdAt: new Date(0), encryptedPayload: attempt.bytes, __createConfirmed: false } as ItemDeliverable
    })
    query.mockResolvedValue([])
    await expect(save(null)).rejects.toBeInstanceOf(KitWriteUncertainError)

    query.mockImplementation(async () => [{ ...(await onChain(1, kit)), encryptedPayload: attempt.bytes }])
    expect((await save(null)).$revision).toBe(1)
    create.mockRestore()
  })

  it('reports an unknown outcome when the chain cannot be read', async () => {
    failingReplace('gateway timeout')
    query.mockRejectedValue(new Error('offline'))
    await expect(save()).rejects.toBeInstanceOf(KitWriteUncertainError)
  })
})
