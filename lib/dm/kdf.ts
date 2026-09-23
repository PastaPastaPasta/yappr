/**
 * DM v5 key derivation (docs/DM_V5.md §4.1).
 *
 * Every derivation is HKDF-SHA256 with the fixed salt "yappr/dm/v5" and an
 * `info` of ASCII label || 0x00 || fixed-width fields, so no two derivations
 * share an input. HKDF output is prefix-stable, so a truncated value (`[0:10]`)
 * is the prefix of the 32-byte output.
 */

import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const SALT = new TextEncoder().encode('yappr/dm/v5')
const WEEK_MS = 604_800_000
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

export const KEY_LENGTH = 32
export const IDENTITY_ID_LENGTH = 32

/**
 * Identity ids go into derivations as fixed-width fields; a wrong length
 * would let two different inputs share an `info`, so reject it outright.
 */
export function assertIdentityId(id: Uint8Array, name = 'identity id'): void {
  if (id.length !== IDENTITY_ID_LENGTH) throw new Error(`${name} must be ${IDENTITY_ID_LENGTH} bytes`)
}

/** Strict UTF-8 decode that keeps a leading U+FEFF rather than stripping it. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

/** Concatenate byte arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** `label || NUL || fields`: the `info` input of every DM v5 derivation. */
export function kdfInfo(label: string, ...fields: Uint8Array[]): Uint8Array {
  if (!/^[\x21-\x7e]+$/.test(label)) throw new Error(`Invalid KDF label: ${label}`)
  return concat(new TextEncoder().encode(label), new Uint8Array([0]), ...fields)
}

/** `HKDF(ikm, label\0 || fields)`, 32 bytes. */
export function dmHkdf(ikm: Uint8Array, label: string, ...fields: Uint8Array[]): Uint8Array {
  return hkdf(sha256, ikm, SALT, kdfInfo(label, ...fields), KEY_LENGTH)
}

function assertUint(value: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} out of range: ${value}`)
  }
}

/** Big-endian u16. */
export function s16(value: number): Uint8Array {
  assertUint(value, U16_MAX, 'u16')
  return new Uint8Array([value >>> 8, value & 0xff])
}

/** Big-endian u32. */
export function u32(value: number): Uint8Array {
  assertUint(value, U32_MAX, 'u32')
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

/** Big-endian u64 for a non-negative safe integer (block times in ms). */
export function u64(value: number): Uint8Array {
  assertUint(value, Number.MAX_SAFE_INTEGER, 'u64')
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value))
  return out
}

/** `floor(time_ms / 604,800,000)` as a u32. `timeMs` must be a Platform block time, not the device clock. */
export function weekOf(timeMs: number): number {
  assertUint(timeMs, Number.MAX_SAFE_INTEGER, 'time')
  const week = Math.floor(timeMs / WEEK_MS)
  assertUint(week, U32_MAX, 'week')
  return week
}

/** The first `ms` of week `w`. */
export function weekStart(week: number): number {
  assertUint(week, U32_MAX, 'week')
  return week * WEEK_MS
}

/**
 * A bounds-checked big-endian reader for the binary encodings in this module.
 * Every read throws on a short buffer, so a truncated blob never decodes.
 */
export class ByteReader {
  private offset = 0
  private readonly view: DataView

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  private take(n: number): number {
    if (n > this.remaining) throw new Error('Unexpected end of data')
    const at = this.offset
    this.offset += n
    return at
  }

  bytesOf(n: number): Uint8Array {
    const at = this.take(n)
    return this.bytes.slice(at, at + n)
  }

  u8(): number {
    return this.view.getUint8(this.take(1))
  }

  u16(): number {
    return this.view.getUint16(this.take(2))
  }

  u32(): number {
    return this.view.getUint32(this.take(4))
  }

  u64(): number {
    const value = this.view.getBigUint64(this.take(8))
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('u64 exceeds safe integer range')
    return Number(value)
  }

  rest(): Uint8Array {
    return this.bytesOf(this.remaining)
  }

  /** Throw unless every byte has been consumed. */
  end(): void {
    if (this.remaining !== 0) throw new Error('Trailing data')
  }
}
