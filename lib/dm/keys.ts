/**
 * DM v5 key schedule (docs/DM_V5.md §4.2–§4.4).
 *
 * 1:1 keys come from static ECDH on the two ENCRYPTION keys, so nothing is
 * stored or sent. Group keys come from the owner: a per-group secret `S`,
 * a base key per removal and a one-way ratchet per add.
 */

import { ecdhSharedX } from '@/lib/crypto/ecdh'
import { bytesEqual } from '@/lib/bytes'
import { assertIdentityId, assertLength, dmHkdf, s16, u32 } from './kdf'
import type { Epoch, IdentityId } from './types'

export const GID_LENGTH = 10
export const KEY_CHECK_LENGTH = 8
/** Random bytes stored in keyring `b` and mixed into `K[b,0]` for `b ≥ 1` (§4.4). */
export const BASE_NONCE_LENGTH = 16

/** True when epoch `a` is older than epoch `b`: lower base, or same base and lower ratchet step. */
export function epochBefore(a: Epoch, b: Epoch): boolean {
  return a.b !== b.b ? a.b < b.b : a.r < b.r
}

/** Byte-order comparison of two identity ids. */
export function compareIds(a: IdentityId, b: IdentityId): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/** `selfRoot = HKDF(encPriv, "self\0")` (§4.2). */
export function deriveSelfRoot(encPriv: Uint8Array): Uint8Array {
  return dmHkdf(encPriv, 'self')
}

/** `stateKey = HKDF(selfRoot, "state-key\0")`: the root of the self-state encryption key (§5.5). */
export function deriveStateKey(selfRoot: Uint8Array): Uint8Array {
  return dmHkdf(selfRoot, 'state-key')
}

export interface DirectKeys {
  gid: Uint8Array
  key: Uint8Array
}

/**
 * The 1:1 keys (§4.3). Either side computes the same values:
 * `Z = ECDH_x(myPriv, peerPub)`, `gid = HKDF(Z, "direct-id\0" || id_lo || id_hi)[0:10]`,
 * `K = HKDF(Z, "direct-key\0" || gid)`.
 */
export function deriveDirectKeys(
  myPriv: Uint8Array,
  peerPub: Uint8Array,
  myId: IdentityId,
  peerId: IdentityId
): DirectKeys {
  assertIdentityId(myId)
  assertIdentityId(peerId)
  if (bytesEqual(myId, peerId)) throw new Error('A 1:1 conversation needs two different identities')
  const z = ecdhSharedX(myPriv, peerPub)
  const [lo, hi] = compareIds(myId, peerId) < 0 ? [myId, peerId] : [peerId, myId]
  const gid = dmHkdf(z, 'direct-id', lo, hi).slice(0, GID_LENGTH)
  return { gid, key: dmHkdf(z, 'direct-key', gid) }
}

/** `gid_n = HKDF(selfRoot_owner, "group\0" || U32(n))[0:10]`: the owner's n-th group (§4.4). */
export function deriveGroupId(selfRoot: Uint8Array, n: number): Uint8Array {
  return dmHkdf(selfRoot, 'group', u32(n)).slice(0, GID_LENGTH)
}

/** `S = HKDF(encPriv_owner, "group-secret\0" || gid)`. Never leaves the owner. */
export function deriveGroupSecret(ownerEncPriv: Uint8Array, gid: Uint8Array): Uint8Array {
  return dmHkdf(ownerEncPriv, 'group-secret', gid)
}

/**
 * `K[0,0] = HKDF(S, "base\0" || S16(0))` at creation;
 * `K[b,0] = HKDF(S, "base\0" || S16(b) || nonce_b)` for each later base, with
 * `nonce_b` read from keyring `b`. The nonce means a keyring rejected in an
 * owner-device race wraps a key nobody uses.
 */
export function deriveBaseKey(groupSecret: Uint8Array, b: number, nonce?: Uint8Array): Uint8Array {
  if (b === 0) {
    if (nonce) throw new Error('Base 0 takes no nonce')
    return dmHkdf(groupSecret, 'base', s16(0))
  }
  if (!nonce) throw new Error(`Base ${b} needs its keyring nonce`)
  assertLength(nonce, BASE_NONCE_LENGTH, 'Base nonce')
  return dmHkdf(groupSecret, 'base', s16(b), nonce)
}

/** One ratchet step: `K[b,r] = HKDF(K[b,r−1], "ratchet\0" || S16(b) || S16(r))`, where `r` is the new step. */
export function ratchetKey(previous: Uint8Array, b: number, r: number): Uint8Array {
  if (r < 1) throw new Error('Ratchet step must be at least 1')
  return dmHkdf(previous, 'ratchet', s16(b), s16(r))
}

/** Step `K[b, from]` forward to `K[b, to]`. Keys never step back. */
export function ratchetTo(key: Uint8Array, b: number, from: number, to: number): Uint8Array {
  if (to < from) throw new Error('Cannot ratchet backwards')
  let current = key
  for (let r = from + 1; r <= to; r++) current = ratchetKey(current, b, r)
  return current
}

/** `K[b,r]` for the owner, from `S` (and keyring `b`'s nonce for `b ≥ 1`). */
export function deriveEpochKey(groupSecret: Uint8Array, b: number, r: number, nonce?: Uint8Array): Uint8Array {
  return ratchetTo(deriveBaseKey(groupSecret, b, nonce), b, 0, r)
}

/** `kc(K) = HKDF(K, "kc\0")[0:8]`: identifies a key without revealing it. */
export function keyCheck(key: Uint8Array): Uint8Array {
  return dmHkdf(key, 'kc').slice(0, KEY_CHECK_LENGTH)
}
