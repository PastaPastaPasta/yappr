import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import {
  applyRekey, buildRekey, cekAt, decodeGrantPayload, decodeRekeyPackets, decryptContent, encodeGrantPayload, encryptContent,
  grantPathKeys, hashBack, historyKey, nodeKey, nodeVersions, openCarry, openGrant, openSeed, pathOf, sealCarry, sealGrant,
  sealSeed, validateGrantPayload, type ContentBinding, type FeedCaps, type NodeKey,
} from './crypto'

const seed = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
const ownerId = new Uint8Array(32).fill(0x0a)
const authorId = new Uint8Array(32).fill(0x0b)
const caps: FeedCaps = { treeCapacity: 64, maxKeyGeneration: 4095 }

/** A member as the follower side holds it: the path keys of its grant, and the current CEK. */
interface Member { leaf: number; pathKeys: NodeKey[]; cek: Uint8Array; keyGeneration: number }

function grantMember(feedSeed: Uint8Array, feedCaps: FeedCaps, leaf: number, revoked: number[], keyGeneration: number): Member {
  return { leaf, pathKeys: grantPathKeys(feedSeed, feedCaps.treeCapacity, leaf, revoked), cek: cekAt(feedSeed, feedCaps.maxKeyGeneration, keyGeneration), keyGeneration }
}

/** The owner revokes `leaf`; every member tries the rekey. Returns the members that kept up. */
function revoke(feedSeed: Uint8Array, feedCaps: FeedCaps, feed: number, revoked: number[], leaf: number, keyGeneration: number, members: Member[]) {
  const ctx = { ownerId, feed, keyGeneration }
  const rekey = buildRekey(feedSeed, feedCaps, ctx, revoked, leaf)
  revoked.push(leaf)
  const packets = decodeRekeyPackets(rekey.packets, feedCaps.treeCapacity)
  return members.map((member) => {
    const applied = applyRekey(member.pathKeys, packets, rekey.encryptedCEK, ctx)
    return applied ? { ...member, pathKeys: applied.pathKeys, cek: applied.cek, keyGeneration } : null
  })
}

