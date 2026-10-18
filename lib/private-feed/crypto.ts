/**
 * Private feeds, crypto v2 (`yappr/pf2`): social v17's several write-once
 * feeds per identity. The design is the release audit's
 * private-feeds-multi-design.md §5; every function here is pure.
 *
 * A feed is `(ownerId, feed)`, a per-owner counter. Each feed has its own
 * random 32-byte seed, from which everything else derives:
 *
 *     chain      root = HKDF(seed, "yappr/pf2/chain")
 *                CEK[max] = HKDF(root, "cek" ‖ u16 max), CEK[n-1] = SHA256(CEK[n])
 *                max is the feed's STORED maxKeyGeneration (never a constant)
 *     history    H = HKDF(seed, "yappr/pf2/history")
 *     node key   HKDF(seed, "node" ‖ u16 id ‖ u16 version); the tree is heap
 *                indexed with the root at 1 and the leaves at
 *                treeCapacity … 2·treeCapacity−1 (the STORED treeCapacity)
 *
 * All integers are big-endian; key generations, feeds, node ids and versions
 * are u16, `keyId` is u32. Wire formats:
 *
 *     encryptedSeed  ECIES(ownerPub, 0x02 ‖ seed, aad = "yappr/pf2/seed" ‖ ownerId ‖ u16 feed ‖ u32 keyId)
 *     grant payload  0x02 ‖ u16 feed ‖ u16 gen ‖ u16 leaf ‖ u8 n ‖ n × (u16 id ‖ u16 ver ‖ key32) ‖ CEK[gen] ‖ H,
 *                    ECIES to the recipient, aad = "yappr/pf2/grant" ‖ ownerId ‖ recipientId ‖ u16 feed ‖ u16 leaf ‖ u16 gen
 *     rekey packets  u8 count ‖ count × (u16 target ‖ u16 targetVer ‖ u16 under ‖ u16 underVer ‖ wrapped48)
 *                    wrapped = XChaCha20-Poly1305(HKDF(underKey, "wrap"), nonce, aad, newKey)
 *                    nonce = HKDF(ikm = "yappr/pf2/wrapnonce", salt = ownerId ‖ u16 feed, info = u16 gen ‖ u16 × 4)
 *                    aad = "yappr/pf2/rekey" ‖ ownerId ‖ u16 feed ‖ u16 gen ‖ u16 × 4
 *     encryptedCEK   XChaCha20-Poly1305(HKDF(rootKey, "cek-wrap"), HKDF(rootKey, "cek-nonce" ‖ u16 gen),
 *                    aad = "yappr/pf2/cek" ‖ ownerId ‖ u16 feed ‖ u16 gen, CEK[gen])          48 B
 *     post / reply   postKey = HKDF(CEK, "post" ‖ nonce ‖ authorId)
 *                    aad = "yappr/pf2/post" ‖ feedOwnerId ‖ u16 feed ‖ u16 gen ‖ nonce ‖ authorId ‖ u8 kind
 *                    ciphertext = XChaCha20-Poly1305(postKey, nonce, aad, 0x02 ‖ utf8)
 *     carry          nonce24 ‖ XChaCha20-Poly1305(HKDF(H_new, "yappr/pf2/carry"), nonce24,
 *                    aad = "yappr/pf2/carry" ‖ ownerId ‖ u16 feed_new,
 *                    0x02 ‖ u16 prevFeed ‖ u16 prevFinalGen ‖ CEK_prev[final] ‖ H_prev)       109 B
 *
 * The history key reaches members only through grants and the owner only
 * through the seed: a CEK (what a report box hands moderators) never opens a
 * carry, so a box stays inside its feed.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { concatBytes as concat } from '@/lib/bytes'
import { privateFeedCryptoService } from '@/lib/services/private-feed-crypto-service'

export const PF_VERSION = 0x02
export const ROOT_NODE_ID = 1
const KEY = 32
const NONCE = 24
const TAG = 16
const PACKET_BYTES = 8 + KEY + TAG
const EMPTY = new Uint8Array(0)
/** The u16 ceiling of feeds, key generations, node ids and versions. */
const U16_MAX = 0xffff
/** The largest treeCapacity a u16 node id can address (2N−1 ≤ 65535); the contract's maximum too. */
export const MAX_TREE_CAPACITY = 32768

