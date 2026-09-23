import { describe, expect, it } from 'vitest'
import { deriveSelfRoot, deriveStateKey } from './keys'
import { FIELD_MAX } from './padding'
import {
  BLOCK_ENTRY_LENGTH,
  DIRECT_ENTRY_LENGTH,
  GROUP_ENTRY_LENGTH,
  SELF_STATE_MAX_BYTES,
  type SelfStateFields,
  decodeSelfState,
  decryptSelfState,
  emptySelfState,
  encodeSelfState,
  encryptSelfState,
  isBlocked,
  mergeSelfStates,
  selfStateFits,
} from './self-state'
import { ALICE_PRIV, BOB_ID, BOB_PRIV, CAROL_ID, hex, key32, unhex } from './test-fixtures'
import type { BlockEntry, DirectConversation, GroupConversation, SelfState } from './types'

const STATE_KEY = deriveStateKey(deriveSelfRoot(ALICE_PRIV))
const SIMPLE: SelfState = {
  ...emptySelfState(),
  directs: [{ peer: BOB_ID, since: 2900, readAt: 1754000000000, hiddenAt: 0 }],
  blocks: [{ id: CAROL_ID, blocked: false, changedAt: 1754000000500 }],
  nextGroupNumber: 1,
}
const FIXED_PLAIN =
  '01' +
  ('0001' + 'bb'.repeat(32) + '00000b54' + '00000198628c0400' + '0000000000000000') +
  '0000' +
  ('0001' + 'cc'.repeat(32) + '00' + '00000198628c05f4') +
  '00' + '0000000000000000' + '0000000000000000' + '00000001' + '00'
const FIXED_BLOB =
  '1ed16983839229fd9d8e76c97eae79d7966d3fe7769412ff2bc127006162e0775090e5f181c77dbfa50cad6d84b4b4072ac66e42e6fe21f1cdac4fa76820626a6aedb5a2b56df23158d7eb0cf5e607777ae99d3d0804f365120e5cce1ffed45e592c5c39db214c6cea197ed9d01fb7b49b3b0a29aa153e04f59563301b69b92af8de9dc1b7e90191d5624783530c34b11a7eea4330abe209265b144c'

const id = (i: number) => Uint8Array.from({ length: 32 }, (_, k) => (k < 2 ? (i >> (8 * k)) & 0xff : 0x5a))
const direct = (i: number, readAt = 1000 + i, hiddenAt = 0): DirectConversation => ({ peer: id(i), since: 2900, readAt, hiddenAt })
const block = (i: number, blocked: boolean, changedAt: number): BlockEntry => ({ id: id(i), blocked, changedAt })
const group = (i: number, b = 0, r = 0): GroupConversation => ({
  gid: id(i).slice(0, 10),
  owner: id(i + 1),
  earliestEpoch: { b, r },
  earliestKey: key32((b << 4) | r),
  since: 2900,
  readAt: 5000,
  hiddenAt: 0,
})

describe('self-state encoding (§5.5)', () => {
  it('encodes a fixed layout', () => {
    expect(hex(encodeSelfState(SIMPLE))).toBe(FIXED_PLAIN)
  })

  it('round-trips every field', () => {
    const full: SelfState = {
      directs: [direct(1), direct(2, 50, 1754000000000)],
      groups: [{ ...group(3, 1, 2), hiddenAt: 1754000000001 }],
      blocks: [block(4, true, 9), block(5, false, 10)],
      settings: { retention: '1y', updatedAt: 1754000000123 },
      inviteScanCursor: 1754000000999,
      nextGroupNumber: 7,
      pastKeys: [],
    }
    expect(decodeSelfState(encodeSelfState(full))).toEqual(full)
    expect(decodeSelfState(encodeSelfState(emptySelfState()))).toEqual(emptySelfState())
  })

  it('uses 52 bytes per 1:1, 98 per group and 41 per block entry', () => {
    expect(DIRECT_ENTRY_LENGTH).toBe(52)
    expect(GROUP_ENTRY_LENGTH).toBe(98)
    expect(BLOCK_ENTRY_LENGTH).toBe(41)
  })

  it('reports only entries with blocked = true as blocked', () => {
    const state = { ...emptySelfState(), blocks: [block(1, true, 5), block(2, false, 6)] }
    expect(isBlocked(state, id(1))).toBe(true)
    expect(isBlocked(state, id(2))).toBe(false)
    expect(isBlocked(state, id(3))).toBe(false)
  })

  it('rejects an unknown version, truncation and trailing bytes', () => {
    const encoded = encodeSelfState(SIMPLE)
    expect(() => decodeSelfState(new Uint8Array([2, ...encoded.slice(1)]))).toThrow('version')
    expect(() => decodeSelfState(encoded.slice(0, -1))).toThrow()
    expect(() => decodeSelfState(new Uint8Array([...encoded, 0]))).toThrow('Trailing data')
    const badRetention = encodeSelfState(emptySelfState())
    badRetention[7] = 9
    expect(() => decodeSelfState(badRetention)).toThrow('retention')
    const badFlag = encodeSelfState(SIMPLE)
    badFlag[1 + 2 + 52 + 2 + 2 + 32] = 2
    expect(() => decodeSelfState(badFlag)).toThrow('blocked flag')
  })
})