describe('private feed crypto v2: LKH revocation (R-S11)', () => {
  it('keeps every member but the revoked one on the new CEK', () => {
    const revoked: number[] = []
    const members = [0, 1, 2, 3, 37, 63].map((leaf) => grantMember(seed, caps, leaf, revoked, 1))
    const after = revoke(seed, caps, 1, revoked, 2, 2, members)
    const expected = cekAt(seed, caps.maxKeyGeneration, 2)
    expect(after.map((member) => member?.leaf ?? null)).toEqual([0, 1, null, 3, 37, 63])
    for (const member of after.filter((m): m is Member => m !== null)) expect(bytesToHex(member.cek)).toBe(bytesToHex(expected))
  })

  it('keeps members in step across a run of revocations, and the revoked never catch up', () => {
    const revoked: number[] = []
    let members: (Member | null)[] = Array.from({ length: 16 }, (_, leaf) => grantMember(seed, caps, leaf, revoked, 1))
    const order = [5, 0, 15, 6, 7, 1]
    order.forEach((leaf, index) => {
      const generation = index + 2
      const live = members.filter((m): m is Member => m !== null)
      const updated = revoke(seed, caps, 1, revoked, leaf, generation, live)
      members = members.map((member) => member && (updated.find((u) => u?.leaf === member.leaf) ?? null))
    })
    const survivors = members.filter((m): m is Member => m !== null).map((m) => m.leaf)
    expect(survivors).toEqual([2, 3, 4, 8, 9, 10, 11, 12, 13, 14])
    const top = cekAt(seed, caps.maxKeyGeneration, order.length + 1)
    for (const member of members) if (member) expect(bytesToHex(member.cek)).toBe(bytesToHex(top))
  })

  it('a revoked leaf re-granted to someone new gives them fresh keys the revoked member never held', () => {
    const revoked: number[] = []
    const old = grantMember(seed, caps, 4, revoked, 1)
    const neighbour = grantMember(seed, caps, 5, revoked, 1)
    const [, kept] = revoke(seed, caps, 1, revoked, 4, 2, [old, neighbour])
    const fresh = grantMember(seed, caps, 4, revoked, 2)
    const oldKeys = new Set(old.pathKeys.map((k) => bytesToHex(k.key)))
    expect(fresh.pathKeys.some((k) => oldKeys.has(bytesToHex(k.key)))).toBe(false)
    // Revoke the newcomer at the same leaf: the neighbour follows, the newcomer and the first holder do not.
    const after = revoke(seed, caps, 1, revoked, 4, 3, [old, kept as Member, fresh])
    expect(after.map((m) => m?.leaf ?? null)).toEqual([null, 5, null])
    expect(nodeVersions(caps.treeCapacity, revoked).get(caps.treeCapacity + 4)).toBe(2)
  })

  it('works on a tree whose size is not a power of two and binds each rekey to its feed and generation', () => {
    const odd: FeedCaps = { treeCapacity: 100, maxKeyGeneration: 10 }
    const revoked: number[] = []
    const members = [0, 50, 99].map((leaf) => grantMember(seed, odd, leaf, revoked, 1))
    const ctx = { ownerId, feed: 3, keyGeneration: 2 }
    const rekey = buildRekey(seed, odd, ctx, revoked, 50)
    const packets = decodeRekeyPackets(rekey.packets, odd.treeCapacity)
    expect(applyRekey(members[0].pathKeys, packets, rekey.encryptedCEK, ctx)).not.toBeNull()
    expect(applyRekey(members[1].pathKeys, packets, rekey.encryptedCEK, ctx)).toBeNull()
    // Replayed into another feed or at another generation, nothing opens.
    expect(applyRekey(members[0].pathKeys, packets, rekey.encryptedCEK, { ...ctx, feed: 4 })).toBeNull()
    expect(applyRekey(members[0].pathKeys, packets, rekey.encryptedCEK, { ...ctx, keyGeneration: 3 })).toBeNull()
  })

  it('refuses revocations past the stored generation cap and packets outside the stored tree', () => {
    const small: FeedCaps = { treeCapacity: 64, maxKeyGeneration: 3 }
    expect(() => buildRekey(seed, small, { ownerId, feed: 1, keyGeneration: 4 }, [], 0)).toThrow(/no key generation left/)
    const rekey = buildRekey(seed, caps, { ownerId, feed: 1, keyGeneration: 2 }, [], 63)
    expect(() => decodeRekeyPackets(rekey.packets, 32)).toThrow(/outside the tree/)
    expect(() => decodeRekeyPackets(rekey.packets.slice(1), 64)).toThrow(/Malformed/)
  })

  it('fits the largest tree inside the contract limits (packets ≤ 2048 B, grant ≤ 704 B)', async () => {
    const big: FeedCaps = { treeCapacity: 32768, maxKeyGeneration: 65535 }
    const rekey = buildRekey(seed, big, { ownerId, feed: 1, keyGeneration: 2 }, [], 32767)
    expect(rekey.packets.length).toBe(1625)
    expect(rekey.encryptedCEK.length).toBe(48)
    const recipient = hexToBytes('1f'.repeat(32))
    const sealed = await sealGrant(getPublicKey(recipient), ownerId, authorId, {
      feed: 1, keyGeneration: 1, leafIndex: 32767, pathKeys: grantPathKeys(seed, big.treeCapacity, 32767, []), cek: cekAt(seed, big.maxKeyGeneration, 1), history: historyKey(seed),
    })
    expect(sealed.length).toBe(697)
  })
})

describe('private feed crypto v2: grants', () => {
  const recipientPriv = hexToBytes('2f'.repeat(32))
  const recipientId = new Uint8Array(32).fill(0x0c)
  const facts = { feed: 2, leafIndex: 7, keyGeneration: 3, ...caps }
  const payload = { feed: 2, keyGeneration: 3, leafIndex: 7, pathKeys: grantPathKeys(seed, caps.treeCapacity, 7, []), cek: cekAt(seed, caps.maxKeyGeneration, 3), history: historyKey(seed) }

  it('round-trips and checks the payload against its grant', async () => {
    const sealed = await sealGrant(getPublicKey(recipientPriv), ownerId, recipientId, payload)
    const opened = await openGrant(recipientPriv, sealed, ownerId, recipientId, facts)
    expect(bytesToHex(encodeGrantPayload(opened))).toBe(bytesToHex(encodeGrantPayload(payload)))
    await expect(openGrant(recipientPriv, sealed, ownerId, recipientId, { ...facts, feed: 3 })).rejects.toThrow()
    await expect(openGrant(recipientPriv, sealed, ownerId, authorId, facts)).rejects.toThrow()
  })

  it('rejects a payload that disagrees with its grant or the stored caps', () => {
    expect(() => validateGrantPayload(payload, { ...facts, leafIndex: 8 })).toThrow(/leaf/)
    expect(() => validateGrantPayload(payload, { ...facts, maxKeyGeneration: 2 })).toThrow(/cap/)
    expect(() => validateGrantPayload(payload, { ...facts, treeCapacity: 128 })).toThrow(/path/)
    expect(() => decodeGrantPayload(encodeGrantPayload(payload).slice(0, -1))).toThrow(/Malformed/)
  })
})

