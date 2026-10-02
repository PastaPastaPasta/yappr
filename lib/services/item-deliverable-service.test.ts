import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from '@noble/hashes/utils.js'

const { query, updateDocument } = vi.hoisted(() => ({ query: vi.fn(), updateDocument: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }))
import { itemDeliverableService } from './item-deliverable-service'
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
  query.mockReset()
  updateDocument.mockReset()
})

describe('saveKit', () => {
  it('replaces at the revision it read, not a fresh one', async () => {
    updateDocument.mockResolvedValue({ success: true, document: { ...(await onChain(5, kit)) } })
    const saved = await itemDeliverableService.saveKit(seller, itemId, kit, sellerKey, existing)
    expect(updateDocument.mock.calls[0][5]).toBe(4)
    expect(saved.$revision).toBe(5)
  })

  it('treats a write that landed despite a failed response as saved', async () => {
    updateDocument.mockResolvedValue({ success: false, error: 'gateway timeout' })
    query.mockResolvedValue([await onChain(5, kit)])
    const saved = await itemDeliverableService.saveKit(seller, itemId, kit, sellerKey, existing)
    expect(saved.$revision).toBe(5)
  })

  it('reports a refused write when the next revision holds something else', async () => {
    updateDocument.mockResolvedValue({ success: false, error: 'stale revision' })
    query.mockResolvedValue([await onChain(5, { ...kit, licenseKeys: ['other'] })])
    await expect(itemDeliverableService.saveKit(seller, itemId, kit, sellerKey, existing)).rejects.toThrow('stale revision')
  })
})
