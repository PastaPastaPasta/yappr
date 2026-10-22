/**
 * Charter keys: the keys join requests (and resignation requests) are
 * encrypted between. A leader holds a DECRYPTION key bound to the charters
 * contract's `submittedCharter` type, a member an ENCRYPTION key bound to its
 * `joinRequest` type (rules.mjs `CHARTER_KEYS`).
 *
 * Yappr makes a charter key from the account's MASTER key, so the same master
 * key gives back the same charter key in any browser and nothing has to be
 * saved: HKDF-SHA256 of the master private key, salted with the identity and
 * labelled with the key's purpose and document type. A charter key made
 * elsewhere (the release CLI writes random ones to a key file) is given as is.
 *
 * Every private key here lives in this module's memory only: never in
 * localStorage, sessionStorage or IndexedDB, never logged, gone on reload,
 * sign-out or a switch of account (`forgetCharterKeys`).
 */
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import * as secp256k1 from '@noble/secp256k1'
import { bytesEqual } from '@/lib/bytes'
import { parsePrivateKey } from '@/lib/crypto/wif'
import { CHARTER_KEYS } from './rules.mjs'

export type CharterRole = keyof typeof CHARTER_KEYS

const INFO = 'yappr/charter-key/v1'

/** The charter key of `role` that `masterPrivateKey` gives `identityId`. */
export function deriveCharterKey(masterPrivateKey: Uint8Array, identityId: string, role: CharterRole): Uint8Array {
  if (masterPrivateKey.length !== 32) throw new Error('A master key is 32 bytes')
  const { purpose, documentType } = CHARTER_KEYS[role]
  const salt = sha256(new TextEncoder().encode(identityId))
  // A scalar outside the curve's order (about 1 in 2^128) moves on to the next counter.
  for (let counter = 0; ; counter++) {
    const key = hkdf(sha256, masterPrivateKey, salt, new TextEncoder().encode(`${INFO}:${purpose}:${documentType}:${counter}`), 32)
    if (secp256k1.utils.isValidSecretKey(key)) return key
  }
}

/**
 * The private key in what someone typed or pasted: a WIF, 64 hex digits, or
 * the release CLI's key file (`{ "identityKeys": [{ "privateKeyWif": … }] }`).
 * Throws a plain message when it holds none.
 */
export function readPrivateKeyInput(input: string): Uint8Array {
  const trimmed = input.trim()
  if (trimmed.startsWith('{')) {
    let wif: unknown
    try {
      wif = (JSON.parse(trimmed) as { identityKeys?: Array<{ privateKeyWif?: unknown }> }).identityKeys?.[0]?.privateKeyWif
    } catch {
      throw new Error('That key file could not be read.')
    }
    if (typeof wif !== 'string') throw new Error('That key file holds no key.')
    return readPrivateKeyInput(wif)
  }
  try {
    return parsePrivateKey(trimmed).privateKey
  } catch {
    throw new Error('That is not a private key. Paste it as shown in your wallet (it starts with c, 9, X or 7) or as 64 hex digits.')
  }
}

/** Whether `privateKey`'s public key is `publicKey` (33 bytes, compressed). */
export function keyMatches(privateKey: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return bytesEqual(secp256k1.getPublicKey(privateKey, true), publicKey)
  } catch {
    return false
  }
}

const held = new Map<string, Uint8Array>()
const slot = (identityId: string, role: CharterRole) => `${identityId}:${role}`

/** Holds `identityId`'s charter key of `role` for this tab. The caller has matched it to the identity. */
export function holdCharterKey(identityId: string, role: CharterRole, privateKey: Uint8Array): void {
  held.set(slot(identityId, role), privateKey.slice())
}

/** The charter key of `role` this tab holds for `identityId`, if any (unchecked against the chain). */
export function heldCharterKey(identityId: string, role: CharterRole): Uint8Array | null {
  return held.get(slot(identityId, role))?.slice() ?? null
}

/** Drops every charter key this tab holds, or only `identityId`'s. */
export function forgetCharterKeys(identityId?: string): void {
  for (const [key, value] of [...held]) {
    if (identityId && !key.startsWith(`${identityId}:`)) continue
    value.fill(0)
    held.delete(key)
  }
}
