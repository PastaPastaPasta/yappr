import { describe, expect, it } from 'vitest'
import { getPublicKey } from '@/lib/crypto/keys'
import {
  MAX_GROUP_MEMBERS,
  buildKeyring,
  decodeRoster,
  encodeRoster,
  encryptRoster,
  keyringHandle,
  keyringNonce,
  keyringSlotCount,
  openKeyringSlot,
  ownerKeyringBaseKey,
  openRoster,
  rosterHandle,
  rosterKey,
  slotPad,
} from './group'
import { deriveBaseKey, deriveEpochKey, deriveGroupId, deriveGroupSecret, deriveSelfRoot, keyCheck } from './keys'

import { FIELD_MAX } from './padding'
import { ALICE_ID, ALICE_PRIV, ALICE_PUB, BOB_ID, BOB_PRIV, BOB_PUB, CAROL_ID, CAROL_PRIV, CAROL_PUB, hex, unhex } from './test-fixtures'
import type { KeyringMember, RosterContent } from './types'

const GID = deriveGroupId(deriveSelfRoot(ALICE_PRIV), 0)
const SECRET = deriveGroupSecret(ALICE_PRIV, GID)

// Alice's roster for group 0 at epoch (0, 1) with members alice, bob, carol.
const ROSTER: RosterContent = { b: 0, r: 1, name: 'g', avatarRef: '', members: [ALICE_ID, BOB_ID, CAROL_ID], ended: false }
const FIXED_ROSTER_BLOB =
  '41ae68386b175e104b2aac5beac9c4e5dc69e5b3ed264e461319d0b5f444ebe8213b71640fa21cb347302df3a08685dc282316a59309779a26e0afa45edd1233f7feae76bf7ec330eec78ec2e26a878b3bed1cd535ac3c7efe791942ffbf75f4523ef9fbe107a8ae0849914f64bf7146d895af6f0724570b29bd2a3742dfdba2c8eb3f660f8bbb3643ddf5d0fbf9cff1abcbb66169db877433de1c1d'

const NONCE = Uint8Array.from({ length: 16 }, (_, i) => 0xf0 + i)
const BOB_ONLY = [{ id: BOB_ID, publicKey: BOB_PUB }]
const keyringParams = (b: number, members: KeyringMember[] = BOB_ONLY) => ({
  ownerPrivateKey: ALICE_PRIV,
  ownerId: ALICE_ID,
  gid: GID,
  b,
  groupSecret: SECRET,
  members,
})

const memberPriv = (i: number) => Uint8Array.from({ length: 32 }, (_, k) => (k === 0 ? 0x10 : k === 31 ? i + 1 : 0x33))
const memberId = (i: number) => Uint8Array.from({ length: 32 }, (_, k) => (k === 0 ? 0x01 : k === 1 ? i : 0x77))
const member = (i: number): KeyringMember => ({ id: memberId(i), publicKey: getPublicKey(memberPriv(i)) })

describe('handles (§5.2)', () => {
  it('match fixed vectors', () => {
    expect(hex(rosterHandle(GID))).toBe('849ab72e30df7b04b399')
    expect(hex(keyringHandle(GID, 1))).toBe('eab73774f8e7d23f3cf6')
  })

  it('differ per base, per group and between roster and keyring', () => {
    const other = deriveGroupId(deriveSelfRoot(ALICE_PRIV), 1)
    const handles = [rosterHandle(GID), keyringHandle(GID, 0), keyringHandle(GID, 1), keyringHandle(GID, 2), rosterHandle(other)].map(hex)
    expect(new Set(handles).size).toBe(handles.length)
  })
})