describe('private feed crypto v2: history across feeds', () => {
  it('walks back three feeds through their carries, and a CEK alone opens no carry', () => {
    const seeds = [1, 2, 3].map((n) => new Uint8Array(32).fill(n))
    const finals = [5, 9]
    const carries = [2, 3].map((feed) => {
      const prev = feed - 1
      return sealCarry(historyKey(seeds[feed - 1]), ownerId, feed, {
        feed: prev, finalKeyGeneration: finals[prev - 1], cek: cekAt(seeds[prev - 1], 4095, finals[prev - 1]), history: historyKey(seeds[prev - 1]),
      })
    })
    expect(carries[0].length).toBe(109)
    const intoTwo = openCarry(historyKey(seeds[2]), ownerId, 3, carries[1])
    expect(intoTwo.feed).toBe(2)
    const intoOne = openCarry(intoTwo.history, ownerId, 2, carries[0])
    expect([intoOne.feed, intoOne.finalKeyGeneration]).toEqual([1, 5])
    expect(bytesToHex(hashBack(intoOne.cek, 5, 2))).toBe(bytesToHex(cekAt(seeds[0], 4095, 2)))
    // A moderator's CEK, or another feed's number, opens nothing.
    expect(() => openCarry(cekAt(seeds[2], 4095, 1), ownerId, 3, carries[1])).toThrow()
    expect(() => openCarry(historyKey(seeds[2]), ownerId, 4, carries[1])).toThrow()
  })
})

describe('private feed crypto v2: content binding', () => {
  const binding: ContentBinding = { feedOwnerId: ownerId, feed: 1, keyGeneration: 1, authorId, kind: 'reply' }
  const cek = cekAt(seed, 4095, 1)

  it('decrypts only under its feed, generation, author and kind', () => {
    const { ciphertext, nonce } = encryptContent(cek, 'hello', binding)
    expect(decryptContent(cek, ciphertext, nonce, binding)).toBe('hello')
    for (const wrong of [{ feed: 2 }, { keyGeneration: 2 }, { authorId: ownerId }, { kind: 'post' as const }, { feedOwnerId: authorId }]) {
      expect(() => decryptContent(cek, ciphertext, nonce, { ...binding, ...wrong })).toThrow()
    }
  })

  it('seals the seed to one feed number and key id', async () => {
    const ownerPriv = hexToBytes('3f'.repeat(32))
    const sealed = await sealSeed(getPublicKey(ownerPriv), seed, ownerId, 4, 7)
    expect(sealed.length).toBe(82)
    expect(bytesToHex(await openSeed(ownerPriv, sealed, ownerId, 4, 7))).toBe(bytesToHex(seed))
    await expect(openSeed(ownerPriv, sealed, ownerId, 5, 7)).rejects.toThrow()
    await expect(openSeed(ownerPriv, sealed, ownerId, 4, 8)).rejects.toThrow()
  })
})

/**
 * Fixed byte vectors (R-S11). The derivations are deterministic; the sealed
 * formats were captured once and must keep opening. A change here changes what
 * is on chain: it is a new crypto version, not a refactor.
 */
