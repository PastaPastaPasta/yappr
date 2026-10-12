import * as secp256k1 from '@noble/secp256k1'
import { describe, expect, it } from 'vitest'
import { AppConnectPayloadError, appConnectSlotCount, openAppConnectPayload, sealAppConnectPayload } from './crypto'
import { seed, vectorKeys, yapprVectorRequest } from './test-helpers'

const appEphemeralPubKey = yapprVectorRequest().appEphemeralPubKey
const slots = [vectorKeys.groupKey, vectorKeys.profileKey]

async function sealed(ownerId = vectorKeys.ownerId) {
  return sealAppConnectPayload({ appEphemeralPubKey, ownerId, slots })
}

async function openError(input: Parameters<typeof openAppConnectPayload>[0]): Promise<string> {
  try {
    await openAppConnectPayload(input)
  } catch (error) {
    if (error instanceof AppConnectPayloadError) return error.code
    throw error
  }
  throw new Error('expected the payload to be refused')
}

describe('App Connect payload crypto', () => {
  it('opens what it seals, in slot order', async () => {
    const response = await sealed()
    expect(response.encryptedPayload.length).toBe(28 + 64)
    const opened = await openAppConnectPayload({
      appEphemeralPrivateKey: vectorKeys.appEphemeralPrivateKey,
      ownerId: vectorKeys.ownerId,
      ...response,
    })
    expect(opened).toEqual(slots)
  })

  it('refuses a response published under another identity (AAD binds $ownerId)', async () => {
    const response = await sealed()
    expect(await openError({
      appEphemeralPrivateKey: vectorKeys.appEphemeralPrivateKey,
      ownerId: seed('someone else'),
      ...response,
    })).toBe('decrypt')
  })

  it('refuses a response to another request', async () => {
    const response = await sealed()
    expect(await openError({
      appEphemeralPrivateKey: seed('another request'),
      ownerId: vectorKeys.ownerId,
      ...response,
    })).toBe('decrypt')
  })

  it('refuses a tampered tag or ciphertext', async () => {
    const response = await sealed()
    for (const index of [12, response.encryptedPayload.length - 1]) {
      const encryptedPayload = response.encryptedPayload.slice()
      encryptedPayload[index] ^= 1
      expect(await openError({
        appEphemeralPrivateKey: vectorKeys.appEphemeralPrivateKey,
        ownerId: vectorKeys.ownerId,
        walletEphemeralPubKey: response.walletEphemeralPubKey,
        encryptedPayload,
      })).toBe('decrypt')
    }
  })

  it('refuses a wallet key that is not a point', async () => {
    const response = await sealed()
    expect(await openError({
      appEphemeralPrivateKey: vectorKeys.appEphemeralPrivateKey,
      ownerId: vectorKeys.ownerId,
      walletEphemeralPubKey: Uint8Array.of(2, ...Array(32).fill(0xff)),
      encryptedPayload: response.encryptedPayload,
    })).toBe('decrypt')
  })

  it('checks framing before decrypting', async () => {
    for (const length of [0, 28, 59, 61, 28 + 32 * 18]) {
      expect(appConnectSlotCount(length), `length ${length}`).toBeNull()
      expect(await openError({
        appEphemeralPrivateKey: vectorKeys.appEphemeralPrivateKey,
        ownerId: vectorKeys.ownerId,
        walletEphemeralPubKey: secp256k1.getPublicKey(vectorKeys.walletEphemeralPrivateKey, true),
        encryptedPayload: new Uint8Array(length),
      })).toBe('framing')
    }
    expect(appConnectSlotCount(60)).toBe(1)
    expect(appConnectSlotCount(28 + 32 * 17)).toBe(17)
  })

  it('refuses to seal malformed slots', async () => {
    await expect(sealAppConnectPayload({ appEphemeralPubKey, ownerId: vectorKeys.ownerId, slots: [] })).rejects.toThrow()
    await expect(sealAppConnectPayload({ appEphemeralPubKey, ownerId: vectorKeys.ownerId, slots: [new Uint8Array(31)] })).rejects.toThrow()
  })
})
