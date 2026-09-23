/**
 * Group documents: handles, keyrings and rosters (docs/DM_V5.md §4.5, §5.2–§5.4).
 *
 * All of a group's `dmGroupDoc`s are owned by the group owner and told apart
 * by handles only members can compute. A keyring hands a new base key to the
 * remaining members; the roster holds the current epoch, name and members.
 */

import { ecdhSharedX } from '@/lib/crypto/ecdh'
import { bytesEqual } from '@/lib/bytes'
import { ByteReader, IDENTITY_ID_LENGTH, KEY_LENGTH, assertIdentityId, assertLength, concat, decodeUtf8, dmHkdf, s16 } from './kdf'
import { GID_LENGTH, KEY_CHECK_LENGTH, keyCheck, ratchetKey } from './keys'
import { MESSAGE_CLASSES } from './padding'
import { sealPadded, tryOpenPadded } from './seal'
import type { Epoch, IdentityId, KeyringMember, OpenedRoster, RosterContent } from './types'

export const HANDLE_LENGTH = 10
export const SLOT_LENGTH = 32
export const MIN_KEYRING_SLOTS = 8
export const MAX_KEYRING_SLOTS = 128
/** 100 members including the owner (§6.4). */
export const MAX_GROUP_MEMBERS = 100

const MAX_RATCHET_STEP = 0xffff

// ---------------------------------------------------------------------------
// Handles (§5.2)

/** `roster(g) = HKDF(gid, "roster\0")[0:10]`. */
export function rosterHandle(gid: Uint8Array): Uint8Array {
  return dmHkdf(gid, 'roster').slice(0, HANDLE_LENGTH)
}

/** `keyring(g, b) = HKDF(gid, "keyring\0" || S16(b))[0:10]`. */
export function keyringHandle(gid: Uint8Array, b: number): Uint8Array {
  return dmHkdf(gid, 'keyring', s16(b)).slice(0, HANDLE_LENGTH)
}

// ---------------------------------------------------------------------------
// Keyring slots (§4.5, §5.3)

export interface SlotContext {
  /** My encryption private key: the owner's when wrapping, the member's when unwrapping. */
  myPrivateKey: Uint8Array
  /** The other side's encryption public key. */
  otherPublicKey: Uint8Array
  gid: Uint8Array
  ownerId: IdentityId
  memberId: IdentityId
  b: number
}

/** `pad = HKDF(ECDH_x(owner, member), "slot\0" || gid || ownerId || memberId || S16(b))`. Symmetric in who computes it. */
export function slotPad(ctx: SlotContext): Uint8Array {
  assertIdentityId(ctx.ownerId, 'owner id')
  assertIdentityId(ctx.memberId, 'member id')
  const sharedX = ecdhSharedX(ctx.myPrivateKey, ctx.otherPublicKey)
  return dmHkdf(sharedX, 'slot', ctx.gid, ctx.ownerId, ctx.memberId, s16(ctx.b))
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  return a.map((byte, i) => byte ^ b[i])
}

/** The slot count for `members` real slots: the next power of two in 8..128. */
export function keyringSlotCount(members: number): number {
  if (members > MAX_KEYRING_SLOTS) throw new Error(`Too many keyring members: ${members}`)
  let slots = MIN_KEYRING_SLOTS
  while (slots < members) slots *= 2
  return slots
}