describe('self-state encryption', () => {
  const only = (blob: Uint8Array) => ({ blob, blob2: null, blob3: null })
  const lengths = (f: SelfStateFields) => [f.blob, f.blob2, f.blob3].map((b) => b?.length ?? null)

  it('decrypts a fixed blob', async () => {
    expect(await decryptSelfState(STATE_KEY, only(unhex(FIXED_BLOB)))).toEqual(SIMPLE)
  })

  it('round-trips in one field when small, clearing blob2 and blob3', async () => {
    const fields = await encryptSelfState(STATE_KEY, SIMPLE)
    expect(lengths(fields)).toEqual([156, null, null])
    expect(await decryptSelfState(STATE_KEY, fields)).toEqual(SIMPLE)
  })

  it('fails with the wrong key or on tampering', async () => {
    const other = deriveStateKey(deriveSelfRoot(BOB_PRIV))
    await expect(decryptSelfState(other, only(unhex(FIXED_BLOB)))).rejects.toThrow()
    const tampered = unhex(FIXED_BLOB)
    tampered[20] ^= 1
    await expect(decryptSelfState(STATE_KEY, only(tampered))).rejects.toThrow()
  })

  it('fails when a stale blob2 is left behind or blob3 comes without blob2', async () => {
    const big = await encryptSelfState(STATE_KEY, { ...SIMPLE, directs: Array.from({ length: 100 }, (_, i) => direct(i)) })
    const small = await encryptSelfState(STATE_KEY, SIMPLE)
    await expect(decryptSelfState(STATE_KEY, { ...small, blob2: big.blob2 })).rejects.toThrow()
    await expect(decryptSelfState(STATE_KEY, { ...big, blob2: null, blob3: big.blob2 })).rejects.toThrow('blob3 without blob2')
  })

  it('fits about 300 conversations in three fields', async () => {
    // Capacity is 3 × 5120 − 28 (IV + tag) − 2 (length) = 15,330 bytes. 270 1:1s,
    // 10 groups and 5 blocks encode to 29 + 14,040 + 980 + 205 = 15,254.
    const atCap: SelfState = {
      ...SIMPLE,
      directs: Array.from({ length: 270 }, (_, i) => direct(i)),
      groups: Array.from({ length: 10 }, (_, i) => group(1000 + i)),
      blocks: Array.from({ length: 5 }, (_, i) => block(2000 + i, true, i)),
    }
    expect(encodeSelfState(atCap)).toHaveLength(15_254)
    expect(selfStateFits(atCap)).toBe(true)
    const fields = await encryptSelfState(STATE_KEY, atCap)
    expect(lengths(fields)).toEqual([FIELD_MAX, FIELD_MAX, FIELD_MAX])
    expect(await decryptSelfState(STATE_KEY, fields)).toEqual(atCap)

    const overCap = { ...atCap, directs: [...atCap.directs, ...Array.from({ length: 5 }, (_, i) => direct(3000 + i))] }
    expect(selfStateFits(overCap)).toBe(false)
    await expect(encryptSelfState(STATE_KEY, overCap)).rejects.toThrow('too long')
  })

  it('fits exactly SELF_STATE_MAX_BYTES of encoding and no more', () => {
    // 29 fixed bytes + 52 per 1:1: 294 1:1s = 15,317 fits; 295 = 15,369 does not.
    const withDirects = (n: number) => ({ ...emptySelfState(), directs: Array.from({ length: n }, (_, i) => direct(i)) })
    expect(SELF_STATE_MAX_BYTES).toBe(15_330)
    expect(encodeSelfState(withDirects(294)).length).toBe(15_317)
    expect(selfStateFits(withDirects(294))).toBe(true)
    expect(selfStateFits(withDirects(295))).toBe(false)
  })

  it('uses the 8192 class below the cap, split over two fields', async () => {
    const mid = { ...SIMPLE, directs: Array.from({ length: 100 }, (_, i) => direct(i)) }
    const fields = await encryptSelfState(STATE_KEY, mid)
    expect(lengths(fields)).toEqual([FIELD_MAX, 8192 + 28 - FIELD_MAX, null])
    expect(await decryptSelfState(STATE_KEY, fields)).toEqual(mid)
  })
})

