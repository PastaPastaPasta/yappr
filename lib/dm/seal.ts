/**
 * The one sealed-blob format DM v5 uses for messages, rosters and the
 * self-state: `iv | AES-256-GCM(key, pad(plaintext), aad)`, with a fresh
 * random IV every time (docs/DM_V5.md §4.1).
 */

import { AES_GCM_IV_LENGTH, aesGcmOpen, aesGcmSeal, importAesKey } from '@/lib/crypto/aes-gcm'
import { concat } from './kdf'
import { pad, unpad } from './padding'

/** Pad `plaintext` to a class and seal it under the raw 32-byte `key`. */
export async function sealPadded(
  key: Uint8Array,
  plaintext: Uint8Array,
  classes: readonly number[],
  aad?: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await importAesKey(key, ['encrypt'])
  const { iv, ciphertext } = await aesGcmSeal(cryptoKey, pad(plaintext, classes), { aad })
  return concat(iv, ciphertext)
}

/** Open a blob written by `sealPadded`. Throws on a wrong key, wrong AAD, tampering or bad padding. */
export async function openPadded(key: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (blob.length <= AES_GCM_IV_LENGTH) throw new Error('Sealed blob too short')
  const cryptoKey = await importAesKey(key, ['decrypt'])
  const padded = await aesGcmOpen(cryptoKey, blob.slice(AES_GCM_IV_LENGTH), blob.slice(0, AES_GCM_IV_LENGTH), aad)
  return unpad(padded)
}

/** `openPadded`, but null instead of a throw: for trial decryption. */
export async function tryOpenPadded(key: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Promise<Uint8Array | null> {
  try {
    return await openPadded(key, blob, aad)
  } catch {
    return null
  }
}