describe('keyring slots (§4.5, §5.3)', () => {
  const ctx = { gid: GID, ownerId: ALICE_ID, memberId: BOB_ID, b: 1 }

  it('matches a fixed pad vector, and owner and member compute the same pad', () => {
    const ownerSide = slotPad({ ...ctx, myPrivateKey: ALICE_PRIV, otherPublicKey: BOB_PUB })
    expect(hex(ownerSide)).toBe('e82717d524f53f67e92880d4dc751d174956142d1a377a6597b05df20a96219c')
    expect(slotPad({ ...ctx, myPrivateKey: BOB_PRIV, otherPublicKey: ALICE_PUB })).toEqual(ownerSide)
  })

  it('binds gid, both ids and the base into the pad', () => {
    const pads = [
      ctx,
      { ...ctx, b: 2 },
      { ...ctx, memberId: CAROL_ID },
      { ...ctx, ownerId: CAROL_ID },
      { ...ctx, gid: deriveGroupId(deriveSelfRoot(ALICE_PRIV), 1) },
    ].map((c) => hex(slotPad({ ...c, myPrivateKey: ALICE_PRIV, otherPublicKey: BOB_PUB })))
    expect(new Set(pads).size).toBe(pads.length)
  })

  it('pads the slot count to a power of two in 8..128', () => {
    expect([0, 1, 7, 8, 9, 16, 17, 64, 65, 99, 128].map(keyringSlotCount)).toEqual([8, 8, 8, 8, 16, 16, 32, 64, 128, 128, 128])
    expect(() => keyringSlotCount(129)).toThrow()
  })

  it('writes nonce_b | kc | slots with a fixed nonce, and the owner re-derives K[b,0] from S + nonce', () => {
    const built = buildKeyring({ ...keyringParams(1), nonce: NONCE })
    expect(built.nonce).toEqual(NONCE)
    expect(hex(built.baseKey)).toBe('8b709d3eb47470a89055afbc6bea97dabce4e4621c03fbe65ca6bff2ac5ef8b2')
    expect(hex(built.blob.slice(0, 24))).toBe('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff' + 'e17886bd649503d6')
    expect(built.blob).toHaveLength(16 + 8 + 8 * 32)
    expect(keyringNonce(built.blob)).toEqual(NONCE)
    expect(ownerKeyringBaseKey(SECRET, 1, built.blob)).toEqual(built.baseKey)
    expect(ownerKeyringBaseKey(SECRET, 2, built.blob)).toBeNull()
    expect(ownerKeyringBaseKey(deriveGroupSecret(BOB_PRIV, GID), 1, built.blob)).toBeNull()
    expect(keyringNonce(built.blob.slice(0, 24))).toBeNull()
  })

  it('draws a fresh nonce per keyring, so a race-rejected keyring wraps an unused key', () => {
    const a = buildKeyring(keyringParams(1))
    const b = buildKeyring(keyringParams(1))
    expect(hex(a.nonce)).not.toBe(hex(b.nonce))
    expect(hex(a.baseKey)).not.toBe(hex(b.baseKey))
    expect(ownerKeyringBaseKey(SECRET, 1, a.blob)).toEqual(a.baseKey)
    expect(ownerKeyringBaseKey(SECRET, 1, b.blob)).toEqual(b.baseKey)
  })

  it('refuses base 0, which grants deliver at creation', () => {
    expect(() => buildKeyring(keyringParams(0))).toThrow('base 1')
  })

  it('lets each remaining member, and only them, unwrap K[b,0]', () => {
    const { blob: keyring, baseKey } = buildKeyring(keyringParams(1))
    expect(hex(keyring.slice(16, 24))).toBe(hex(keyCheck(baseKey)))
    const asBob = { gid: GID, ownerId: ALICE_ID, memberId: BOB_ID, b: 1, myPrivateKey: BOB_PRIV, otherPublicKey: ALICE_PUB }
    expect(openKeyringSlot(keyring, asBob)).toEqual(baseKey)
    // Carol was removed: no slot.
    expect(openKeyringSlot(keyring, { ...asBob, memberId: CAROL_ID, myPrivateKey: CAROL_PRIV })).toBeNull()
    // Wrong base: the pad no longer matches.
    expect(openKeyringSlot(keyring, { ...asBob, b: 2 })).toBeNull()
    // The owner learns who holds a slot with the same check (§6.5).
    expect(openKeyringSlot(keyring, { ...asBob, myPrivateKey: ALICE_PRIV, otherPublicKey: BOB_PUB })).toEqual(baseKey)
    expect(openKeyringSlot(keyring, { ...asBob, memberId: CAROL_ID, myPrivateKey: ALICE_PRIV, otherPublicKey: CAROL_PUB })).toBeNull()
  })

  it('fails on a tampered kc or slot, and on a malformed keyring', () => {
    const { blob: keyring } = buildKeyring(keyringParams(1))
    const asBob = { gid: GID, ownerId: ALICE_ID, memberId: BOB_ID, b: 1, myPrivateKey: BOB_PRIV, otherPublicKey: ALICE_PUB }
    const badKc = keyring.slice()
    badKc[16] ^= 1
    expect(openKeyringSlot(badKc, asBob)).toBeNull()
    const allSlotsFlipped = keyring.map((b, i) => (i >= 24 && i % 32 === 24 ? b ^ 1 : b))
    expect(openKeyringSlot(allSlotsFlipped, asBob)).toBeNull()
    expect(openKeyringSlot(keyring.slice(0, 24), asBob)).toBeNull()
    expect(openKeyringSlot(keyring.slice(0, 40), asBob)).toBeNull()
  })

  it('rejects more than 99 non-owner members, a short nonce and short ids', () => {
    const params = keyringParams(3)
    expect(() => buildKeyring({ ...params, members: Array.from({ length: 100 }, () => BOB_ONLY[0]) })).toThrow('Too many')
    expect(() => buildKeyring({ ...params, nonce: NONCE.slice(1) })).toThrow('16 bytes')
    expect(() => buildKeyring({ ...params, members: [{ id: BOB_ID.slice(1), publicKey: BOB_PUB }] })).toThrow('32 bytes')
  })

  it('fits a 100-member group (99 slots → 128) in one field, with the slot order shuffled', () => {
    const members = Array.from({ length: MAX_GROUP_MEMBERS - 1 }, (_, i) => member(i))
    const params = { ...keyringParams(3, members), nonce: NONCE }
    const { blob: keyring, baseKey } = buildKeyring(params)
    expect(keyring).toHaveLength(16 + 8 + 128 * 32)
    expect(keyring.length).toBe(4120)
    expect(keyring.length).toBeLessThanOrEqual(FIELD_MAX)
    for (const i of [0, 50, 98]) {
      const ctx = { gid: GID, ownerId: ALICE_ID, memberId: memberId(i), b: 3, myPrivateKey: memberPriv(i), otherPublicKey: ALICE_PUB }
      expect(openKeyringSlot(keyring, ctx)).toEqual(baseKey)
    }
    // Two builds with the same nonce differ only by random filler and order.
    const again = buildKeyring(params)
    expect(again.baseKey).toEqual(baseKey)
    expect(hex(again.blob)).not.toBe(hex(keyring))
  })
})

