/**
 * The moderators' box on a v13 report of a private post or reply
 * (`report.box`, at most 5,120 bytes; docs/SOCIAL_V13.md §4).
 *
 * A private post is ciphertext under its feed's content key (CEK) for one key
 * generation. The moderators cannot read what they are asked to judge unless
 * the reporter, who can, hands them that key. The box does it without
 * trusting anyone else: one random 32-byte key R per report, wrapped to the
 * ENCRYPTION key of every member of the moderation team as it is seated when
 * the report is filed, and R seals the payload. Consensus never reads the box;
 * this module is its only definition.
 *
 * Format, version 1 (all integers big-endian):
 *
 *     box     = version (1 = 0x01) || n (1, 1..MAX) || wrap × n || nonce (12) || sealed
 *     wrap    = hint (4) || ephemeralPub (33, compressed secp256k1) || R ⊕ k (32)
 *     hint    = sha256("yappr/report-box/v1/hint" || recipientPub)[0..4]
 *     k       = HKDF-SHA256(ikm = ECDH x(ephemeralPriv, recipientPub),
 *                           salt = ephemeralPub,
 *                           info = "yappr/report-box/v1/wrap" || recipientPub)
 *     sealed  = AES-256-GCM(key R, nonce, aad, payload) (payload || 16-byte tag)
 *     aad     = "yappr/report-box/v1" || version || n || wraps || targetId (32)
 *     payload = feedOwnerId (32) || keyGeneration (4) || CEK (32)
 *
 * - Every wrap has its own ephemeral key, so wraps share nothing. The hint
 *   lets a moderator find their wrap without trying every one (a collision
 *   only costs one more try).
 * - A wrap is not authenticated on its own: a wrong R fails the GCM tag over
 *   the payload, and the tag covers the header and every wrap, so a box
 *   cannot be re-wrapped or moved to another report's target unnoticed.
 * - `feedOwnerId` is the identity whose feed encrypted the content: the
 *   post's author, or for a reply in a private thread the thread root's
 *   author (replies inherit the root's encryption). It is the AAD owner the
 *   moderator needs to decrypt the post with that CEK. The CEK of a
 *   generation also opens that feed's earlier generations (the chain hashes
 *   backwards): the moderators get the context of the author's earlier
 *   private posts, by the product's choice.
 * - There is no re-wrap: a moderator seated after the report cannot open it.
 * - AES-GCM does not commit to its key, so a reporter could craft wraps that
 *   hand different moderators different keys, each passing the tag. It gains
 *   nothing: the payload's CEK must still decrypt the post on chain (which
 *   binds its feed owner), so a moderator given a wrong one only sees "does
 *   not open".
 */
import bs58 from 'bs58'
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import * as secp256k1 from '@noble/secp256k1'
import { bytesEqual, concatBytes as concat } from './bytes'
import { ecdhSharedX } from './crypto/ecdh'
import { getPublicKey } from './crypto/keys'

const REPORT_BOX_VERSION = 1

const HINT_BYTES = 4
const PUBLIC_KEY_BYTES = 33
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const ID_BYTES = 32
const HEADER_BYTES = 2
/** One recipient's wrap. */
export const REPORT_BOX_WRAP_BYTES = HINT_BYTES + PUBLIC_KEY_BYTES + KEY_BYTES
const PAYLOAD_BYTES = ID_BYTES + 4 + KEY_BYTES
const SEALED_BYTES = NONCE_BYTES + PAYLOAD_BYTES + TAG_BYTES
/** The `n` byte's ceiling (a full team is 26: the leader, 15 elected, 10 added). */
const MAX_WRAPS = 255

const utf8 = (text: string) => new TextEncoder().encode(text)
const HINT_LABEL = utf8('yappr/report-box/v1/hint')
const WRAP_LABEL = utf8('yappr/report-box/v1/wrap')
const AAD_LABEL = utf8('yappr/report-box/v1')

/** What the box carries: the key that opens the reported private content. */
export interface ReportBoxPayload {
  /** Base58 identity whose private feed encrypted the content. */
  feedOwnerId: string
  /** The content's key generation (`keyGeneration` on the post or reply). */
  keyGeneration: number
  /** The feed's CEK for that generation (32 bytes). */
  cek: Uint8Array
}

/** A box that is malformed, not sealed to this key, or tampered with. */
export class ReportBoxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReportBoxError'
  }
}

/** The box's size for `recipients` wraps. */
export function reportBoxSize(recipients: number): number {
  return HEADER_BYTES + recipients * REPORT_BOX_WRAP_BYTES + SEALED_BYTES
}

/** The most wraps a box of at most `maxBytes` holds. */
export function maxReportBoxRecipients(maxBytes: number): number {
  return Math.min(MAX_WRAPS, Math.max(0, Math.floor((maxBytes - HEADER_BYTES - SEALED_BYTES) / REPORT_BOX_WRAP_BYTES)))
}

const hintOf = (publicKey: Uint8Array) => sha256(concat(HINT_LABEL, publicKey)).slice(0, HINT_BYTES)

const wrapKey = (sharedX: Uint8Array, ephemeralPub: Uint8Array, recipientPub: Uint8Array) =>
  hkdf(sha256, sharedX, ephemeralPub, concat(WRAP_LABEL, recipientPub), KEY_BYTES)