const utf8 = (text: string) => new TextEncoder().encode(text)
const LABEL = {
  chain: utf8('yappr/pf2/chain'),
  history: utf8('yappr/pf2/history'),
  seed: utf8('yappr/pf2/seed'),
  grant: utf8('yappr/pf2/grant'),
  wrapNonce: utf8('yappr/pf2/wrapnonce'),
  rekey: utf8('yappr/pf2/rekey'),
  cek: utf8('yappr/pf2/cek'),
  post: utf8('yappr/pf2/post'),
  carry: utf8('yappr/pf2/carry'),
  cekInfo: utf8('cek'),
  node: utf8('node'),
  wrap: utf8('wrap'),
  cekWrap: utf8('cek-wrap'),
  cekNonce: utf8('cek-nonce'),
  postKey: utf8('post'),
}

function u16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > U16_MAX) throw new Error(`Not a u16: ${value}`)
  return Uint8Array.of(value >> 8, value & 0xff)
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`Not a u32: ${value}`)
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

const readU16 = (bytes: Uint8Array, offset: number) => (bytes[offset] << 8) | bytes[offset + 1]

const derive = (ikm: Uint8Array, info: Uint8Array, length = KEY) => hkdf(sha256, ikm, EMPTY, info, length)

/** A feed's stored lifetime caps. */
export interface FeedCaps {
  treeCapacity: number
  maxKeyGeneration: number
}

/** Release defaults for a new feed (PF2); each feed stores its own and only the stored values count. */
export const DEFAULT_FEED_CAPS: FeedCaps = { treeCapacity: 4096, maxKeyGeneration: 4095 }

/** Throws unless `caps` are caps a v17 feed may store and this client can address. */
export function assertFeedCaps({ treeCapacity, maxKeyGeneration }: FeedCaps): void {
  if (!Number.isInteger(treeCapacity) || treeCapacity < 2 || treeCapacity > MAX_TREE_CAPACITY) {
    throw new Error(`Invalid treeCapacity: ${treeCapacity}`)
  }
  if (!Number.isInteger(maxKeyGeneration) || maxKeyGeneration < 2 || maxKeyGeneration > U16_MAX) {
    throw new Error(`Invalid maxKeyGeneration: ${maxKeyGeneration}`)
  }
}

/** Which kind of content a ciphertext is, bound into its AAD. */
export type ContentKind = 'post' | 'reply'

/** Everything a private post's or reply's ciphertext is bound to. */
export interface ContentBinding {
  /** The feed's owner (32 bytes): the post's author, or for a reply in a private thread the root's author. */
  feedOwnerId: Uint8Array
  feed: number
  keyGeneration: number
  /** The writer (32 bytes). */
  authorId: Uint8Array
  kind: ContentKind
}

export interface NodeKey {
  nodeId: number
  version: number
  key: Uint8Array
}

// ============================================================
// Seed, chain, history
// ============================================================

export function generateSeed(): Uint8Array {
  return randomBytes(KEY)
}

/** CEK[max] of a feed: the top of its hash chain. */
function chainTop(seed: Uint8Array, maxKeyGeneration: number): Uint8Array {
  return derive(derive(seed, LABEL.chain), concat(LABEL.cekInfo, u16(maxKeyGeneration)))
}

/** `cek` (of generation `from`) hashed back to generation `to` ≤ `from`. */
export function hashBack(cek: Uint8Array, from: number, to: number): Uint8Array {
  if (!Number.isInteger(to) || to < 1) throw new Error('Key generation must be at least 1')
  if (to > from) throw new Error('A content key cannot be derived forward')
  let result = cek
  for (let generation = from; generation > to; generation--) result = sha256(result)
  return result
}

