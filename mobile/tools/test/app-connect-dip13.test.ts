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
import { appEncryptionKeyPath, dip13Wallet, sessionAuthKeyPath } from '../../../lib/crypto/dip13'
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
  it('derive the reference wallet\'s pinned encryption key (rust-dashcore test_application_key_vectors)', () => {
    const persona = seededPersona({ network: 'mainnet', identityIdBytes: new Uint8Array(32).fill(0x35) })
    expect(persona.connect.scheme).toBe('dip13')
    const [key] = persona.connect.encryptionKeys(new Uint8Array(32).fill(0x6b), KeyPurpose.ENCRYPTION, 3)
    expect(bytesToHex(getYapprPublicKey(key))).toBe('03e989de1b62f137231cc06659c810c17100becd1f5e23d5710faa7602769fe434')
  })

  it('hold rotation 0 only, and derive auth keys at sub-feature 6\' with #1210\'s leaf', () => {
    const persona = seededPersona()
    expect(persona.connect.encryptionKeys(APP_ID, KeyPurpose.ENCRYPTION, 5)).toHaveLength(1)
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

    chain.calls.length = 0
    const second = await answer(newRequest().uri)
    expect(second.answer.slots.find((slot) => slot.role === 'encryption')).toEqual(encryptionSlot)
    expect(chain.calls[0]).toMatch(/^update 96 \+2 /)
  })
})