const xor = (a: Uint8Array, b: Uint8Array) => a.map((byte, index) => byte ^ b[index])

function decodeId(id: string, label: string): Uint8Array {
  const bytes = bs58.decode(id)
  if (bytes.length !== ID_BYTES) throw new ReportBoxError(`${label} is not a 32-byte identifier`)
  return bytes
}

const aadOf = (header: Uint8Array, targetId: Uint8Array) => concat(AAD_LABEL, header, targetId)

/**
 * Seal `payload` to every key in `recipientKeys` (compressed secp256k1
 * ENCRYPTION public keys), bound to the reported post or reply `targetId`.
 */
export function sealReportBox(payload: ReportBoxPayload, recipientKeys: readonly Uint8Array[], targetId: string): Uint8Array {
  if (recipientKeys.length === 0) throw new ReportBoxError('A box needs at least one recipient')
  if (recipientKeys.length > MAX_WRAPS) throw new ReportBoxError(`A box holds at most ${MAX_WRAPS} recipients`)
  if (payload.cek.length !== KEY_BYTES) throw new ReportBoxError('The content key is not 32 bytes')
  if (!Number.isInteger(payload.keyGeneration) || payload.keyGeneration < 1 || payload.keyGeneration > 0xffffffff) {
    throw new ReportBoxError('The key generation is out of range')
  }
  const reportKey = randomBytes(KEY_BYTES)
  const wraps = recipientKeys.map((recipientPub) => {
    if (recipientPub.length !== PUBLIC_KEY_BYTES) throw new ReportBoxError('A recipient key is not a compressed secp256k1 key')
    const ephemeralPriv = secp256k1.utils.randomSecretKey()
    const ephemeralPub = getPublicKey(ephemeralPriv)
    const k = wrapKey(ecdhSharedX(ephemeralPriv, recipientPub), ephemeralPub, recipientPub)
    return concat(hintOf(recipientPub), ephemeralPub, xor(reportKey, k))
  })
  const header = concat(Uint8Array.of(REPORT_BOX_VERSION, recipientKeys.length), ...wraps)
  const generation = new Uint8Array(4)
  new DataView(generation.buffer).setUint32(0, payload.keyGeneration)
  const plaintext = concat(decodeId(payload.feedOwnerId, 'The feed owner'), generation, payload.cek)
  const nonce = randomBytes(NONCE_BYTES)
  const sealed = gcm(reportKey, nonce, aadOf(header, decodeId(targetId, 'The target'))).encrypt(plaintext)
  return concat(header, nonce, sealed)
}

/** The box's header and wraps, checked for shape. */
function parse(box: Uint8Array): { header: Uint8Array; wraps: Uint8Array[]; nonce: Uint8Array; sealed: Uint8Array } {
  if (box.length < HEADER_BYTES || box[0] !== REPORT_BOX_VERSION) throw new ReportBoxError('Unknown report box version')
  const count = box[1]
  if (count < 1 || box.length !== reportBoxSize(count)) throw new ReportBoxError('Malformed report box')
  const headerEnd = HEADER_BYTES + count * REPORT_BOX_WRAP_BYTES
  const wraps = Array.from({ length: count }, (_, index) => box.slice(HEADER_BYTES + index * REPORT_BOX_WRAP_BYTES, HEADER_BYTES + (index + 1) * REPORT_BOX_WRAP_BYTES))
  return { header: box.slice(0, headerEnd), wraps, nonce: box.slice(headerEnd, headerEnd + NONCE_BYTES), sealed: box.slice(headerEnd + NONCE_BYTES) }
}

/**
 * Open a box with a moderator's ENCRYPTION private key, for the report of
 * `targetId`. Throws {@link ReportBoxError} when the box is malformed, holds
 * no wrap for this key, or fails its tag (tampered, or moved off its target).
 */
export function openReportBox(box: Uint8Array, targetId: string, privateKey: Uint8Array): ReportBoxPayload {
  const { header, wraps, nonce, sealed } = parse(box)
  const publicKey = getPublicKey(privateKey)
  const hint = hintOf(publicKey)
  const aad = aadOf(header, decodeId(targetId, 'The target'))
  for (const wrap of wraps) {
    if (!bytesEqual(wrap.slice(0, HINT_BYTES), hint)) continue
    const ephemeralPub = wrap.slice(HINT_BYTES, HINT_BYTES + PUBLIC_KEY_BYTES)
    let plaintext: Uint8Array
    try {
      const k = wrapKey(ecdhSharedX(privateKey, ephemeralPub), ephemeralPub, publicKey)
      plaintext = gcm(xor(wrap.slice(HINT_BYTES + PUBLIC_KEY_BYTES), k), nonce, aad).decrypt(sealed)
    } catch {
      continue // a hint collision, or a tampered wrap: try the next one
    }
    return {
      feedOwnerId: bs58.encode(plaintext.slice(0, ID_BYTES)),
      keyGeneration: new DataView(plaintext.buffer, plaintext.byteOffset + ID_BYTES, 4).getUint32(0),
      cek: plaintext.slice(ID_BYTES + 4),
    }
  }
  throw new ReportBoxError('This report was not sealed to your encryption key')
}
