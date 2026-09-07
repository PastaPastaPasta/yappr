/**
 * Byte codecs shared by every layer that talks to Platform or Web Crypto.
 *
 * Platform surfaces binary fields in several shapes depending on the path the
 * value took: `Uint8Array` from typed SDK objects, `number[]` after a JSON
 * round trip, base64 strings from `toJSON()`, and hex strings from the wasm
 * identity-key getters. Everything that needs bytes should go through
 * `normalizeBytes` (lenient, `null` on failure) or `requireBytes` (throws), and
 * everything that produces a string should use the explicit encoders here.
 */

const HEX_PATTERN = /^[0-9a-fA-F]*$/

/**
 * A `Uint8Array` known to sit on a plain (non-shared) `ArrayBuffer`. Web Crypto
 * and `Blob` accept only this variant, so the decoders return it and callers
 * can hand the result straight to `crypto.subtle` without a cast.
 */
type Bytes = Uint8Array<ArrayBuffer>

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Decode standard base64. Throws on malformed input. */
export function base64ToBytes(base64: string): Bytes {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** Base64url without padding, as used in URLs and fragment identifiers. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

/** True for an even-length string of hex digits (an optional 0x prefix is allowed). */
export function isHexString(value: string): boolean {
  const hex = stripHexPrefix(value)
  return hex.length > 0 && hex.length % 2 === 0 && HEX_PATTERN.test(hex)
}

/** Decode hex (optional 0x prefix, surrounding whitespace ignored). Throws on malformed input. */
export function hexToBytes(hex: string): Bytes {
  const clean = stripHexPrefix(hex)
  if (clean.length === 0) {
    throw new Error('Empty hex string')
  }
  if (clean.length % 2 !== 0) {
    throw new Error('Hex string must have even length')
  }
  if (!HEX_PATTERN.test(clean)) {
    throw new Error('Invalid hex characters')
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return bytes
}

function stripHexPrefix(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Coerce any of the byte shapes Platform hands back into a `Uint8Array`.
 *
 * Accepts `Uint8Array`, `number[]`, a JSON-serialized Node `Buffer`
 * (`{ type: 'Buffer', data: number[] }`), and strings. Strings are tried as
 * hex first, then base64: hex-encoded key data (66 or 130 characters) is also
 * a syntactically valid base64 string, but decoding it as base64 yields
 * garbage, whereas real base64 of random bytes is never all hex digits.
 *
 * Returns `null` when the value is none of these or fails to decode.
 */
export function normalizeBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value
  }
  if (Array.isArray(value)) {
    return value.every((n) => typeof n === 'number') ? new Uint8Array(value) : null
  }
  if (value && typeof value === 'object' && 'type' in value && 'data' in value) {
    const bufferLike = value as { type: unknown; data: unknown }
    if (bufferLike.type === 'Buffer' && Array.isArray(bufferLike.data)) {
      return normalizeBytes(bufferLike.data)
    }
    return null
  }
  if (typeof value === 'string') {
    if (isHexString(value)) {
      return hexToBytes(value)
    }
    try {
      return base64ToBytes(value)
    } catch {
      return null
    }
  }
  return null
}

/** `normalizeBytes`, but a decode failure is an error rather than a `null`. */
export function requireBytes(value: unknown, label: string): Uint8Array {
  const bytes = normalizeBytes(value)
  if (!bytes) {
    throw new Error(`${label}: expected bytes, got ${describe(value)}`)
  }
  return bytes
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return `string(${value.length})`
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}
