import { describe, expect, it } from 'vitest'
import {
  compareIds,
  deriveBaseKey,
  deriveDirectKeys,
  deriveEpochKey,
  deriveGroupId,
  deriveGroupSecret,
  deriveSelfRoot,
  deriveStateKey,
  keyCheck,
  ratchetKey,
  ratchetTo,
} from './keys'
import { selfStateKey } from './self-state'
import { ALICE_ID, ALICE_PRIV, ALICE_PUB, BOB_ID, BOB_PRIV, BOB_PUB, CAROL_ID, CAROL_PRIV, hex } from './test-fixtures'

// Vectors cross-checked against an independent Python implementation
// (hmac/hashlib HKDF plus textbook secp256k1 arithmetic).
const SELF_ROOT = '14ff63b2aa5fa46ba42ac6f719db5e143ca0288acc7b69ecb8d9cc47f5b7a712'
const GID0 = '36bcf5d162c4be1412d2'
const S = '09df887776f155aa1ada8c34c1fa9dc47e0d611349ee0885d9af89aa3f108ea2'
const K00 = '3a0eae4626a88c84996ef6c3b02a46e99a6ec84627ea9ed7e1b240cd97d6b0e4'

describe('fixture keys', () => {
  it('are the expected secp256k1 public keys', () => {
    expect(hex(ALICE_PUB)).toBe('0284bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0')
    expect(hex(BOB_PUB)).toBe('0336b341ece77e1fc4c270c6cedc987f8f3d217be3ad4922cbc64db8c40a77f737')
  })
})

describe('self keys (§4.2, §5.5)', () => {
  it('derives selfRoot, stateKey and the self-state key', () => {
    const selfRoot = deriveSelfRoot(ALICE_PRIV)
    expect(hex(selfRoot)).toBe(SELF_ROOT)
    expect(hex(deriveStateKey(selfRoot))).toBe('bda39500f08f0e806310ad1fb502067b61507eae6ddbed0ae8ee64ca349fcd67')
    expect(hex(selfStateKey(deriveStateKey(selfRoot)))).toBe('99826dcb48670a75981077947e1ab5fcf084ce2ceb2918fb25c55f3f02fd1b3b')
  })
})

describe('1:1 keys (§4.3)', () => {
  it('matches a fixed vector', () => {
    const { gid, key } = deriveDirectKeys(ALICE_PRIV, BOB_PUB, ALICE_ID, BOB_ID)
    expect(hex(gid)).toBe('03ed4b522c770ffcff96')
    expect(hex(key)).toBe('67dc8bd78bf5a9abcc1c6be28cbae85e6a013e0f2d2b78d4a4e971e25e76e182')
  })

  it('is the same from both sides', () => {
    expect(deriveDirectKeys(BOB_PRIV, ALICE_PUB, BOB_ID, ALICE_ID)).toEqual(deriveDirectKeys(ALICE_PRIV, BOB_PUB, ALICE_ID, BOB_ID))
  })

  it('differs for a different pair or a different id binding', () => {
    const ab = deriveDirectKeys(ALICE_PRIV, BOB_PUB, ALICE_ID, BOB_ID)
    const cb = deriveDirectKeys(CAROL_PRIV, BOB_PUB, CAROL_ID, BOB_ID)
    const abWrongIds = deriveDirectKeys(ALICE_PRIV, BOB_PUB, CAROL_ID, BOB_ID)
    expect(hex(cb.key)).not.toBe(hex(ab.key))
    expect(hex(abWrongIds.gid)).not.toBe(hex(ab.gid))
  })

  it('refuses a conversation with oneself and ids that are not 32 bytes', () => {
    expect(() => deriveDirectKeys(ALICE_PRIV, ALICE_PUB, ALICE_ID, ALICE_ID)).toThrow()
    expect(() => deriveDirectKeys(ALICE_PRIV, BOB_PUB, ALICE_ID, BOB_ID.slice(1))).toThrow('32 bytes')
  })

  it('orders ids by byte value', () => {
    expect(compareIds(ALICE_ID, BOB_ID)).toBeLessThan(0)
    expect(compareIds(BOB_ID, ALICE_ID)).toBeGreaterThan(0)
    expect(compareIds(ALICE_ID, ALICE_ID)).toBe(0)
  })
})

describe('group keys (§4.4)', () => {
  const selfRoot = deriveSelfRoot(ALICE_PRIV)
  const gid = deriveGroupId(selfRoot, 0)
  const secret = deriveGroupSecret(ALICE_PRIV, gid)

  it('matches fixed vectors for gid_n, S, K[b,0], K[b,r] and kc', () => {
    expect(hex(gid)).toBe(GID0)
    expect(hex(deriveGroupId(selfRoot, 1))).toBe('47dd97bf50711ee2a227')
    expect(hex(secret)).toBe(S)
    expect(hex(deriveBaseKey(secret, 0))).toBe(K00)
    expect(hex(deriveBaseKey(secret, 1))).toBe('1f70f0fab150088a55608f9a044a41e7533dcba703034c09461ce4587a672954')
    expect(hex(deriveEpochKey(secret, 0, 1))).toBe('f99b9488a2b08f40dbad60e9d7f0e5c9608d4c307ab6ed14b14eba4e52f1a403')
    expect(hex(deriveEpochKey(secret, 0, 2))).toBe('67d6138636598796bcf0047ec1f0ee5da29ff72e32af6a475f7532ba6113d981')
    expect(hex(keyCheck(deriveBaseKey(secret, 0)))).toBe('39c7f9f34a8dd95c')
  })

  it('lets anyone holding K[b,r] step forward to the owner-derived K[b,r+n]', () => {
    const k1 = deriveEpochKey(secret, 0, 1)
    expect(ratchetTo(k1, 0, 1, 5)).toEqual(deriveEpochKey(secret, 0, 5))
    expect(ratchetKey(k1, 0, 2)).toEqual(deriveEpochKey(secret, 0, 2))
    expect(ratchetTo(k1, 0, 1, 1)).toEqual(k1)
  })

  it('never steps back', () => {
    expect(() => ratchetTo(deriveEpochKey(secret, 0, 3), 0, 3, 2)).toThrow()
    expect(() => ratchetKey(deriveBaseKey(secret, 0), 0, 0)).toThrow()
  })

  it('binds the base into each ratchet step', () => {
    const k = deriveBaseKey(secret, 0)
    expect(hex(ratchetKey(k, 0, 1))).not.toBe(hex(ratchetKey(k, 1, 1)))
  })

  it('gives different owners different groups and secrets', () => {
    const bobGid = deriveGroupId(deriveSelfRoot(BOB_PRIV), 0)
    expect(hex(bobGid)).not.toBe(GID0)
    expect(hex(deriveGroupSecret(BOB_PRIV, gid))).not.toBe(S)
  })

  it('separates labels applied to the same key', () => {
    const k = deriveBaseKey(secret, 0)
    const outputs = [k, ratchetKey(k, 0, 1), keyCheck(k), deriveBaseKey(k, 0), deriveGroupSecret(k, gid), deriveSelfRoot(k)].map((b) =>
      hex(b.slice(0, 8))
    )
    expect(new Set(outputs).size).toBe(outputs.length)
  })
})
