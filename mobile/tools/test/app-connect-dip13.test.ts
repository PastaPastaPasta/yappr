/**
 * Seeded personas: the test wallet derives its App Connect keys from the
 * pool's recovery phrase exactly as the reference wallet does (dashwallet-ios
 * #1210 -> swift-sdk `deriveConnectKey` -> rs-platform-wallet `ConnectKey` ->
 * key-wallet), so a login answered here registers the encryption key a DashPay
 * build restoring the same phrase, and the web's recovery-phrase sign-in, find.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { bytesToHex } from '@noble/hashes/utils.js'
import { WasmSdk, ensureInitialized } from '@dashevo/evo-sdk'
import { KeyPurpose, KeySecurityLevel, KeyType } from '../../../vendor/platform-auth/src/app-connect/types'
import { getYapprPublicKey } from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import { appEncryptionKeyPath, dip13Wallet, legacyAppEncryptionKeyPath, sessionAuthKeyPath } from '../../../lib/crypto/dip13'
import { appConnectAuthKeyLeaf } from '../src/app-connect/derive'
import { parseFaults } from '../src/app-connect/faults'
import { respondToAppConnect } from '../src/app-connect/wallet'
import { selectPersona, type Persona } from '../src/pool'
import { APP_ID, newChain, newRequest } from './app-connect-chain'
import { SEEDED_PERSONA_IDX, TEST_PHRASE, seededPool } from './fixtures'

beforeAll(async () => {
  await ensureInitialized()
})

const LAYOUT = [
  { purpose: KeyPurpose.AUTHENTICATION, securityLevel: KeySecurityLevel.MASTER },
  { purpose: KeyPurpose.AUTHENTICATION, securityLevel: KeySecurityLevel.CRITICAL },
  { purpose: KeyPurpose.AUTHENTICATION, securityLevel: KeySecurityLevel.HIGH },
  { purpose: KeyPurpose.TRANSFER, securityLevel: KeySecurityLevel.CRITICAL },
]

function seededPersona(options: Parameters<typeof seededPool>[0] = {}): Persona {
  return selectPersona(seededPool(options), SEEDED_PERSONA_IDX)
}

describe('seeded personas', () => {
  it('derive the DIP\'s pinned 9-level encryption keys, and the rust-dashcore ones at the pre-DIP path', () => {
    const persona = seededPersona({ network: 'mainnet', identityIdBytes: new Uint8Array(32).fill(0x35) })
    expect(persona.connect.scheme).toBe('dip13')
    const [first, second] = persona.connect.encryptionKeys(new Uint8Array(32).fill(0x6b), KeyPurpose.ENCRYPTION, 3)
    expect(bytesToHex(getYapprPublicKey(first))).toBe('031a882c119e2b1f8e0349b444d877afa2599efeef49a26930fd25518cb6e9d57a')
    expect(bytesToHex(getYapprPublicKey(second))).toBe('03d0f6f0f48d968b9554d8e7fe467d7135bacf29d5c4994ca593bd10ebeed696f6')
    // No pre-DIP key on mainnet.
    expect(persona.connect.legacyEncryptionKey).toBeUndefined()

    const testnet = seededPersona({ identityIdBytes: new Uint8Array(32).fill(0x35) })
    const legacy = testnet.connect.legacyEncryptionKey?.(new Uint8Array(32).fill(0x6b), KeyPurpose.ENCRYPTION)
    expect(legacy).toBeDefined()
    const reference = dip13Wallet(WasmSdk, TEST_PHRASE, 'testnet')
      .derive(legacyAppEncryptionKeyPath('testnet', new Uint8Array(32).fill(0x35), new Uint8Array(32).fill(0x6b))).privateKey
    expect(bytesToHex(legacy!)).toBe(bytesToHex(reference))
  })

  it('hold rotations 0..n at the DIP\'s path, derive auth keys at sub-feature 6\' with #1210\'s leaf', () => {
    const persona = seededPersona()
    expect(persona.connect.encryptionKeys(APP_ID, KeyPurpose.ENCRYPTION, 0)).toHaveLength(1)
    expect(persona.connect.encryptionKeys(APP_ID, KeyPurpose.ENCRYPTION, 5)).toHaveLength(6)
    const appEphemeralPubKey = getYapprPublicKey(new Uint8Array(32).fill(9))
    const wallet = dip13Wallet(WasmSdk, TEST_PHRASE, 'testnet')
    const expected = wallet.derive(sessionAuthKeyPath('testnet', persona.identityIdBytes, appConnectAuthKeyLeaf(appEphemeralPubKey, 1)))
    const derived = persona.connect.authKey({ appEphemeralPubKey, derivationTag: new Uint8Array(32) }, 1)
    expect(bytesToHex(derived)).toBe(bytesToHex(expected.privateKey))
    expect(() => persona.connect.authKey({ derivationTag: new Uint8Array(32) }, 1)).toThrow(/predates/)
  })

  it('refuse an identity index whose MASTER key the phrase does not hold', () => {
    expect(() => seededPersona({ identityIndex: 1, keysAtIndex: 0 })).toThrow(/does not hold its MASTER key at identity index 1/)
  })

  it('register the DIP-13 7\' key on a first login, and re-send it on the next', async () => {
    const persona = seededPersona({ identityIdBytes: new Uint8Array(32).fill(0x36) })
    const chain = newChain()
    const wallet = dip13Wallet(WasmSdk, TEST_PHRASE, 'testnet')
    chain.identities.set(persona.identityId, LAYOUT.map((layout, keyId) => ({
      id: keyId,
      type: KeyType.ECDSA_SECP256K1,
      ...layout,
      data: getYapprPublicKey(persona.key(keyId === 0 ? 'master' : keyId === 1 ? 'critical' : 'high').privateKey),
    })).slice(0, 3))
    const answer = (uri: string) => respondToAppConnect({ uri, persona, faults: parseFaults([]) }, chain.ports())

    const first = await answer(newRequest().uri)
    const encryptionSlot = first.answer.slots.find((slot) => slot.role === 'encryption')
    expect(encryptionSlot).toBeDefined()
    const registered = chain.keysOf(persona).find((key) => key.id === encryptionSlot?.keyId)
    const expected = wallet.derive(appEncryptionKeyPath('testnet', bs58.decode(persona.identityId), APP_ID)).publicKey
    expect(registered && bytesToHex(registered.data)).toBe(bytesToHex(expected))
    // At the DIP's 9-level path, not the pre-DIP one.
    const legacy = wallet.derive(legacyAppEncryptionKeyPath('testnet', bs58.decode(persona.identityId), APP_ID)).publicKey
    expect(bytesToHex(expected)).not.toBe(bytesToHex(legacy))

    chain.calls.length = 0
    const second = await answer(newRequest().uri)
    expect(second.answer.slots.find((slot) => slot.role === 'encryption')).toEqual(encryptionSlot)
    expect(chain.calls[0]).toMatch(/^update 96 \+2 /)
  })

  describe('existing encryption keys', () => {
    const encryptionSlot = (result: Awaited<ReturnType<typeof respondToAppConnect>>) =>
      result.answer.slots.find((slot) => slot.role === 'encryption')

    function setup(derivations: Array<{ id: number; legacy?: boolean; foreign?: boolean; rotation?: number; disabledAt?: number }>) {
      const persona = seededPersona({ identityIdBytes: new Uint8Array(32).fill(0x37) })
      const chain = newChain()
      const wallet = dip13Wallet(WasmSdk, TEST_PHRASE, 'testnet')
      const identityId = bs58.decode(persona.identityId)
      chain.identities.set(persona.identityId, LAYOUT.map((layout, keyId) => ({
        id: keyId,
        type: KeyType.ECDSA_SECP256K1,
        ...layout,
        data: getYapprPublicKey(persona.key(keyId === 0 ? 'master' : keyId === 1 ? 'critical' : 'high').privateKey),
      })).slice(0, 3))
      for (const { id, legacy, foreign, rotation, disabledAt } of derivations) {
        // Another wallet's key: a point this phrase does not derive at any layout.
        const path = foreign
          ? appEncryptionKeyPath('testnet', new Uint8Array(32).fill(0x99), APP_ID, KeyPurpose.ENCRYPTION, 0)
          : legacy
            ? legacyAppEncryptionKeyPath('testnet', identityId, APP_ID)
            : appEncryptionKeyPath('testnet', identityId, APP_ID, KeyPurpose.ENCRYPTION, rotation)
        chain.keysOf(persona).push({
          id,
          type: KeyType.ECDSA_SECP256K1,
          purpose: KeyPurpose.ENCRYPTION,
          securityLevel: KeySecurityLevel.MEDIUM,
          data: wallet.derive(path).publicKey,
          bounds: { kind: 'singleContract', contractId: bs58.encode(APP_ID) },
          ...(disabledAt ? { disabledAt } : {}),
        })
      }
      return { persona, chain }
    }
    const answer = (persona: Persona, chain: ReturnType<typeof newChain>) =>
      respondToAppConnect({ uri: newRequest().uri, persona, faults: parseFaults([]) }, chain.ports())

    it('re-sends a pre-DIP key it finds current, registering nothing', async () => {
      const { persona, chain } = setup([{ id: 7, legacy: true }])
      const result = await answer(persona, chain)
      expect(encryptionSlot(result)).toMatchObject({ keyId: 7 })
      expect(result.answer.addedKeyIds).toHaveLength(2)
    })

    it('re-sends a later rotation it finds current when rotation 0 was disabled', async () => {
      const { persona, chain } = setup([{ id: 7, rotation: 0, disabledAt: 1 }, { id: 8, rotation: 1 }])
      const result = await answer(persona, chain)
      expect(encryptionSlot(result)).toMatchObject({ keyId: 8 })
      expect(result.answer.addedKeyIds).toHaveLength(2)
    })

    it('omits the slot and registers nothing when only a pre-DIP key exists and it is disabled', async () => {
      const { persona, chain } = setup([{ id: 7, legacy: true, disabledAt: 1 }])
      const result = await answer(persona, chain)
      expect(encryptionSlot(result)).toBeUndefined()
      expect(result.answer.addedKeyIds).toHaveLength(2)
    })

    it('omits the slot and registers nothing beside another wallet\'s disabled key', async () => {
      const { persona, chain } = setup([{ id: 7, foreign: true, disabledAt: 1 }])
      const result = await answer(persona, chain)
      expect(encryptionSlot(result)).toBeUndefined()
      expect(result.answer.addedKeyIds).toHaveLength(2)
    })
  })
})