/** The CEK of `keyGeneration` in a feed with seed `seed` and stored `maxKeyGeneration`. */
export function cekAt(seed: Uint8Array, maxKeyGeneration: number, keyGeneration: number): Uint8Array {
  if (keyGeneration > maxKeyGeneration) throw new Error(`Key generation ${keyGeneration} is past the feed's cap ${maxKeyGeneration}`)
  return hashBack(chainTop(seed, maxKeyGeneration), maxKeyGeneration, keyGeneration)
}

/** A feed's history key: it opens that feed's own `carry` (its predecessor's keys), never anything newer. */
export function historyKey(seed: Uint8Array): Uint8Array {
  return derive(seed, LABEL.history)
}

export function nodeKey(seed: Uint8Array, nodeId: number, version: number): Uint8Array {
  return derive(seed, concat(LABEL.node, u16(nodeId), u16(version)))
}

const seedAad = (ownerId: Uint8Array, feed: number, keyId: number) => concat(LABEL.seed, ownerId, u16(feed), u32(keyId))

/** `encryptedSeed`: the seed sealed to the owner's ENCRYPTION key `keyId` (82 B). */
export async function sealSeed(ownerPublicKey: Uint8Array, seed: Uint8Array, ownerId: Uint8Array, feed: number, keyId: number): Promise<Uint8Array> {
  return privateFeedCryptoService.eciesEncrypt(ownerPublicKey, concat(Uint8Array.of(PF_VERSION), seed), seedAad(ownerId, feed, keyId))
}

/** Opens `encryptedSeed`; throws when the key is not the one it was sealed to. */
export async function openSeed(ownerPrivateKey: Uint8Array, encryptedSeed: Uint8Array, ownerId: Uint8Array, feed: number, keyId: number): Promise<Uint8Array> {
  const plain = await privateFeedCryptoService.eciesDecrypt(ownerPrivateKey, encryptedSeed, seedAad(ownerId, feed, keyId))
  if (plain.length !== 1 + KEY || plain[0] !== PF_VERSION) throw new Error('Malformed feed seed')
  return plain.slice(1)
}

// ============================================================
// The tree (LKH)
// ============================================================

export const parentOf = (nodeId: number) => Math.floor(nodeId / 2)
export const siblingOf = (nodeId: number) => (nodeId % 2 === 0 ? nodeId + 1 : nodeId - 1)

export function leafNodeId(treeCapacity: number, leafIndex: number): number {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= treeCapacity) {
    throw new Error(`Leaf ${leafIndex} is outside a tree of ${treeCapacity}`)
  }
  return treeCapacity + leafIndex
}

/** The node ids from `leafIndex`'s leaf up to the root, inclusive. */
export function pathOf(treeCapacity: number, leafIndex: number): number[] {
  const path: number[] = []
  for (let nodeId = leafNodeId(treeCapacity, leafIndex); nodeId >= ROOT_NODE_ID; nodeId = parentOf(nodeId)) path.push(nodeId)
  return path
}

/**
 * Every node's version: how many revoked leaves sit under it. A leaf revoked
 * twice (revoked, re-granted, revoked again) counts twice.
 */
export function nodeVersions(treeCapacity: number, revokedLeaves: readonly number[]): Map<number, number> {
  const versions = new Map<number, number>()
  for (const leaf of revokedLeaves) {
    for (const nodeId of pathOf(treeCapacity, leaf)) versions.set(nodeId, (versions.get(nodeId) ?? 0) + 1)
  }
  return versions
}

/** The keys a member at `leafIndex` holds: its path at the current versions. */
export function grantPathKeys(seed: Uint8Array, treeCapacity: number, leafIndex: number, revokedLeaves: readonly number[]): NodeKey[] {
  const versions = nodeVersions(treeCapacity, revokedLeaves)
  return pathOf(treeCapacity, leafIndex).map((nodeId) => {
    const version = versions.get(nodeId) ?? 0
    return { nodeId, version, key: nodeKey(seed, nodeId, version) }
  })
}