function randomBelow(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buf = new Uint32Array(1)
  do {
    crypto.getRandomValues(buf)
  } while (buf[0] >= limit)
  return buf[0] % n
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export interface BuildKeyringParams {
  ownerPrivateKey: Uint8Array
  ownerId: IdentityId
  gid: Uint8Array
  b: number
  /** `K[b,0]`. */
  baseKey: Uint8Array
  /** Every remaining member except the owner. */
  members: KeyringMember[]
}

/** `kc(K[b,0]) | slot | slot | …`, padded with random slots to 8..128 and shuffled. */
export function buildKeyring(params: BuildKeyringParams): Uint8Array {
  assertLength(params.baseKey, KEY_LENGTH, 'Base key')
  if (params.members.length > MAX_GROUP_MEMBERS - 1) throw new Error(`Too many keyring members: ${params.members.length}`)
  const real = params.members.map((member) =>
    xor(
      params.baseKey,
      slotPad({
        myPrivateKey: params.ownerPrivateKey,
        otherPublicKey: member.publicKey,
        gid: params.gid,
        ownerId: params.ownerId,
        memberId: member.id,
        b: params.b,
      })
    )
  )
  const filler = Array.from({ length: keyringSlotCount(real.length) - real.length }, () =>
    crypto.getRandomValues(new Uint8Array(SLOT_LENGTH))
  )
  return concat(keyCheck(params.baseKey), ...shuffle([...real, ...filler]))
}

/**
 * Find the slot `ctx` unwraps to a key matching the keyring's `kc`, and
 * return `K[b,0]`; null when there is none (the member was removed). The
 * owner runs the same check to learn who holds a slot (§6.5).
 */
export function openKeyringSlot(keyring: Uint8Array, ctx: SlotContext): Uint8Array | null {
  const body = keyring.length - KEY_CHECK_LENGTH
  if (body <= 0 || body % SLOT_LENGTH !== 0) return null
  const expected = keyring.slice(0, KEY_CHECK_LENGTH)
  const pad = slotPad(ctx)
  for (let offset = KEY_CHECK_LENGTH; offset < keyring.length; offset += SLOT_LENGTH) {
    const candidate = xor(keyring.slice(offset, offset + SLOT_LENGTH), pad)
    if (bytesEqual(keyCheck(candidate), expected)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// Roster (§5.4)

/** `S16 b | S16 r | u8 ended | u16 len | name | u16 len | avatarRef | u8 count | 32-byte ids`. */
export function encodeRoster(roster: RosterContent): Uint8Array {
  if (roster.members.length > MAX_GROUP_MEMBERS) throw new Error(`Too many members: ${roster.members.length}`)
  roster.members.forEach((id) => assertIdentityId(id, 'member id'))
  const name = new TextEncoder().encode(roster.name)
  const avatarRef = new TextEncoder().encode(roster.avatarRef)
  return concat(
    s16(roster.b),
    s16(roster.r),
    new Uint8Array([roster.ended ? 1 : 0]),
    s16(name.length),
    name,
    s16(avatarRef.length),
    avatarRef,
    new Uint8Array([roster.members.length]),
    ...roster.members
  )
}

export function decodeRoster(bytes: Uint8Array): RosterContent {
  const reader = new ByteReader(bytes)
  const b = reader.u16()
  const r = reader.u16()
  const endedByte = reader.u8()
  if (endedByte > 1) throw new Error('Invalid ended flag')
  const name = decodeUtf8(reader.bytesOf(reader.u16()))
  const avatarRef = decodeUtf8(reader.bytesOf(reader.u16()))
  const count = reader.u8()
  if (count > MAX_GROUP_MEMBERS) throw new Error('Too many members')
  const members = Array.from({ length: count }, () => reader.bytesOf(IDENTITY_ID_LENGTH))
  reader.end()
  return { b, r, name, avatarRef, members, ended: endedByte === 1 }
}

/** `HKDF(K[b,r], "roster\0")`. */
export function rosterKey(epochKey: Uint8Array): Uint8Array {
  return dmHkdf(epochKey, 'roster')
}

/** `iv | AES-256-GCM(HKDF(K[b,r], "roster\0"), pad(roster), aad = handle)`. `epochKey` must be `K[roster.b, roster.r]`. */
export async function encryptRoster(epochKey: Uint8Array, gid: Uint8Array, roster: RosterContent): Promise<Uint8Array> {
  assertLength(gid, GID_LENGTH, 'gid')
  return sealPadded(rosterKey(epochKey), encodeRoster(roster), MESSAGE_CLASSES, rosterHandle(gid))
}

export interface OpenRosterParams {
  blob: Uint8Array
  gid: Uint8Array
  /** The newest key the reader holds for the current base, and its epoch. */
  known: Epoch & { key: Uint8Array }
  /** How many ratchet steps past `known` to try: `$revision − last seen $revision` (§5.4). */
  maxSteps: number
}

/**
 * Decrypt a roster by trying `K[b,r]`, `K[b,r+1]`, … up to `maxSteps` steps
 * ahead. A roster whose content claims a different epoch from the key that
 * opened it, or that does not parse, is rejected. Null if nothing within the
 * bound decrypts.
 */
export async function openRoster(params: OpenRosterParams): Promise<OpenedRoster | null> {
  if (!Number.isInteger(params.maxSteps) || params.maxSteps < 0) throw new Error('maxSteps must be a non-negative integer')
  const { b } = params.known
  const aad = rosterHandle(params.gid)
  const lastR = Math.min(params.known.r + params.maxSteps, MAX_RATCHET_STEP)
  let key = params.known.key
  for (let r = params.known.r; r <= lastR; r++) {
    if (r > params.known.r) key = ratchetKey(key, b, r)
    const plaintext = await tryOpenPadded(rosterKey(key), params.blob, aad)
    if (plaintext) {
      const content = decodeRosterOrNull(plaintext)
      return content?.b === b && content.r === r ? { content, key } : null
    }
  }
  return null
}

function decodeRosterOrNull(bytes: Uint8Array): RosterContent | null {
  try {
    return decodeRoster(bytes)
  } catch {
    return null
  }
}
