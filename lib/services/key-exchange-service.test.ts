import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))

const CONTRACT_ID = new Uint8Array(32).fill(7)
const HASH = new Uint8Array(20).fill(9)
const HASH_BASE64 = Buffer.from(HASH).toString('base64')

/** What the v3 `byContractAndEphemeralKey` entry synthesizes: no keyIndex, no $createdAt. */
const responseDoc = {
  $id: 'DocId',
  $ownerId: 'WalletIdentity',
  contractId: CONTRACT_ID,
  appEphemeralPubKeyHash: HASH,
  walletEphemeralPubKey: new Uint8Array(33).fill(2),
  encryptedPayload: new Uint8Array(60).fill(3),
}

/** What the v3 `byHandshakeMeta` entry synthesizes: the two remaining levels. */
const metaDoc = { ...responseDoc, keyIndex: 5, $createdAt: 1789695369474 }

async function loadService(topology: 'v2' | 'v3') {
  process.env.NEXT_PUBLIC_KEY_EXCHANGE_TOPOLOGY = topology
  vi.resetModules()
  return (await import('./key-exchange-service')).keyExchangeService
}

const whereOf = (call: number) => query.mock.calls[call][0].where

beforeEach(() => query.mockReset())
afterEach(() => {
  delete process.env.NEXT_PUBLIC_KEY_EXCHANGE_TOPOLOGY
})

describe('getResponse query shapes', () => {
  it('v2 issues the one composite query and nothing else', async () => {
    const service = await loadService('v2')
    query.mockResolvedValueOnce([{ ...metaDoc, $revision: 1 }])

    const response = await service.getResponse(CONTRACT_ID, HASH)

    expect(query).toHaveBeenCalledTimes(1)
    expect(whereOf(0)).toEqual([
      ['contractId', '==', 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx'],
      ['appEphemeralPubKeyHash', '==', HASH_BASE64],
    ])
    expect(response?.keyIndex).toBe(5)
  })

  it('v3 keeps the polling query identical and completes it from byHandshakeMeta', async () => {
    const service = await loadService('v3')
    query.mockResolvedValueOnce([responseDoc]).mockResolvedValueOnce([metaDoc])

    const response = await service.getResponse(CONTRACT_ID, HASH)

    expect(query).toHaveBeenCalledTimes(2)
    // The poll is byte-for-byte v2's shape — it must stay servable by
    // byContractAndEphemeralKey alone.
    expect(whereOf(0)).toEqual([
      ['contractId', '==', 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx'],
      ['appEphemeralPubKeyHash', '==', HASH_BASE64],
    ])
    // The second read pins the hash ALONE: naming contractId too would route
    // it back to byContractAndEphemeralKey, which carries neither level.
    expect(whereOf(1)).toEqual([['appEphemeralPubKeyHash', '==', HASH_BASE64]])
    expect(response).toMatchObject({
      $ownerId: 'WalletIdentity',
      keyIndex: 5,
      $createdAt: 1789695369474,
    })
    expect(response?.encryptedPayload).toEqual(responseDoc.encryptedPayload)
  })

  it('v3 keeps the response when the second read fails or answers for another wallet', async () => {
    const service = await loadService('v3')

    query.mockResolvedValueOnce([responseDoc]).mockRejectedValueOnce(new Error('504'))
    const afterFailure = await service.getResponse(CONTRACT_ID, HASH)
    expect(afterFailure?.encryptedPayload).toEqual(responseDoc.encryptedPayload)
    expect(afterFailure?.$createdAt).toBeUndefined()

    // A handshake answered by two wallets: the two reads order differently, so
    // metadata from a different $ownerId must not be merged in.
    query
      .mockResolvedValueOnce([responseDoc])
      .mockResolvedValueOnce([{ ...metaDoc, $ownerId: 'OtherWallet' }])
    const afterMismatch = await service.getResponse(CONTRACT_ID, HASH)
    expect(afterMismatch?.$ownerId).toBe('WalletIdentity')
    expect(afterMismatch?.$createdAt).toBeUndefined()
  })

  it('v3 does not issue the second read while the wallet has not answered', async () => {
    const service = await loadService('v3')
    query.mockResolvedValueOnce([])

    await expect(service.getResponse(CONTRACT_ID, HASH)).resolves.toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
  })
})