// ============================================================
// Grant payload
// ============================================================

export interface GrantPayload {
  feed: number
  keyGeneration: number
  leafIndex: number
  pathKeys: NodeKey[]
  cek: Uint8Array
  history: Uint8Array
}

export function encodeGrantPayload(payload: GrantPayload): Uint8Array {
  if (payload.pathKeys.length > 0xff) throw new Error('Too many path keys')
  return concat(
    Uint8Array.of(PF_VERSION), u16(payload.feed), u16(payload.keyGeneration), u16(payload.leafIndex), Uint8Array.of(payload.pathKeys.length),
    ...payload.pathKeys.flatMap((key) => [u16(key.nodeId), u16(key.version), key.key]),
    payload.cek, payload.history,
  )
}

export function decodeGrantPayload(data: Uint8Array): GrantPayload {
  const HEADER = 8
  if (data.length < HEADER || data[0] !== PF_VERSION) throw new Error('Unknown grant payload version')
  const count = data[7]
  if (data.length !== HEADER + count * (4 + KEY) + 2 * KEY) throw new Error('Malformed grant payload')
  const pathKeys: NodeKey[] = []
  let offset = HEADER
  for (let i = 0; i < count; i++, offset += 4 + KEY) {
    pathKeys.push({ nodeId: readU16(data, offset), version: readU16(data, offset + 2), key: data.slice(offset + 4, offset + 4 + KEY) })
  }
  return {
    feed: readU16(data, 1),
    keyGeneration: readU16(data, 3),
    leafIndex: readU16(data, 5),
    pathKeys,
    cek: data.slice(offset, offset + KEY),
    history: data.slice(offset + KEY, offset + 2 * KEY),
  }
}

/** What a grant document says about itself, which its decrypted payload must agree with. */
export interface GrantFacts extends FeedCaps {
  feed: number
  leafIndex: number
  keyGeneration: number
}

export function grantAad(ownerId: Uint8Array, recipientId: Uint8Array, facts: Pick<GrantFacts, 'feed' | 'leafIndex' | 'keyGeneration'>): Uint8Array {
  return concat(LABEL.grant, ownerId, recipientId, u16(facts.feed), u16(facts.leafIndex), u16(facts.keyGeneration))
}

/**
 * Follower-side checks of a decrypted grant (design §5.3): it names the
 * grant's feed, leaf and generation, the leaf and generation are inside the
 * feed's stored caps, and the path runs from that leaf to the root.
 */
export function validateGrantPayload(payload: GrantPayload, facts: GrantFacts): void {
  assertFeedCaps(facts)
  if (payload.feed !== facts.feed) throw new Error('The grant names another feed')
  if (payload.leafIndex !== facts.leafIndex) throw new Error('The grant names another leaf')
  if (payload.keyGeneration !== facts.keyGeneration) throw new Error('The grant names another key generation')
  if (payload.keyGeneration < 1 || payload.keyGeneration > facts.maxKeyGeneration) throw new Error('The grant\'s key generation is past the feed\'s cap')
  const expected = pathOf(facts.treeCapacity, facts.leafIndex)
  if (payload.pathKeys.length !== expected.length || payload.pathKeys.some((key, index) => key.nodeId !== expected[index])) {
    throw new Error('The grant\'s path does not run from its leaf to the root')
  }
}

/** Seal a grant for `recipientPublicKey`. */
export async function sealGrant(
  recipientPublicKey: Uint8Array, ownerId: Uint8Array, recipientId: Uint8Array, payload: GrantPayload,
): Promise<Uint8Array> {
  return privateFeedCryptoService.eciesEncrypt(recipientPublicKey, encodeGrantPayload(payload), grantAad(ownerId, recipientId, payload))
}

