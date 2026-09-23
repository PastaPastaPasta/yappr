import { describe, expect, it } from 'vitest'
import { deriveSelfRoot, deriveStateKey } from './keys'
import { FIELD_MAX } from './padding'
import {
  DIRECT_ENTRY_LENGTH,
  GROUP_ENTRY_LENGTH,
  SELF_STATE_MAX_BYTES,
  type SelfStateFields,
  decodeSelfState,
  decryptSelfState,
  emptySelfState,
  encodeSelfState,
  encryptSelfState,
  mergeSelfStates,
  selfStateFits,
} from './self-state'
import { ALICE_PRIV, BOB_ID, BOB_PRIV, CAROL_ID, hex, key32, unhex } from './test-fixtures'
import type { DirectConversation, GroupConversation, SelfState } from './types'

const STATE_KEY = deriveStateKey(deriveSelfRoot(ALICE_PRIV))
const SIMPLE: SelfState = { ...emptySelfState(), directs: [{ peer: BOB_ID, since: 2900, readAt: 1754000000000 }], nextGroupNumber: 1 }
const FIXED_PLAIN =
  '010001' + 'bb'.repeat(32) + '00000b54' + '00000198628c0400' + '0000' + '0000' + '00' + '0000000000000000' + '0000000000000000' + '00000001' + '00'
const FIXED_BLOB =
  '8debbc2f688af36f6a0c742b8878f88e8744ee4cd984e68ee81579faa992e1b81e68d44e1e226799412537b87e86013a9e6939bdfc34ac23a2c9f8de3ec6a61196efd73a50dd30c8a93c588bec258d8d260c07f242e03bdd147097dae1742b227a58725e15d9e5fb7e6c7da1797dfa4fda136e0a5a44c0e0b40d929e14415da84ccbee7c5d0367905b589e178e682378e87489d78983f2d9ce95698b'

const id = (i: number) => Uint8Array.from({ length: 32 }, (_, k) => (k < 2 ? (i >> (8 * k)) & 0xff : 0x5a))
const direct = (i: number, readAt = 1000 + i): DirectConversation => ({ peer: id(i), since: 2900, readAt })
const group = (i: number, b = 0, r = 0): GroupConversation => ({
  gid: id(i).slice(0, 10),
  owner: id(i + 1),
  earliestEpoch: { b, r },
  earliestKey: key32((b << 4) | r),
  since: 2900,
  readAt: 5000,
})