describe('private feed crypto v2: fixed vectors', () => {
  it('derives the chain, history and node keys', () => {
    expect(bytesToHex(cekAt(seed, 4095, 4095))).toBe(VECTORS.cekTop)
    expect(bytesToHex(cekAt(seed, 4095, 1))).toBe(VECTORS.cek1)
    expect(bytesToHex(historyKey(seed))).toBe(VECTORS.history)
    expect(bytesToHex(nodeKey(seed, 4096 + 5, 1))).toBe(VECTORS.node)
    expect(pathOf(4096, 5)).toEqual([4101, 2050, 1025, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1])
  })

  it('encodes a grant payload', () => {
    const encoded = encodeGrantPayload({ feed: 2, keyGeneration: 3, leafIndex: 1, pathKeys: grantPathKeys(seed, 4, 1, [0]), cek: cekAt(seed, 4095, 3), history: historyKey(seed) })
    expect(bytesToHex(encoded)).toBe(VECTORS.grantPayload)
  })

  it('builds a revocation byte for byte (the rekey is deterministic)', () => {
    const rekey = buildRekey(seed, { treeCapacity: 4, maxKeyGeneration: 4095 }, { ownerId, feed: 1, keyGeneration: 2 }, [], 1)
    expect([bytesToHex(rekey.packets), bytesToHex(rekey.encryptedCEK)]).toEqual([VECTORS.rekey.packets, VECTORS.rekey.encryptedCEK])
  })

  it('opens captured ciphertexts', async () => {
    const binding: ContentBinding = { feedOwnerId: ownerId, feed: 1, keyGeneration: 1, authorId, kind: 'post' }
    expect(decryptContent(cekAt(seed, 4095, 1), hexToBytes(VECTORS.post.ciphertext), hexToBytes(VECTORS.post.nonce), binding)).toBe('vector: pf2 post')
    const carried = openCarry(historyKey(seed), ownerId, 2, hexToBytes(VECTORS.carry))
    expect([carried.feed, carried.finalKeyGeneration, bytesToHex(carried.cek)]).toEqual([1, 9, bytesToHex(cekAt(seed, 4095, 9))])
    const ctx = { ownerId, feed: 1, keyGeneration: 2 }
    const member = grantPathKeys(seed, 4, 0, [])
    const applied = applyRekey(member, decodeRekeyPackets(hexToBytes(VECTORS.rekey.packets), 4), hexToBytes(VECTORS.rekey.encryptedCEK), ctx)
    expect(applied && bytesToHex(applied.cek)).toBe(bytesToHex(cekAt(seed, 4095, 2)))
  })
})

const VECTORS = {
  cekTop: 'beabc76e93e415db2c64401f471b5417a4a631f1fb5c09d65b7d38f8c69fb452',
  cek1: 'd982874a133a2f4048b3ab81ade13eabaa66971825b72505fb0791a70cde76a3',
  history: '6f65df2d8aeda347ccb07e75ef155770230bd256aaed2d5e92a087a114161148',
  node: '261813ebace0f8b76b88c07297d6b27b1e9aa805891750d190292993c3e9ab14',
  grantPayload:
    '020002000300010300050000379e96488cf14d8e1ce9a196ed9ff1f9386bce27595b7ad283dbf3c85e024e8b000200015d70185aae2a2c8982fbcb1d89fe5346' +
    'ff7846653c31e798aa95589f50ca83c60001000136ae3f393d8b35779f655756b31b6cafa76b47326561ded4793b712bc205eeccfa02bbf6e0e9536093f2b33c' +
    'ac6a8a281758b5d2cef759e0a6841cf255c5cdb76f65df2d8aeda347ccb07e75ef155770230bd256aaed2d5e92a087a114161148',
  post: { nonce: '974b395a1af5709586941ca261a57268f99bd7bba992ebde', ciphertext: 'cfa698e944a77e5ad8e0e0f7a16ad685d033419109d25c7afa1956457e7f1556bd' },
  carry:
    '5fabc07e902cbd163a98c140b3f49ff2b81c85c8c8762605e027643e06e79a096a4be2f63c39892061b4156ea1eb76ce73a96ee3d8801d88517c611c362d6460' +
    'e2183ef4e5944e3bc635cad8385e42387080065a8f1d7abbcface3ed550bc9cce8a35833e7c87960086bfe7232',
  rekey: {
    packets:
      '030002000100040000da7bdac5d98118bde30b04fddeaf0d98aa9a5f505ec5f67b2e62f7265472b2484abe35ab6bf67f9e12afadea944578ff000100010003' +
      '00006f2cb6e04378b2824f58d7b5941ecff094f6a725c1fb988ff440c2b1d6e93ca6e6bd1a58580c7d20d9d1884979fa815e0001000100020001647b5dd49ccb' +
      '37e3c3275e3e69d33f07bf0548b2a1e3fcdb9c25d60bdbe5a089bc72703b149d9788b77d4bbdd3af0b2c',
    encryptedCEK: '319b7952bd08d61bcd48424d77e0055b2fd8e3d79b76bef1521c54e238a0612f2f0d79a163b817881f4ee3f9477d0064',
  },
}
