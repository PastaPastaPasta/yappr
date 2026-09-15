import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import bs58check from 'bs58check'
import { privateKeyToWif } from './crypto/wif'
import { decryptFromBinary, encryptToBinary, generateConversationId, getPublicKeyFromPrivate } from './message-encryption'

const ALICE_PRIV = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const BOB_PRIV = Uint8Array.from({ length: 32 }, (_, i) => 250 - i)
const ALICE_WIF = privateKeyToWif(ALICE_PRIV, 'testnet')
const BOB_WIF = privateKeyToWif(BOB_PRIV, 'testnet')
const ALICE_PUB = getPublicKeyFromPrivate(ALICE_WIF)
const BOB_PUB = getPublicKeyFromPrivate(BOB_WIF)

describe('direct-message encryption', () => {
  it('round-trips a message between two parties', async () => {
    const sealed = await encryptToBinary('hi bob', ALICE_WIF, BOB_PUB)
    expect(sealed.length).toBe(12 + 'hi bob'.length + 16)
    expect(await decryptFromBinary(sealed, BOB_WIF, ALICE_PUB)).toBe('hi bob')
  })

  it('cannot be read by a third party', async () => {
    const sealed = await encryptToBinary('hi bob', ALICE_WIF, BOB_PUB)
    const eveWif = privateKeyToWif(Uint8Array.from({ length: 32 }, () => 7), 'testnet')
    await expect(decryptFromBinary(sealed, eveWif, ALICE_PUB)).rejects.toThrow()
  })

  it('rejects a WIF whose checksum does not verify', async () => {
    // Same payload, corrupted checksum: previously accepted silently.
    const raw = bs58check.decode(ALICE_WIF)
    const badChecksum = bs58.encode(Uint8Array.from([...raw, 0, 0, 0, 0]))
    await expect(encryptToBinary('x', badChecksum, BOB_PUB)).rejects.toThrow()
  })

  it('derives a stable, order-independent 10-byte conversation id', async () => {
    const a = await generateConversationId('alice', 'bob')
    const b = await generateConversationId('bob', 'alice')
    expect(a).toEqual(b)
    expect(a.length).toBe(10)
    expect(await generateConversationId('alice', 'carol')).not.toEqual(a)
  })
})