/** Open and check a grant; throws when it is not sealed to this key or does not hold together. */
export async function openGrant(
  recipientPrivateKey: Uint8Array, encryptedPayload: Uint8Array, ownerId: Uint8Array, recipientId: Uint8Array, facts: GrantFacts,
): Promise<GrantPayload> {
  const payload = decodeGrantPayload(await privateFeedCryptoService.eciesDecrypt(recipientPrivateKey, encryptedPayload, grantAad(ownerId, recipientId, facts)))
  validateGrantPayload(payload, facts)
  return payload
}

// ============================================================
// Rekeys (revocation inside a feed)
// ============================================================

export interface RekeyPacket {
  targetNodeId: number
  targetVersion: number
  underNodeId: number
  underVersion: number
  wrappedKey: Uint8Array
}

/** Where a rekey sits: its feed and new generation. */
export interface RekeyContext {
  ownerId: Uint8Array
  feed: number
  keyGeneration: number
}

function packetTail(ctx: RekeyContext, packet: Omit<RekeyPacket, 'wrappedKey'>): Uint8Array {
  return concat(u16(ctx.keyGeneration), u16(packet.targetNodeId), u16(packet.targetVersion), u16(packet.underNodeId), u16(packet.underVersion))
}

const packetNonce = (ctx: RekeyContext, packet: Omit<RekeyPacket, 'wrappedKey'>) =>
  hkdf(sha256, LABEL.wrapNonce, concat(ctx.ownerId, u16(ctx.feed)), packetTail(ctx, packet), NONCE)

const packetAad = (ctx: RekeyContext, packet: Omit<RekeyPacket, 'wrappedKey'>) =>
  concat(LABEL.rekey, ctx.ownerId, u16(ctx.feed), packetTail(ctx, packet))

function wrapPacket(ctx: RekeyContext, header: Omit<RekeyPacket, 'wrappedKey'>, underKey: Uint8Array, newKey: Uint8Array): RekeyPacket {
  const wrappedKey = xchacha20poly1305(derive(underKey, LABEL.wrap), packetNonce(ctx, header), packetAad(ctx, header)).encrypt(newKey)
  return { ...header, wrappedKey }
}

function unwrapPacket(ctx: RekeyContext, packet: RekeyPacket, underKey: Uint8Array): Uint8Array | null {
  try {
    return xchacha20poly1305(derive(underKey, LABEL.wrap), packetNonce(ctx, packet), packetAad(ctx, packet)).decrypt(packet.wrappedKey)
  } catch {
    return null
  }
}

function cekCipher(rootKey: Uint8Array, ownerId: Uint8Array, feed: number, keyGeneration: number) {
  return xchacha20poly1305(
    derive(rootKey, LABEL.cekWrap),
    derive(rootKey, concat(LABEL.cekNonce, u16(keyGeneration)), NONCE),
    concat(LABEL.cek, ownerId, u16(feed), u16(keyGeneration)),
  )
}

export function encodeRekeyPackets(packets: readonly RekeyPacket[]): Uint8Array {
  if (packets.length > 0xff) throw new Error('Too many rekey packets')
  return concat(Uint8Array.of(packets.length), ...packets.flatMap((packet) => [
    u16(packet.targetNodeId), u16(packet.targetVersion), u16(packet.underNodeId), u16(packet.underVersion), packet.wrappedKey,
  ]))
}

/** Decode and bounds-check a rekey's packets against the feed's stored treeCapacity. */
export function decodeRekeyPackets(data: Uint8Array, treeCapacity: number): RekeyPacket[] {
  if (data.length < 1 || data.length !== 1 + data[0] * PACKET_BYTES) throw new Error('Malformed rekey packets')
  const lastNode = 2 * treeCapacity - 1
  const packets: RekeyPacket[] = []
  for (let offset = 1; offset < data.length; offset += PACKET_BYTES) {
    const packet = {
      targetNodeId: readU16(data, offset),
      targetVersion: readU16(data, offset + 2),
      underNodeId: readU16(data, offset + 4),
      underVersion: readU16(data, offset + 6),
      wrappedKey: data.slice(offset + 8, offset + PACKET_BYTES),
    }
    for (const nodeId of [packet.targetNodeId, packet.underNodeId]) {
      if (nodeId < ROOT_NODE_ID || nodeId > lastNode) throw new Error(`Rekey packet node ${nodeId} is outside the tree`)
    }
    packets.push(packet)
  }
  return packets
}

