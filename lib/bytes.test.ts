import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  bytesEqual,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  hexToBytes,
  isHexString,
  normalizeBytes,
  requireBytes,
} from './bytes'

const BYTES = Uint8Array.from([0, 1, 2, 0xfb, 0xff, 0x7e, 0x3f])
const HEX = '000102fbff7e3f'
const B64 = 'AAEC+/9+Pw=='

describe('base64', () => {
  it('round-trips', () => {
    expect(bytesToBase64(BYTES)).toBe(B64)
    expect(base64ToBytes(B64)).toEqual(BYTES)
    expect(base64ToBytes('')).toEqual(new Uint8Array(0))
  })

  it('produces unpadded base64url', () => {
    expect(bytesToBase64Url(BYTES)).toBe('AAEC-_9-Pw')
  })

  it('throws on malformed input', () => {
    expect(() => base64ToBytes('not base64!')).toThrow()
  })
})

describe('hex', () => {
  it('round-trips', () => {
    expect(bytesToHex(BYTES)).toBe(HEX)
    expect(hexToBytes(HEX)).toEqual(BYTES)
    expect(hexToBytes(` 0x${HEX.toUpperCase()} `)).toEqual(BYTES)
  })

  it('classifies hex strings', () => {
    expect(isHexString(HEX)).toBe(true)
    expect(isHexString('0xff')).toBe(true)
    expect(isHexString('')).toBe(false)
    expect(isHexString('abc')).toBe(false)
    expect(isHexString('zz')).toBe(false)
    expect(isHexString(B64)).toBe(false)
  })

  it('throws on malformed input', () => {
    expect(() => hexToBytes('')).toThrow('Empty')
    expect(() => hexToBytes('abc')).toThrow('even length')
    expect(() => hexToBytes('zz')).toThrow('Invalid hex')
  })
})

describe('bytesEqual', () => {
  it('compares contents, not identity', () => {
    expect(bytesEqual(BYTES, Uint8Array.from(BYTES))).toBe(true)
    expect(bytesEqual(BYTES, BYTES.slice(1))).toBe(false)
    expect(bytesEqual(BYTES, BYTES.map((b) => b ^ 1))).toBe(false)
  })
})

describe('normalizeBytes', () => {
  it('passes Uint8Array through untouched', () => {
    expect(normalizeBytes(BYTES)).toBe(BYTES)
  })

  it('accepts number arrays and serialized Buffers', () => {
    expect(normalizeBytes(Array.from(BYTES))).toEqual(BYTES)
    expect(normalizeBytes({ type: 'Buffer', data: Array.from(BYTES) })).toEqual(BYTES)
  })

  it('decodes hex before base64', () => {
    // 66 hex chars is also syntactically valid base64; it must decode as hex.
    const pubkeyHex = '02' + 'ab'.repeat(32)
    expect(normalizeBytes(pubkeyHex)).toEqual(hexToBytes(pubkeyHex))
    expect(normalizeBytes(HEX)).toEqual(BYTES)
    expect(normalizeBytes(B64)).toEqual(BYTES)
  })

  it('returns null for anything else', () => {
    expect(normalizeBytes(undefined)).toBeNull()
    expect(normalizeBytes(null)).toBeNull()
    expect(normalizeBytes(42)).toBeNull()
    expect(normalizeBytes(['a', 'b'])).toBeNull()
    expect(normalizeBytes({ type: 'Other', data: [1] })).toBeNull()
    expect(normalizeBytes('not base64!')).toBeNull()
  })
})

describe('requireBytes', () => {
  it('throws with the label on failure', () => {
    expect(requireBytes(B64, 'nonce')).toEqual(BYTES)
    expect(() => requireBytes(42, 'nonce')).toThrow('nonce: expected bytes, got number')
    expect(() => requireBytes('???', 'seed')).toThrow('seed: expected bytes, got string(3)')
  })
})
