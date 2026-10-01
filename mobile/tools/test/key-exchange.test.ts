/**
 * A full app ↔ wallet `dash-key:` round trip with the document write stubbed:
 * the app half is vendor/platform-auth's protocol module, exactly as the web
 * and the mobile engine call it.
 */
import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  buildYapprKeyExchangeUri,
  decryptYapprKeyExchangeResponse,
  deriveYapprAuthKeyFromLogin,
  deriveYapprEncryptionKeyFromLogin,
  generateYapprEphemeralKeyPair,
  hash160,
} from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import type { YapprKeyExchangeResponse } from '../../../vendor/platform-auth/src/core/types'
import { deriveLoginKey, type LoginKeyResponseFields } from '../src/key-exchange'
import { respond, type ResponderPorts } from '../src/responder'
import { IDENTITY_ID, IDENTITY_ID_BYTES, testPersona, testPrivateKey } from './fixtures'

const APP_CONTRACT = new Uint8Array(32).fill(0x11)
const OTHER_CONTRACT = new Uint8Array(32).fill(0x22)

/** Ports whose write keeps the response in memory, like the contract would. */
function memoryPorts(stored?: number) {
  const writes: LoginKeyResponseFields[] = []
  const existing = stored === undefined ? undefined : { documentId: 'doc', revision: BigInt(1), keyIndex: stored }
  const ports: ResponderPorts = {
    findLoginKeyResponse: async () => existing,
    writeLoginKeyResponse: async (_persona, fields, found) => {
      writes.push(fields)
      return { documentId: 'doc', action: found ? 'replaced' : 'created', confirmed: true }
    },
    masterKey: () => Promise.reject(new Error('not used')),
    checkIdentityUpdate: () => Promise.reject(new Error('not used')),
    broadcast: () => Promise.reject(new Error('not used')),
  }
  return { ports, writes }
}

/** The app half: request, wallet answers, app decrypts and derives. */
async function login(options: { contractId?: Uint8Array; stored?: number; keyIndex?: number } = {}) {
  const app = generateYapprEphemeralKeyPair()
  const contractId = options.contractId ?? APP_CONTRACT
  const uri = buildYapprKeyExchangeUri({ appEphemeralPubKey: app.publicKey, contractId, label: 'Login to Yappr' }, 'devnet')
  const { ports, writes } = memoryPorts(options.stored)

  const result = await respond({ uri, persona: testPersona(), keyIndex: options.keyIndex }, ports)
  expect(writes).toHaveLength(1)
  const fields = writes[0]
  const decrypted = await decryptYapprKeyExchangeResponse(asDocument(fields), app.privateKey)
  return { app, result, fields, decrypted }
}

/** The fields as the app's poll reads them back. */
function asDocument(fields: LoginKeyResponseFields): YapprKeyExchangeResponse {
  return { $id: 'doc', $ownerId: IDENTITY_ID, $revision: 1, ...fields }
}

/** YAPPR_DET_SIGNER_SPEC.md §5.1, written out independently of src/. */
function specLoginKey(baseKey: Uint8Array, contractId: Uint8Array, keyIndex: number): Uint8Array {
  const info = new Uint8Array(36)
  info.set(contractId)
  new DataView(info.buffer).setUint32(32, keyIndex, true)
  return hkdf(sha256, baseKey, IDENTITY_ID_BYTES, info, 32)
}