/** A revocation's on-chain content. */
export interface RekeyBuild {
  packets: Uint8Array
  encryptedCEK: Uint8Array
  /** The new generation's CEK, for the owner's own state. */
  cek: Uint8Array
}

/**
 * The owner revokes `leafIndex` (design §7.3): every node on its path gets
 * a new version, each new key wrapped under the sibling of the path below it
 * (its current key: none of the revoked member's) and, above the first, under
 * the updated child's new key. The new generation's CEK goes under the new
 * root. `revokedLeaves` are the earlier revocations in order.
 */
export function buildRekey(
  seed: Uint8Array, caps: FeedCaps, ctx: RekeyContext, revokedLeaves: readonly number[], leafIndex: number,
): RekeyBuild {
  assertFeedCaps(caps)
  if (ctx.keyGeneration < 2 || ctx.keyGeneration > caps.maxKeyGeneration) throw new Error('The feed has no key generation left')
  const before = nodeVersions(caps.treeCapacity, revokedLeaves)
  const after = nodeVersions(caps.treeCapacity, [...revokedLeaves, leafIndex])
  const path = pathOf(caps.treeCapacity, leafIndex)
  const packets: RekeyPacket[] = []
  const newKeys = new Map<number, { version: number; key: Uint8Array }>()
  for (let i = 1; i < path.length; i++) {
    const nodeId = path[i]
    const version = after.get(nodeId) ?? 0
    const key = nodeKey(seed, nodeId, version)
    newKeys.set(nodeId, { version, key })
    const sibling = siblingOf(path[i - 1])
    const siblingVersion = before.get(sibling) ?? 0
    packets.push(wrapPacket(ctx, { targetNodeId: nodeId, targetVersion: version, underNodeId: sibling, underVersion: siblingVersion }, nodeKey(seed, sibling, siblingVersion), key))
    const child = newKeys.get(path[i - 1])
    if (child) {
      packets.push(wrapPacket(ctx, { targetNodeId: nodeId, targetVersion: version, underNodeId: path[i - 1], underVersion: child.version }, child.key, key))
    }
  }
  const root = newKeys.get(ROOT_NODE_ID)
  if (!root) throw new Error('A tree of one leaf cannot revoke')
  const cek = cekAt(seed, caps.maxKeyGeneration, ctx.keyGeneration)
  return { packets: encodeRekeyPackets(packets), encryptedCEK: cekCipher(root.key, ctx.ownerId, ctx.feed, ctx.keyGeneration).encrypt(cek), cek }
}

/**
 * A member applies one rekey to its path keys (design §5.3). Returns the
 * updated path and the new generation's CEK, or null when this member cannot
 * reach the new root: it is the one revoked (or holds stale keys).
 */
export function applyRekey(
  pathKeys: readonly NodeKey[], packets: readonly RekeyPacket[], encryptedCEK: Uint8Array, ctx: RekeyContext,
): { pathKeys: NodeKey[]; cek: Uint8Array } | null {
  const held = new Map(pathKeys.map((key) => [`${key.nodeId}:${key.version}`, key.key]))
  const learned = new Map<number, NodeKey>()
  const opened = new Set<number>()
  for (let progress = true; progress;) {
    progress = false
    packets.forEach((packet, index) => {
      if (opened.has(index)) return
      const fresh = learned.get(packet.underNodeId)
      const underKey = fresh && fresh.version === packet.underVersion ? fresh.key : held.get(`${packet.underNodeId}:${packet.underVersion}`)
      if (!underKey) return
      const key = unwrapPacket(ctx, packet, underKey)
      if (!key) return
      learned.set(packet.targetNodeId, { nodeId: packet.targetNodeId, version: packet.targetVersion, key })
      opened.add(index)
      progress = true
    })
  }
  const root = learned.get(ROOT_NODE_ID)
  if (!root) return null
  let cek: Uint8Array
  try {
    cek = cekCipher(root.key, ctx.ownerId, ctx.feed, ctx.keyGeneration).decrypt(encryptedCEK)
  } catch {
    return null
  }
  return { pathKeys: pathKeys.map((key) => learned.get(key.nodeId) ?? key), cek }
}

