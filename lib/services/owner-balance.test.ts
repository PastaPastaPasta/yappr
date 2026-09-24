/**
 * wasm-sdk 4.2.0-beta.4 hands the owner's post-write credit balance back as an
 * untyped `ownerBalance` bigint on the wait result (platform#4887). The write
 * path must read it without trusting its presence or its type.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({}) }))
vi.mock('@dashevo/evo-sdk', () => ({}))
import { ownerBalanceOf } from './state-transition-service'

describe('ownerBalanceOf', () => {
  it('reads the bigint the proof carried', () => {
    expect(ownerBalanceOf({ documents: new Map(), ownerBalance: BigInt(123456789) })).toBe(BigInt(123456789))
  })

  it('answers null when the proof carried none (pre-14 proof, unowned transition) or the shape is unexpected', () => {
    expect(ownerBalanceOf({ documents: new Map() })).toBeNull()
    expect(ownerBalanceOf({ ownerBalance: 12 })).toBeNull()
    expect(ownerBalanceOf(undefined)).toBeNull()
    expect(ownerBalanceOf(null)).toBeNull()
  })
})
