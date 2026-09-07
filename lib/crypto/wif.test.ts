import { describe, expect, it } from 'vitest'
import {
  MAINNET_WIF_PREFIX,
  TESTNET_WIF_PREFIX,
  bytesToHex,
  hexToBytes,
  isLikelyHex,
  isLikelyWif,
  parsePrivateKey,
  privateKeyToWif,
  validateWifNetwork,
  wifToPrivateKey,
} from './wif'

const KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)
const KEY_HEX = bytesToHex(KEY)

describe('WIF encode/decode', () => {
  it('round-trips a compressed testnet key', () => {
    const wif = privateKeyToWif(KEY, 'testnet', true)
    const decoded = wifToPrivateKey(wif)
    expect(decoded.privateKey).toEqual(KEY)
    expect(decoded.compressed).toBe(true)
    expect(decoded.prefix).toBe(TESTNET_WIF_PREFIX)
    expect(wif[0]).toBe('c')
  })

  it('round-trips an uncompressed mainnet key', () => {
    const wif = privateKeyToWif(KEY, 'mainnet', false)
    const decoded = wifToPrivateKey(wif)
    expect(decoded.privateKey).toEqual(KEY)
    expect(decoded.compressed).toBe(false)
    expect(decoded.prefix).toBe(MAINNET_WIF_PREFIX)
  })

  it('rejects keys that are not 32 bytes', () => {
    expect(() => privateKeyToWif(new Uint8Array(31))).toThrow('32 bytes')
  })

  it('rejects a WIF with a corrupted checksum', () => {
    const wif = privateKeyToWif(KEY)
    const last = wif[wif.length - 1]
    const tampered = wif.slice(0, -1) + (last === 'a' ? 'b' : 'a')
    expect(() => wifToPrivateKey(tampered)).toThrow()
    expect(isLikelyWif(tampered)).toBe(false)
  })

  it('validates the network prefix', () => {
    expect(validateWifNetwork(TESTNET_WIF_PREFIX, 'testnet')).toBe(true)
    expect(validateWifNetwork(TESTNET_WIF_PREFIX, 'mainnet')).toBe(false)
    expect(validateWifNetwork(MAINNET_WIF_PREFIX, 'mainnet')).toBe(true)
  })
})

describe('hex helpers', () => {
  it('round-trips bytes through hex', () => {
    expect(hexToBytes(KEY_HEX)).toEqual(KEY)
    expect(bytesToHex(hexToBytes(KEY_HEX))).toBe(KEY_HEX)
  })

  it('accepts a 0x prefix and surrounding whitespace', () => {
    expect(hexToBytes(`  0x${KEY_HEX} `)).toEqual(KEY)
    expect(isLikelyHex(`0X${KEY_HEX}`)).toBe(true)
  })

  it('rejects malformed hex', () => {
    expect(() => hexToBytes('')).toThrow('Empty')
    expect(() => hexToBytes('abc')).toThrow('even length')
    expect(() => hexToBytes('zz')).toThrow('Invalid hex')
    expect(isLikelyHex(KEY_HEX.slice(0, 62))).toBe(false)
  })
})

describe('parsePrivateKey', () => {
  it('detects WIF and reports the network', () => {
    const parsed = parsePrivateKey(privateKeyToWif(KEY, 'mainnet'))
    expect(parsed.format).toBe('wif')
    expect(parsed.network).toBe('mainnet')
    expect(parsed.privateKey).toEqual(KEY)
  })

  it('detects raw hex', () => {
    const parsed = parsePrivateKey(KEY_HEX)
    expect(parsed.format).toBe('hex')
    expect(parsed.network).toBeUndefined()
    expect(parsed.privateKey).toEqual(KEY)
  })

  it('rejects anything else', () => {
    expect(() => parsePrivateKey('not a key')).toThrow('Invalid private key format')
  })
})