// ============================================================
// Posts and replies
// ============================================================

const KIND_BYTE: Record<ContentKind, number> = { post: 0, reply: 1 }

function contentCipher(cek: Uint8Array, nonce: Uint8Array, binding: ContentBinding) {
  const postKey = derive(cek, concat(LABEL.postKey, nonce, binding.authorId))
  const aad = concat(LABEL.post, binding.feedOwnerId, u16(binding.feed), u16(binding.keyGeneration), nonce, binding.authorId, Uint8Array.of(KIND_BYTE[binding.kind]))
  return xchacha20poly1305(postKey, nonce, aad)
}

/** The bytes encryption adds to the UTF-8 plaintext: the version byte and the Poly1305 tag. */
export const CONTENT_OVERHEAD = 1 + TAG

export function encryptContent(cek: Uint8Array, plaintext: string, binding: ContentBinding): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(NONCE)
  return { ciphertext: contentCipher(cek, nonce, binding).encrypt(concat(Uint8Array.of(PF_VERSION), utf8(plaintext))), nonce }
}

/** Throws when `cek` or the binding is wrong, or the ciphertext was tampered with. */
export function decryptContent(cek: Uint8Array, ciphertext: Uint8Array, nonce: Uint8Array, binding: ContentBinding): string {
  const plain = contentCipher(cek, nonce, binding).decrypt(ciphertext)
  if (plain[0] !== PF_VERSION) throw new Error('Unknown private content version')
  return new TextDecoder().decode(plain.slice(1))
}

// ============================================================
// Carry: the history link from a feed to its predecessor
// ============================================================

/** What a carry hands on: the predecessor's final CEK and its history key. */
export interface CarriedFeed {
  feed: number
  finalKeyGeneration: number
  cek: Uint8Array
  history: Uint8Array
}

const carryAad = (ownerId: Uint8Array, feed: number) => concat(LABEL.carry, ownerId, u16(feed))
const carryKey = (history: Uint8Array) => derive(history, LABEL.carry)

/** Seal `previous` into feed `feed`'s carry, under that feed's history key (109 B). */
export function sealCarry(history: Uint8Array, ownerId: Uint8Array, feed: number, previous: CarriedFeed): Uint8Array {
  if (previous.feed >= feed) throw new Error('A carry links to an earlier feed')
  const nonce = randomBytes(NONCE)
  const plain = concat(Uint8Array.of(PF_VERSION), u16(previous.feed), u16(previous.finalKeyGeneration), previous.cek, previous.history)
  return concat(nonce, xchacha20poly1305(carryKey(history), nonce, carryAad(ownerId, feed)).encrypt(plain))
}

/** Open feed `feed`'s carry with its history key; throws on a wrong key or a malformed carry. */
export function openCarry(history: Uint8Array, ownerId: Uint8Array, feed: number, carry: Uint8Array): CarriedFeed {
  if (carry.length !== NONCE + 5 + 2 * KEY + TAG) throw new Error('Malformed carry')
  const plain = xchacha20poly1305(carryKey(history), carry.slice(0, NONCE), carryAad(ownerId, feed)).decrypt(carry.slice(NONCE))
  if (plain[0] !== PF_VERSION) throw new Error('Unknown carry version')
  const previous = { feed: readU16(plain, 1), finalKeyGeneration: readU16(plain, 3), cek: plain.slice(5, 5 + KEY), history: plain.slice(5 + KEY) }
  if (previous.feed < 1 || previous.feed >= feed || previous.finalKeyGeneration < 1) throw new Error('The carry names an impossible feed')
  return previous
}
