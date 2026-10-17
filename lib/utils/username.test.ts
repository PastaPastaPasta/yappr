/**
 * `isUsernameContested` and the connection list's homograph-safe search call
 * `WasmSdk` statics imported from `@dashevo/evo-sdk`, the instance every SDK
 * call initialises (#608). The direct `@dashevo/wasm-sdk` entry must resolve to
 * that same instance (next.config.js and vitest.config.ts alias evo-sdk to its
 * unbundled build); with evo-sdk's own inlined copy they silently fell back
 * (false / raw input) until a key-registration flow initialised the other one.
 */
import { describe, expect, it } from 'vitest'
import { WasmSdk } from '@dashevo/wasm-sdk'
import { ensureInitialized } from '@dashevo/evo-sdk'
import { compareUsernames, getPrimaryUsername, isUsernameContested, sortUsernames } from './username'

describe('wasm-sdk statics after the evo-sdk init only', () => {
  it('fall back before anything is initialised', () => {
    expect(isUsernameContested('alice')).toBe(false)
  })

  it('see the instance evo-sdk initialised', async () => {
    await ensureInitialized()

    // Letters plus 0/1/- over 3..19 chars are contested; a digit 2-9 is not.
    expect(isUsernameContested('alice')).toBe(true)
    expect(isUsernameContested('alice.dash')).toBe(true)
    expect(isUsernameContested('alice2')).toBe(false)

    expect(WasmSdk.dpnsConvertToHomographSafe('Alice')).toBe('a11ce')
  })

  it('sorts contested names first', () => {
    expect(compareUsernames('alice', 'alice2')).toBeLessThan(0)
    expect(getPrimaryUsername(['alice2', 'bob22', 'alice'])).toBe('alice')
    // A longer contested name still beats a shorter one that is not contested.
    expect(sortUsernames(['bob2', 'charlie', 'al1ce'])).toEqual(['al1ce', 'charlie', 'bob2'])
  })
})