describe('roster (§5.4)', () => {
  const k01 = deriveEpochKey(SECRET, 0, 1)

  it('encodes a fixed layout', () => {
    expect(hex(encodeRoster(ROSTER))).toBe(
      '0000000100000167000003' + 'aa'.repeat(32) + 'bb'.repeat(32) + 'cc'.repeat(32)
    )
  })

  it('round-trips the encoding and rejects malformed input', () => {
    const full: RosterContent = { b: 2, r: 7, name: 'Füße 🎉', avatarRef: 'ipfs://x', members: [ALICE_ID], ended: true }
    expect(decodeRoster(encodeRoster(full))).toEqual(full)
    const encoded = encodeRoster(ROSTER)
    expect(() => decodeRoster(encoded.slice(0, -1))).toThrow()
    expect(() => decodeRoster(new Uint8Array([...encoded, 0]))).toThrow('Trailing data')
    const badFlag = encoded.slice()
    badFlag[4] = 2
    expect(() => decodeRoster(badFlag)).toThrow()
    expect(() => encodeRoster({ ...ROSTER, members: [new Uint8Array(31)] })).toThrow()
  })

  it('opens a fixed blob', async () => {
    const opened = await openRoster({ blob: unhex(FIXED_ROSTER_BLOB), gid: GID, known: { b: 0, r: 1, key: k01 }, maxSteps: 0 })
    expect(opened?.content).toEqual(ROSTER)
    expect(hex(rosterKey(deriveBaseKey(SECRET, 0)))).toBe('418734a41ca3f0ff68d32550a589a8947bf10efd49e7a488f7b18ad2e38ab382')
  })

  it('fits a 100-member roster in the 4096 class', async () => {
    const members = Array.from({ length: MAX_GROUP_MEMBERS }, (_, i) => memberId(i))
    const blob = await encryptRoster(k01, GID, { ...ROSTER, name: 'n'.repeat(100), avatarRef: 'a'.repeat(100), members })
    expect(blob).toHaveLength(4096 + 28)
    expect(() => encodeRoster({ ...ROSTER, members: [...members, ALICE_ID] })).toThrow()
  })

  it('ratchets forward from an older key, bounded by maxSteps', async () => {
    const k00 = deriveBaseKey(SECRET, 0)
    const at3 = { ...ROSTER, r: 3 }
    const blob = await encryptRoster(deriveEpochKey(SECRET, 0, 3), GID, at3)
    expect(await openRoster({ blob, gid: GID, known: { b: 0, r: 0, key: k00 }, maxSteps: 2 })).toBeNull()
    const opened = await openRoster({ blob, gid: GID, known: { b: 0, r: 0, key: k00 }, maxSteps: 3 })
    expect(opened?.content).toEqual(at3)
    expect(opened?.key).toEqual(deriveEpochKey(SECRET, 0, 3))
    // A newer key cannot read an older roster.
    expect(await openRoster({ blob, gid: GID, known: { b: 0, r: 4, key: deriveEpochKey(SECRET, 0, 4) }, maxSteps: 5 })).toBeNull()
  })

  it('fails with a different base, a different group handle, or tampering', async () => {
    const blob = unhex(FIXED_ROSTER_BLOB)
    expect(await openRoster({ blob, gid: GID, known: { b: 1, r: 0, key: deriveBaseKey(SECRET, 1, NONCE) }, maxSteps: 5 })).toBeNull()
    const otherGid = deriveGroupId(deriveSelfRoot(ALICE_PRIV), 1)
    expect(await openRoster({ blob, gid: otherGid, known: { b: 0, r: 1, key: k01 }, maxSteps: 0 })).toBeNull()
    const tampered = blob.slice()
    tampered[30] ^= 1
    expect(await openRoster({ blob: tampered, gid: GID, known: { b: 0, r: 1, key: k01 }, maxSteps: 0 })).toBeNull()
  })

  it('returns null, not a throw, for blobs too short to be sealed', async () => {
    for (const n of [0, 12, 27]) {
      expect(await openRoster({ blob: new Uint8Array(n), gid: GID, known: { b: 0, r: 1, key: k01 }, maxSteps: 2 })).toBeNull()
    }
  })

  it('stops the ratchet trial at r = 65535', async () => {
    const blob = unhex(FIXED_ROSTER_BLOB)
    const known = { b: 0, r: 0xfffe, key: k01 }
    expect(await openRoster({ blob, gid: GID, known, maxSteps: 10 })).toBeNull()
  })

  it('rejects a roster whose content claims a different epoch from its key', async () => {
    const lying = await encryptRoster(k01, GID, { ...ROSTER, r: 5 })
    expect(await openRoster({ blob: lying, gid: GID, known: { b: 0, r: 1, key: k01 }, maxSteps: 0 })).toBeNull()
  })
})