describe('self-state merge (§5.5)', () => {
  it('unions conversations, taking max readAt, max hiddenAt and min since', () => {
    const remote: SelfState = { ...emptySelfState(), directs: [direct(1, 100, 700), direct(2, 500)] }
    const local: SelfState = {
      ...emptySelfState(),
      directs: [direct(2, 900, 300), { ...direct(3), since: 2800 }, { ...direct(1, 50, 200), since: 2800 }],
    }
    const merged = mergeSelfStates(remote, local)
    expect(merged.directs).toEqual([
      { ...direct(1, 100, 700), since: 2800 },
      direct(2, 900, 300),
      { ...direct(3), since: 2800 },
    ])
  })

  it('merges block entries by the newer change, so an unblock survives', () => {
    const remote: SelfState = { ...emptySelfState(), blocks: [block(1, true, 100), block(2, true, 100)] }
    const local: SelfState = { ...emptySelfState(), blocks: [block(1, false, 200), block(2, false, 50), block(3, true, 10)] }
    const merged = mergeSelfStates(remote, local)
    expect(merged.blocks).toEqual([block(1, false, 200), block(2, true, 100), block(3, true, 10)])
    expect(isBlocked(merged, id(1))).toBe(false)
    // Either argument order gives the same result, and a tie keeps the saved entry.
    expect(mergeSelfStates(local, remote).blocks).toEqual([block(1, false, 200), block(2, true, 100), block(3, true, 10)])
    const tie = mergeSelfStates({ ...emptySelfState(), blocks: [block(1, true, 5)] }, { ...emptySelfState(), blocks: [block(1, false, 5)] })
    expect(tie.blocks).toEqual([block(1, true, 5)])
  })

  it('keeps the earliest group key and the maximum readAt and hiddenAt per group', () => {
    const remote = { ...emptySelfState(), groups: [{ ...group(1, 0, 2), readAt: 10, hiddenAt: 40 }] }
    const local = { ...emptySelfState(), groups: [{ ...group(1, 0, 1), readAt: 20, hiddenAt: 30 }, group(9)] }
    const merged = mergeSelfStates(remote, local)
    expect(merged.groups).toHaveLength(2)
    expect(merged.groups[0].earliestEpoch).toEqual({ b: 0, r: 1 })
    expect(merged.groups[0].earliestKey).toEqual(group(1, 0, 1).earliestKey)
    expect(merged.groups[0].readAt).toBe(20)
    expect(merged.groups[0].hiddenAt).toBe(40)
    const baseWins = mergeSelfStates({ ...emptySelfState(), groups: [group(1, 1, 0)] }, { ...emptySelfState(), groups: [group(1, 0, 5)] })
    expect(baseWins.groups[0].earliestEpoch).toEqual({ b: 0, r: 5 })
  })

  it('takes the newer settings, the saved ones on a tie', () => {
    const remote = { ...emptySelfState(), settings: { retention: '90d' as const, updatedAt: 200 } }
    const newer = { ...emptySelfState(), settings: { retention: 'never' as const, updatedAt: 300 } }
    const tie = { ...emptySelfState(), settings: { retention: '1y' as const, updatedAt: 200 } }
    expect(mergeSelfStates(remote, newer).settings.retention).toBe('never')
    expect(mergeSelfStates(newer, remote).settings.retention).toBe('never')
    expect(mergeSelfStates(remote, tie).settings.retention).toBe('90d')
  })

  it('never reuses a group number and never skips invites', () => {
    const remote = { ...emptySelfState(), nextGroupNumber: 4, inviteScanCursor: 900 }
    const local = { ...emptySelfState(), nextGroupNumber: 2, inviteScanCursor: 1200 }
    const merged = mergeSelfStates(remote, local)
    expect(merged.nextGroupNumber).toBe(4)
    expect(merged.inviteScanCursor).toBe(900)
  })

  it('gives the same conversations and settings in either argument order', () => {
    const a: SelfState = { ...emptySelfState(), directs: [direct(1, 10)], settings: { retention: '1y', updatedAt: 5 } }
    const b: SelfState = { ...emptySelfState(), directs: [direct(1, 20), direct(2)], settings: { retention: 'never', updatedAt: 9 } }
    const ab = mergeSelfStates(a, b)
    const ba = mergeSelfStates(b, a)
    expect(ab.settings).toEqual(ba.settings)
    expect(new Set(ab.directs.map((d) => hex(d.peer) + d.readAt))).toEqual(new Set(ba.directs.map((d) => hex(d.peer) + d.readAt)))
  })

  it('can produce a state too big to save, which selfStateFits reports', () => {
    const half = (offset: number) => ({ ...emptySelfState(), directs: Array.from({ length: 200 }, (_, i) => direct(offset + i)) })
    expect(selfStateFits(half(0))).toBe(true)
    expect(selfStateFits(mergeSelfStates(half(0), half(1000)))).toBe(false)
  })

  it('is idempotent', () => {
    const state: SelfState = { ...SIMPLE, groups: [group(1)] }
    expect(mergeSelfStates(state, state)).toEqual(state)
  })
})