describe('self-state encoding (§5.5)', () => {
  it('encodes a fixed layout', () => {
    expect(hex(encodeSelfState(SIMPLE))).toBe(FIXED_PLAIN)
  })

  it('round-trips every field', () => {
    const full: SelfState = {
      directs: [direct(1), direct(2)],
      groups: [group(3, 1, 2)],
      blocks: [CAROL_ID],
      settings: { retention: '1y', updatedAt: 1754000000123 },
      inviteScanCursor: 1754000000999,
      nextGroupNumber: 7,
      pastKeys: [],
    }
    expect(decodeSelfState(encodeSelfState(full))).toEqual(full)
    expect(decodeSelfState(encodeSelfState(emptySelfState()))).toEqual(emptySelfState())
  })

  it('uses 44 bytes per 1:1 and 90 per group', () => {
    expect(DIRECT_ENTRY_LENGTH).toBe(44)
    expect(GROUP_ENTRY_LENGTH).toBe(90)
  })

  it('rejects an unknown version, truncation and trailing bytes', () => {
    const encoded = encodeSelfState(SIMPLE)
    expect(() => decodeSelfState(new Uint8Array([2, ...encoded.slice(1)]))).toThrow('version')
    expect(() => decodeSelfState(encoded.slice(0, -1))).toThrow()
    expect(() => decodeSelfState(new Uint8Array([...encoded, 0]))).toThrow('Trailing data')
    const badRetention = encodeSelfState(emptySelfState())
    badRetention[7] = 9
    expect(() => decodeSelfState(badRetention)).toThrow('retention')
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
    // Capacity is 3 × 5120 − 28 (IV + tag) − 2 (length) = 15,330 bytes. 280 1:1s,
    // 20 groups and 10 blocks encode to 29 + 12,320 + 1,800 + 320 = 14,469.
    const atCap: SelfState = {
      ...SIMPLE,
      directs: Array.from({ length: 280 }, (_, i) => direct(i)),
      groups: Array.from({ length: 20 }, (_, i) => group(1000 + i)),
      blocks: Array.from({ length: 10 }, (_, i) => id(2000 + i)),
    }
    expect(encodeSelfState(atCap)).toHaveLength(14_469)
    expect(selfStateFits(atCap)).toBe(true)
    const fields = await encryptSelfState(STATE_KEY, atCap)
    expect(lengths(fields)).toEqual([FIELD_MAX, FIELD_MAX, FIELD_MAX])
    expect(await decryptSelfState(STATE_KEY, fields)).toEqual(atCap)

    const overCap = { ...atCap, directs: [...atCap.directs, ...Array.from({ length: 30 }, (_, i) => direct(3000 + i))] }
    expect(selfStateFits(overCap)).toBe(false)
    await expect(encryptSelfState(STATE_KEY, overCap)).rejects.toThrow('too long')
  })

  it('fits exactly SELF_STATE_MAX_BYTES of encoding and no more', () => {
    // 29 fixed bytes + 44 per 1:1: 348 1:1s = 15,341 > 15,330; 347 = 15,297 fits.
    const withDirects = (n: number) => ({ ...SIMPLE, directs: Array.from({ length: n }, (_, i) => direct(i)) })
    expect(SELF_STATE_MAX_BYTES).toBe(15_330)
    expect(encodeSelfState(withDirects(347)).length).toBe(15_297)
    expect(selfStateFits(withDirects(347))).toBe(true)
    expect(selfStateFits(withDirects(348))).toBe(false)
  })

  it('uses the 8192 class below the cap, split over two fields', async () => {
    const mid = { ...SIMPLE, directs: Array.from({ length: 100 }, (_, i) => direct(i)) }
    const fields = await encryptSelfState(STATE_KEY, mid)
    expect(lengths(fields)).toEqual([FIELD_MAX, 8192 + 28 - FIELD_MAX, null])
    expect(await decryptSelfState(STATE_KEY, fields)).toEqual(mid)
  })
})

describe('self-state merge (§5.5)', () => {
  it('unions conversations and blocks, taking max readAt and min since', () => {
    const remote: SelfState = { ...emptySelfState(), directs: [direct(1, 100), direct(2, 500)], blocks: [BOB_ID] }
    const local: SelfState = {
      ...emptySelfState(),
      directs: [direct(2, 900), { ...direct(3), since: 2800 }, { ...direct(1, 50), since: 2800 }],
      blocks: [BOB_ID, CAROL_ID],
    }
    const merged = mergeSelfStates(remote, local)
    expect(merged.directs).toEqual([
      { ...direct(1, 100), since: 2800 },
      direct(2, 900),
      { ...direct(3), since: 2800 },
    ])
    expect(merged.blocks).toEqual([BOB_ID, CAROL_ID])
  })

  it('keeps the earliest group key and the maximum readAt per group', () => {
    const remote = { ...emptySelfState(), groups: [{ ...group(1, 0, 2), readAt: 10 }] }
    const local = { ...emptySelfState(), groups: [{ ...group(1, 0, 1), readAt: 20 }, group(9)] }
    const merged = mergeSelfStates(remote, local)
    expect(merged.groups).toHaveLength(2)
    expect(merged.groups[0].earliestEpoch).toEqual({ b: 0, r: 1 })
    expect(merged.groups[0].earliestKey).toEqual(group(1, 0, 1).earliestKey)
    expect(merged.groups[0].readAt).toBe(20)
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
    const state: SelfState = { ...SIMPLE, groups: [group(1)], blocks: [CAROL_ID] }
    expect(mergeSelfStates(state, state)).toEqual(state)
  })
})