describe('dash-key: round trip', () => {
  it('is answered, decrypted with decryptYapprKeyExchangeResponse, and yields the spec-derived keys', async () => {
    const { app, result, fields, decrypted } = await login()

    // The document the app polls for: byContractAndEphemeralKey.
    expect(bytesToHex(fields.contractId)).toBe(bytesToHex(APP_CONTRACT))
    expect(bytesToHex(fields.appEphemeralPubKeyHash)).toBe(bytesToHex(hash160(app.publicKey)))
    expect(fields.walletEphemeralPubKey).toHaveLength(33)
    expect(fields.encryptedPayload).toHaveLength(60)
    expect(fields.keyIndex).toBe(0)

    // The login key is HKDF(CRITICAL key, identityId, contractId || u32le(index)).
    const expectedLogin = specLoginKey(testPrivateKey(1), APP_CONTRACT, 0)
    expect(bytesToHex(decrypted.loginKey)).toBe(bytesToHex(expectedLogin))
    expect(decrypted.identityId).toBe(IDENTITY_ID)
    expect(decrypted.keyIndex).toBe(0)

    // …and the app's derivations are the spec's §5.2 and §5.3.
    const auth = deriveYapprAuthKeyFromLogin(decrypted.loginKey, IDENTITY_ID_BYTES)
    const encryption = deriveYapprEncryptionKeyFromLogin(decrypted.loginKey, IDENTITY_ID_BYTES)
    expect(bytesToHex(auth)).toBe(bytesToHex(hkdf(sha256, expectedLogin, IDENTITY_ID_BYTES, new TextEncoder().encode('auth'), 32)))
    expect(bytesToHex(encryption)).not.toBe(bytesToHex(auth))

    expect(result).toMatchObject({
      kind: 'dash-key',
      personaIdx: 90,
      identityId: IDENTITY_ID,
      keyIndex: 0,
      label: 'Login to Yappr',
      action: 'created',
      confirmed: true,
    })
  })

  it('pins the derivation with a known-answer vector', () => {
    // base = 32 × 0x02, identity = 32 × 0x42, contract = 32 × 0x11, index 0.
    const loginKey = bytesToHex(deriveLoginKey(testPrivateKey(1), IDENTITY_ID_BYTES, APP_CONTRACT, 0))
    expect(loginKey).toBe(bytesToHex(specLoginKey(testPrivateKey(1), APP_CONTRACT, 0)))
    expect(loginKey).toBe('72edc45ba02e940302e938890b95816030a090c0cf5c94513c4cf13ec2978352')
  })

  it('is deterministic: a re-login with a new app ephemeral key gets the same login key', async () => {
    const first = await login()
    const second = await login()
    expect(bytesToHex(second.fields.walletEphemeralPubKey)).not.toBe(bytesToHex(first.fields.walletEphemeralPubKey))
    expect(bytesToHex(second.decrypted.loginKey)).toBe(bytesToHex(first.decrypted.loginKey))
  })

  it('derives a different key per app contract and per keyIndex', async () => {
    const base = await login()
    const otherApp = await login({ contractId: OTHER_CONTRACT })
    const rotated = await login({ stored: 0, keyIndex: 1 })
    expect(bytesToHex(otherApp.decrypted.loginKey)).not.toBe(bytesToHex(base.decrypted.loginKey))
    expect(rotated.fields.keyIndex).toBe(1)
    expect(rotated.result).toMatchObject({ action: 'replaced', keyIndex: 1 })
    expect(bytesToHex(rotated.decrypted.loginKey)).toBe(bytesToHex(specLoginKey(testPrivateKey(1), APP_CONTRACT, 1)))
  })

  it('reuses the stored keyIndex and refuses a rollback below it (spec §12.2)', async () => {
    const relogin = await login({ stored: 3 })
    expect(relogin.fields.keyIndex).toBe(3)
    expect(bytesToHex(relogin.decrypted.loginKey)).toBe(bytesToHex(specLoginKey(testPrivateKey(1), APP_CONTRACT, 3)))
    await expect(login({ stored: 3, keyIndex: 2 })).rejects.toThrow(/rollback/)
  })

  it('cannot be decrypted with another app ephemeral key', async () => {
    const { fields } = await login()
    const stranger = generateYapprEphemeralKeyPair()
    await expect(decryptYapprKeyExchangeResponse(asDocument(fields), stranger.privateKey)).rejects.toThrow()
  })

  it('refuses a request for another network without writing', async () => {
    const app = generateYapprEphemeralKeyPair()
    const uri = buildYapprKeyExchangeUri({ appEphemeralPubKey: app.publicKey, contractId: APP_CONTRACT }, 'testnet')
    const { ports, writes } = memoryPorts()
    await expect(respond({ uri, persona: testPersona() }, ports)).rejects.toThrow(/testnet/)
    expect(writes).toHaveLength(0)
  })

  it('rejects a request with bytes after the label (spec §10.2)', async () => {
    const app = generateYapprEphemeralKeyPair()
    const uri = buildYapprKeyExchangeUri({ appEphemeralPubKey: app.publicKey, contractId: APP_CONTRACT, label: 'x' }, 'devnet')
    const payload = bs58.decode(uri.slice('dash-key:'.length, uri.indexOf('?')))
    const padded = bs58.encode(Uint8Array.from([...payload, 0]))
    const { ports, writes } = memoryPorts()
    await expect(respond({ uri: `dash-key:${padded}?n=d&v=1`, persona: testPersona() }, ports)).rejects.toThrow(/Malformed/)
    expect(writes).toHaveLength(0)
  })

  it('rejects a malformed request', async () => {
    const { ports } = memoryPorts()
    await expect(respond({ uri: 'dash-key:abc?n=d&v=1', persona: testPersona() }, ports)).rejects.toThrow(/Malformed/)
    await expect(respond({ uri: 'https://yap.pr', persona: testPersona() }, ports)).rejects.toThrow(/Unsupported/)
  })
})
