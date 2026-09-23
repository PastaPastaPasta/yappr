import { describe, expect, it } from 'vitest'
import { bucketFor, bucketLevels, createInvite, isInviteForMe, senderBucketLevel } from './invite'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, BOB_PUB, CAROL_ID, hex, key32 } from './test-fixtures'

describe('invite (§5.1)', () => {
  const fixed = () =>
    createInvite({ recipientPublicKey: BOB_PUB, recipientId: BOB_ID, senderId: ALICE_ID, bucketLevel: 0, ephemeralPrivateKey: key32(7) })

  it('matches a fixed vector', () => {
    const invite = fixed()
    expect(invite.bucket).toBe(1)
    expect(hex(invite.epk)).toBe('02989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f')
    expect(hex(invite.check)).toBe('f51ea07e6a9696bd1c75eee36655f4c2')
  })

  it('is recognised by the recipient, for the signed sender only', () => {
    const invite = createInvite({ recipientPublicKey: BOB_PUB, recipientId: BOB_ID, senderId: ALICE_ID, bucketLevel: 0 })
    expect(invite.epk).toHaveLength(33)
    expect(invite.check).toHaveLength(16)
    expect(isInviteForMe(BOB_PRIV, invite, ALICE_ID)).toBe(true)
    expect(isInviteForMe(ALICE_PRIV, invite, ALICE_ID)).toBe(false)
    // Re-posted by someone else: $ownerId changes, the check fails.
    expect(isInviteForMe(BOB_PRIV, invite, CAROL_ID)).toBe(false)
  })

  it('uses a fresh ephemeral key per invite', () => {
    const a = createInvite({ recipientPublicKey: BOB_PUB, recipientId: BOB_ID, senderId: ALICE_ID, bucketLevel: 0 })
    const b = createInvite({ recipientPublicKey: BOB_PUB, recipientId: BOB_ID, senderId: ALICE_ID, bucketLevel: 0 })
    expect(hex(a.epk)).not.toBe(hex(b.epk))
    expect(hex(a.check)).not.toBe(hex(b.check))
  })

  it('fails on a tampered check or epk, and treats a malformed epk as not mine', () => {
    const invite = fixed()
    const badCheck = { ...invite, check: invite.check.map((b, i) => (i === 0 ? b ^ 1 : b)) }
    expect(isInviteForMe(BOB_PRIV, badCheck, ALICE_ID)).toBe(false)
    const offCurve = { ...invite, epk: new Uint8Array(33).fill(0xff) }
    expect(isInviteForMe(BOB_PRIV, offCurve, ALICE_ID)).toBe(false)
    expect(isInviteForMe(BOB_PRIV, { ...invite, epk: invite.epk.slice(1) }, ALICE_ID)).toBe(false)
  })
})

describe('buckets (§5.1.2)', () => {
  it('matches a fixed vector: [1, 2|p1, 4|p2]', () => {
    // HKDF(BOB_ID, "bucket\0")[0:2] = 0x51f1 = 0b0101…: p1 = 0, p2 = 01.
    expect(bucketLevels(BOB_ID)).toEqual([1, 2, 5])
  })

  it('puts every recipient in bucket 1 at level 0 and keeps levels disjoint', () => {
    for (const id of [ALICE_ID, BOB_ID, CAROL_ID]) {
      const [l0, l1, l2] = bucketLevels(id)
      expect(l0).toBe(1)
      expect([2, 3]).toContain(l1)
      expect([4, 5, 6, 7]).toContain(l2)
      expect(l2 >> 1).toBe(l1)
    }
  })

  it('rejects levels outside 0..2', () => {
    expect(() => bucketFor(BOB_ID, 3)).toThrow()
    expect(() => bucketFor(BOB_ID, -1)).toThrow()
  })

  it('picks k from observed rates: clamp(ceil(log2(V / B)), 0, 2)', () => {
    expect(senderBucketLevel(null)).toBe(0)
    expect(senderBucketLevel({ level0: 0, level1: 0, level2: 0 })).toBe(0)
    expect(senderBucketLevel({ level0: 30, level1: 0, level2: 0 })).toBe(0)
    expect(senderBucketLevel({ level0: 900, level1: 0, level2: 0 })).toBe(0)
    expect(senderBucketLevel({ level0: 901, level1: 0, level2: 0 })).toBe(1)
    // V = 100 + 2·400 + 4·200 = 1700 → ceil(log2(1.89)) = 1
    expect(senderBucketLevel({ level0: 100, level1: 400, level2: 200 })).toBe(1)
    expect(senderBucketLevel({ level0: 1801, level1: 0, level2: 0 })).toBe(2)
    expect(senderBucketLevel({ level0: 1e9, level1: 0, level2: 0 })).toBe(2)
  })
})
