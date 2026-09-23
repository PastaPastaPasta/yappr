/**
 * Per-sender message streams (docs/DM_V5.md §6.1, §6.2).
 *
 * Each sender has a stream per conversation epoch. Tags are one-time,
 * pseudorandom values indexed by week and a counter that restarts each week.
 * The body carries a back-link (`prev`) to the sender's previous message.
 */

import { ByteReader, KEY_LENGTH, assertIdentityId, assertLength, concat, decodeUtf8, dmHkdf, s16, u32 } from './kdf'
import { GID_LENGTH, epochBefore } from './keys'
import { MESSAGE_CLASSES } from './padding'
import { openPadded, sealPadded } from './seal'
import type { DmContent, DmPlaintext, GroupGrant, IdentityId, MessagePointer } from './types'

export const TAG_LENGTH = 16
export const PREV_LENGTH = 12

export const MessageType = {
  TEXT: 0x01,
  LEAVE: 0x02,
  GRANT: 0x05,
} as const

const MESSAGE_AAD_PREFIX = new TextEncoder().encode('yappr/dm/msg/v5')
const GRANT_LENGTH = GID_LENGTH + 2 + 2 + KEY_LENGTH

/** The `ownerId` of a 1:1 stream: 32 zero bytes. */
export const DIRECT_OWNER_ID: IdentityId = new Uint8Array(32)

/**
 * `SK = HKDF(K, "stream\0" || ownerId || senderId)`. `ownerId` is the group
 * owner (`DIRECT_OWNER_ID` for a 1:1), so a member who re-posts a roster under
 * their own id gets streams that never touch the real group's.
 */
export function deriveStreamKey(conversationKey: Uint8Array, ownerId: IdentityId, senderId: IdentityId): Uint8Array {
  assertIdentityId(ownerId, 'owner id')
  assertIdentityId(senderId, 'sender id')
  return dmHkdf(conversationKey, 'stream', ownerId, senderId)
}

/** `tag[w,j] = HKDF(SK, "tag\0" || U32(w) || U32(j))[0:16]`. */
export function messageTag(streamKey: Uint8Array, w: number, j: number): Uint8Array {
  return dmHkdf(streamKey, 'tag', u32(w), u32(j)).slice(0, TAG_LENGTH)
}

/** `mk[w,j] = HKDF(SK, "msg\0" || U32(w) || U32(j))`. */
export function messageKey(streamKey: Uint8Array, w: number, j: number): Uint8Array {
  return dmHkdf(streamKey, 'msg', u32(w), u32(j))
}

/** `"yappr/dm/msg/v5" || tag || senderId`. */
export function messageAad(tag: Uint8Array, senderId: IdentityId): Uint8Array {
  assertIdentityId(senderId, 'sender id')
  return concat(MESSAGE_AAD_PREFIX, tag, senderId)
}

/** `U32(w) | S16(b) | S16(r) | U32(j)`; all zeros for "no previous message". */
export function encodePrev(prev: MessagePointer | null): Uint8Array {
  if (!prev) return new Uint8Array(PREV_LENGTH)
  return concat(u32(prev.w), s16(prev.b), s16(prev.r), u32(prev.j))
}

/**
 * Decode `prev`; all zeros is null. The pointer (w = 0, b = 0, r = 0, j = 0)
 * is 1970's first message and never a real one, so zero is unambiguous.
 */
export function decodePrev(bytes: Uint8Array): MessagePointer | null {
  assertLength(bytes, PREV_LENGTH, 'prev')
  if (bytes.every((byte) => byte === 0)) return null
  const reader = new ByteReader(bytes)
  const w = reader.u32()
  const b = reader.u16()
  const r = reader.u16()
  const j = reader.u32()
  return { w, b, r, j }
}

/**
 * True when `prev` points strictly before `current` in the sender's stream:
 * an earlier epoch, or the same epoch and an earlier `(w, j)`. That is the
 * lexicographic order on `(b, r, w, j)`. A `prev` that fails this is attacker-
 * or clock-supplied and must not drive a backfill (§6.3).
 */
