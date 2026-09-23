/**
 * `dmInvite`: first contact without naming the recipient (docs/DM_V5.md §5.1).
 *
 * A fresh ephemeral key per invite lets the recipient recognise its invites
 * with its own private key alone, and binds the signed sender (`$ownerId`)
 * into `check` so a re-posted copy fails.
 */

import * as secp256k1 from '@noble/secp256k1'
import { ecdhSharedX } from '@/lib/crypto/ecdh'
import { getPublicKey } from '@/lib/crypto/keys'
import { bytesEqual } from '@/lib/bytes'
import { assertIdentityId, dmHkdf } from './kdf'
import type { DmInvite, IdentityId } from './types'

export const EPK_LENGTH = 33
export const CHECK_LENGTH = 16
export const MAX_BUCKET_LEVEL = 2
/** `B`: network-wide invites/day at which a 30-day catch-up takes about 10 s (§5.1.2). */
export const BUCKET_SPLIT_VOLUME = 900

/** `bucket(R, k) = (1 << k) | (HKDF(R, "bucket\0")[0:2] >> (16 − k))`, as a u16. `k = 0` gives 1. */
export function bucketFor(recipientId: IdentityId, k: number): number {
  if (!Number.isInteger(k) || k < 0 || k > MAX_BUCKET_LEVEL) throw new Error(`Bucket level out of range: ${k}`)
  assertIdentityId(recipientId)
  const prefix = dmHkdf(recipientId, 'bucket')
  const top16 = (prefix[0] << 8) | prefix[1]
  return (1 << k) | (top16 >>> (16 - k))
}

/** The buckets a recipient scans, one per level, always all three: `[1, 2|p1, 4|p2]`. */
export function bucketLevels(recipientId: IdentityId): number[] {
  return Array.from({ length: MAX_BUCKET_LEVEL + 1 }, (_, k) => bucketFor(recipientId, k))
}

/** Invites/day the sender itself saw at each of its bucket levels, averaged over the last 30 days. */
export interface ObservedInviteRates {
  level0: number
  level1: number
  level2: number
}

/**
 * The sender's bucket level: `k = clamp(ceil(log2(V / B)), 0, 2)` with
 * `V ≈ n0 + 2·n1 + 4·n2`. No scan history (null) gives `k = 0`.
 */
export function senderBucketLevel(observed: ObservedInviteRates | null, splitVolume = BUCKET_SPLIT_VOLUME): number {
  if (!observed) return 0
  const volume = observed.level0 + 2 * observed.level1 + 4 * observed.level2
  if (!(volume > 0)) return 0
  const k = Math.ceil(Math.log2(volume / splitVolume))
  return Math.min(MAX_BUCKET_LEVEL, Math.max(0, k))
}

function inviteCheck(sharedX: Uint8Array, senderId: IdentityId, epk: Uint8Array): Uint8Array {
  assertIdentityId(senderId, 'sender id')
  return dmHkdf(sharedX, 'invite', senderId, epk).slice(0, CHECK_LENGTH)
}

export interface CreateInviteParams {
  recipientPublicKey: Uint8Array
  recipientId: IdentityId
  /** The inviter: the invite's `$ownerId`. */
  senderId: IdentityId
  bucketLevel: number
  /** The ephemeral scalar `e`. Random unless given (test vectors only). */
  ephemeralPrivateKey?: Uint8Array
}

/** Build the fields of a `dmInvite` from sender to recipient. */
export function createInvite(params: CreateInviteParams): DmInvite {
  const e = params.ephemeralPrivateKey ?? secp256k1.utils.randomSecretKey()
  const epk = getPublicKey(e)
  return {
    bucket: bucketFor(params.recipientId, params.bucketLevel),
    epk,
    check: inviteCheck(ecdhSharedX(e, params.recipientPublicKey), params.senderId, epk),
  }
}

/**
 * True when the invite is addressed to the holder of `recipientPrivateKey`
 * and was written by `senderId` (the document's `$ownerId`). A malformed
 * `epk` is simply "not mine".
 */
export function isInviteForMe(recipientPrivateKey: Uint8Array, invite: DmInvite, senderId: IdentityId): boolean {
  if (invite.epk.length !== EPK_LENGTH || invite.check.length !== CHECK_LENGTH) return false
  let sharedX: Uint8Array
  try {
    sharedX = ecdhSharedX(recipientPrivateKey, invite.epk)
  } catch {
    return false
  }
  return bytesEqual(inviteCheck(sharedX, senderId, invite.epk), invite.check)
}
