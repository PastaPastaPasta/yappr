import { describe, expect, it } from 'vitest'
import * as secp256k1 from '@noble/secp256k1'
import bs58 from 'bs58'
import {
  BLUETOOTH_LOGIN_RESPONSE_LENGTH,
  bluetoothPairingCode,
  buildBluetoothLoginRequest,
  parseBluetoothLoginResponse,
} from './bluetooth-login'

// The phone-side test suite (SwiftExampleAppTests/BrowserLoginKeyProtocolTests)
// pins the same vectors, so a drift on either side shows up as a red test.
const appPrivateKey = new Uint8Array(32).fill(0x11)
const appPublicKey = secp256k1.getPublicKey(appPrivateKey, true)
const contractId = new Uint8Array(32).fill(0x44)
const identityId = new Uint8Array(32).fill(0x33)

describe('buildBluetoothLoginRequest', () => {
  it('lays out version, network byte, key, contract and label', () => {
    const bytes = buildBluetoothLoginRequest(
      { appEphemeralPubKey: appPublicKey, contractId, label: 'Login to Yappr' },
      'devnet',
    )
    expect(bytes.length).toBe(1 + 1 + 33 + 32 + 1 + 14)
    expect(bytes[0]).toBe(1)
    expect(bytes[1]).toBe('d'.charCodeAt(0))
    expect(Array.from(bytes.subarray(2, 35))).toEqual(Array.from(appPublicKey))
    expect(Array.from(bytes.subarray(35, 67))).toEqual(Array.from(contractId))
    expect(bytes[67]).toBe(14)
    expect(new TextDecoder().decode(bytes.subarray(68))).toBe('Login to Yappr')
  })

  it('uses the same network letters as the dash-key: URI', () => {
    const request = { appEphemeralPubKey: appPublicKey, contractId, label: '' }
    expect(buildBluetoothLoginRequest(request, 'mainnet')[1]).toBe('m'.charCodeAt(0))
    expect(buildBluetoothLoginRequest(request, 'testnet')[1]).toBe('t'.charCodeAt(0))
  })
})

describe('bluetoothPairingCode', () => {
  it('matches the phone for the shared test key', () => {
    expect(bs58.encode(appPublicKey)).toBeTruthy()
    expect(Buffer.from(appPublicKey).toString('hex')).toBe(
      '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa',
    )
    expect(bluetoothPairingCode(appPublicKey)).toBe('350178')
  })

  it('is always six digits', () => {
    for (let i = 1; i < 20; i++) {
      const code = bluetoothPairingCode(secp256k1.getPublicKey(new Uint8Array(32).fill(i), true))
      expect(code).toMatch(/^\d{6}$/)
    }
  })
})

describe('parseBluetoothLoginResponse', () => {
  function buildResponse(overrides: { keyId?: number; expiresAt?: bigint; totalBudget?: bigint } = {}): Uint8Array {
    const bytes = new Uint8Array(BLUETOOTH_LOGIN_RESPONSE_LENGTH)
    const view = new DataView(bytes.buffer)
    bytes[0] = 1
    bytes.set(identityId, 1)
    bytes.set(appPublicKey, 33)
    bytes.set(new Uint8Array(60).map((_, i) => i), 66)
    view.setUint32(126, overrides.keyId ?? 0x01020304)
    view.setBigUint64(130, overrides.expiresAt ?? 1_800_000_000_000n)
    view.setBigUint64(138, overrides.totalBudget ?? 250_000_000n)
    return bytes
  }

  it('decodes every field', () => {
    const response = parseBluetoothLoginResponse(buildResponse())
    expect(response.identityId).toBe(bs58.encode(identityId))
    expect(Array.from(response.identityIdBytes)).toEqual(Array.from(identityId))
    expect(Array.from(response.walletEphemeralPubKey)).toEqual(Array.from(appPublicKey))
    expect(response.encryptedPayload.length).toBe(60)
    expect(response.encryptedPayload[59]).toBe(59)
    expect(response.keyId).toBe(0x01020304)
    expect(response.expiresAt).toBe(1_800_000_000_000)
    expect(response.totalBudget).toBe(250_000_000n)
  })

  it('reads zero limits as absent', () => {
    const response = parseBluetoothLoginResponse(buildResponse({ expiresAt: 0n, totalBudget: 0n }))
    expect(response.expiresAt).toBeNull()
    expect(response.totalBudget).toBeNull()
  })

  it('rejects the wrong length or version', () => {
    expect(() => parseBluetoothLoginResponse(buildResponse().subarray(1))).toThrow(/length/)
    const wrongVersion = buildResponse()
    wrongVersion[0] = 2
    expect(() => parseBluetoothLoginResponse(wrongVersion)).toThrow(/version/)
  })
})