export function isStrictlyBefore(prev: MessagePointer, current: MessagePointer): boolean {
  if (prev.b !== current.b || prev.r !== current.r) return epochBefore(prev, current)
  return prev.w !== current.w ? prev.w < current.w : prev.j < current.j
}

/** `gid | S16(b) | S16(r) | K[b,r]`. */
export function encodeGrant(grant: GroupGrant): Uint8Array {
  assertLength(grant.gid, GID_LENGTH, 'gid')
  assertLength(grant.key, KEY_LENGTH, 'Group key')
  return concat(grant.gid, s16(grant.b), s16(grant.r), grant.key)
}

export function decodeGrant(bytes: Uint8Array): GroupGrant {
  assertLength(bytes, GRANT_LENGTH, 'Grant')
  const reader = new ByteReader(bytes)
  const gid = reader.bytesOf(GID_LENGTH)
  const b = reader.u16()
  const r = reader.u16()
  return { gid, b, r, key: reader.bytesOf(KEY_LENGTH) }
}

/** `type | payload`. */
export function encodeContent(content: DmContent): Uint8Array {
  switch (content.type) {
    case 'text':
      return concat(new Uint8Array([MessageType.TEXT]), new TextEncoder().encode(content.text))
    case 'leave':
      return new Uint8Array([MessageType.LEAVE])
    case 'grant':
      return concat(new Uint8Array([MessageType.GRANT]), encodeGrant(content.grant))
    case 'unknown':
      if (!Number.isInteger(content.code) || content.code < 0 || content.code > 0xff) throw new Error('Type code must be a byte')
      return concat(new Uint8Array([content.code]), content.payload)
  }
}

export function decodeContent(bytes: Uint8Array): DmContent {
  const reader = new ByteReader(bytes)
  const code = reader.u8()
  const payload = reader.rest()
  switch (code) {
    case MessageType.TEXT:
      return { type: 'text', text: decodeUtf8(payload) }
    case MessageType.LEAVE:
      if (payload.length !== 0) throw new Error('Leave carries no payload')
      return { type: 'leave' }
    case MessageType.GRANT:
      return { type: 'grant', grant: decodeGrant(payload) }
    default:
      return { type: 'unknown', code, payload }
  }
}

/** `prev | type | payload`. */
export function encodePlaintext(message: DmPlaintext): Uint8Array {
  return concat(encodePrev(message.prev), encodeContent(message.content))
}

export function decodePlaintext(bytes: Uint8Array): DmPlaintext {
  if (bytes.length < PREV_LENGTH + 1) throw new Error('Message too short')
  return {
    prev: decodePrev(bytes.slice(0, PREV_LENGTH)),
    content: decodeContent(bytes.slice(PREV_LENGTH)),
  }
}

export interface StreamPosition {
  streamKey: Uint8Array
  senderId: IdentityId
  w: number
  j: number
}

export interface EncryptedMessage {
  tag: Uint8Array
  body: Uint8Array
}

/** The `dmMessage` fields for message `(w, j)` of a stream. */
export async function encryptMessage(position: StreamPosition, message: DmPlaintext): Promise<EncryptedMessage> {
  const tag = messageTag(position.streamKey, position.w, position.j)
  const body = await sealPadded(
    messageKey(position.streamKey, position.w, position.j),
    encodePlaintext(message),
    MESSAGE_CLASSES,
    messageAad(tag, position.senderId)
  )
  return { tag, body }
}

/**
 * Decrypt message `(w, j)` of a stream. The caller must already have checked
 * that the document's `$ownerId` is `senderId`. Throws on any failure.
 */
export async function decryptMessage(position: StreamPosition, body: Uint8Array): Promise<DmPlaintext> {
  const tag = messageTag(position.streamKey, position.w, position.j)
  const plaintext = await openPadded(messageKey(position.streamKey, position.w, position.j), body, messageAad(tag, position.senderId))
  return decodePlaintext(plaintext)
}

/**
 * `decryptMessage`, but null instead of a throw, for the receive path: a body
 * that fails to decrypt, or decrypts to malformed content, is dropped.
 */
export async function tryDecryptMessage(position: StreamPosition, body: Uint8Array): Promise<DmPlaintext | null> {
  try {
    return await decryptMessage(position, body)
  } catch {
    return null
  }
}
