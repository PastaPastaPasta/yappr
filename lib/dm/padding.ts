/**
 * Size-class padding and field splitting (docs/DM_V5.md §5.5, §5.7).
 *
 * A padded plaintext is `u16 length | plaintext | zeros`, exactly one class
 * long. The class is the padded plaintext size, so a sealed blob is the class
 * plus AES-GCM's 28 bytes (12-byte IV, 16-byte tag): the smallest blob is
 * 128 + 28 = 156 bytes, the contract's minimum field size.
 */

import { concat } from './kdf'

export const AES_GCM_OVERHEAD = 28
export const FIELD_MAX = 5120

/** Message classes, Phase 1: one `body` field. Rosters use the same classes. */
export const MESSAGE_CLASSES: readonly number[] = [128, 256, 512, 1024, 2048, 4096]

/** Largest self-state class: whatever fills `blob`/`blob2`/`blob3` exactly once sealed. */
export const SELF_STATE_MAX_CLASS = 3 * FIELD_MAX - AES_GCM_OVERHEAD

/** Self-state classes: powers of two, then one class that fills three fields. */
export const SELF_STATE_CLASSES: readonly number[] = [128, 256, 512, 1024, 2048, 4096, 8192, SELF_STATE_MAX_CLASS]

const LENGTH_PREFIX = 2

/** The smallest class that holds `length` plaintext bytes, or null if none does. */
export function sizeClassFor(length: number, classes: readonly number[]): number | null {
  return classes.find((size) => size >= length + LENGTH_PREFIX) ?? null
}

/** The largest plaintext that fits the given classes. */
export function maxPlaintextLength(classes: readonly number[]): number {
  return classes[classes.length - 1] - LENGTH_PREFIX
}

/** `u16 length | plaintext | zeros`, padded to the smallest class that fits. Throws if none does. */
export function pad(plaintext: Uint8Array, classes: readonly number[]): Uint8Array {
  const size = sizeClassFor(plaintext.length, classes)
  if (size === null) throw new Error(`Plaintext too long: ${plaintext.length} bytes`)
  const out = new Uint8Array(size)
  out[0] = plaintext.length >>> 8
  out[1] = plaintext.length & 0xff
  out.set(plaintext, LENGTH_PREFIX)
  return out
}

/** Reverse `pad`. Throws on a bad length or non-zero padding. */
export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < LENGTH_PREFIX) throw new Error('Padded data too short')
  const length = (padded[0] << 8) | padded[1]
  const end = LENGTH_PREFIX + length
  if (end > padded.length) throw new Error('Padded length exceeds data')
  for (let i = end; i < padded.length; i++) {
    if (padded[i] !== 0) throw new Error('Non-zero padding')
  }
  return padded.slice(LENGTH_PREFIX, end)
}

/** Split a sealed blob across up to `maxFields` document fields of at most `FIELD_MAX` bytes. */
export function splitFields(blob: Uint8Array, maxFields = 3): Uint8Array[] {
  if (blob.length === 0) throw new Error('Nothing to split')
  if (blob.length > maxFields * FIELD_MAX) throw new Error(`Blob too long for ${maxFields} fields: ${blob.length} bytes`)
  const fields: Uint8Array[] = []
  for (let offset = 0; offset < blob.length; offset += FIELD_MAX) {
    fields.push(blob.slice(offset, offset + FIELD_MAX))
  }
  return fields
}

/** Reassemble fields written by `splitFields`. Every field but the last must be full. */
export function joinFields(fields: Uint8Array[]): Uint8Array {
  if (fields.length === 0) throw new Error('No fields')
  fields.slice(0, -1).forEach((field) => {
    if (field.length !== FIELD_MAX) throw new Error('A non-final field is not full')
  })
  return concat(...fields)
}
