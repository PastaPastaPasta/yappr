import { afterEach, describe, expect, it, vi } from 'vitest'

const { deleteDocument, query } = vi.hoisted(() => ({ deleteDocument: vi.fn(), query: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { deleteDocument } }))

import { passkeyVaultService, type VaultEntryDocument } from './passkey-vault-service'

const entry = (id: string): VaultEntryDocument => ({
  $id: id, $ownerId: 'owner', $revision: 1, $createdAt: 1, $updatedAt: 1,
  version: 1, authKeyId: 2, credentialId: new Uint8Array(16),
  recipientKey: new Uint8Array(32), enc: new Uint8Array(32), sealed: new Uint8Array(32),
})

afterEach(() => vi.restoreAllMocks())

describe('passkey deletion against lagging replicas', () => {
  it('hides a confirmed deletion from stale list and sign-in reads', async () => {
    const document = entry('confirmed')
    query.mockResolvedValue([document])
    deleteDocument.mockResolvedValue({ success: true })
    await passkeyVaultService.remove(document)
    expect(await passkeyVaultService.list('owner')).toEqual([])
    expect(await passkeyVaultService.find('owner', document.credentialId)).toBeNull()
  })

  it('never treats a capped page of confirmed deletions as a complete empty vault', async () => {
    const documents = Array.from({ length: 1001 }, (_, index) => entry(`bulk-${index}`))
    deleteDocument.mockResolvedValue({ success: true })
    await Promise.all(documents.slice(0, 1000).map(document => passkeyVaultService.remove(document)))
    query.mockImplementation(async ({ startAfter, limit }: { startAfter?: string; limit: number }) => {
      const start = startAfter ? documents.findIndex(document => document.$id === startAfter) + 1 : 0
      return documents.slice(start, start + limit)
    })
    await expect(passkeyVaultService.list('owner', { partial: true })).rejects.toThrow('still updating')
  })

  it('keeps a refused deletion available for retry', async () => {
    const document = entry('refused')
    query.mockResolvedValue([document])
    deleteDocument.mockResolvedValue({ success: false, error: 'Delete refused' })
    await expect(passkeyVaultService.remove(document)).rejects.toThrow('Delete refused')
    expect(await passkeyVaultService.list('owner')).toEqual([document])
    expect(await passkeyVaultService.find('owner', document.credentialId)).toEqual(document)
  })
})
