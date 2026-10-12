/**
 * `isUsernameContested` and the connection list's homograph-safe search call
 * `WasmSdk` statics imported from `@dashevo/wasm-sdk`, while the app initialises
 * the SDK through `@dashevo/evo-sdk`. They only work when both resolve to one
 * wasm instance (next.config.js and vitest.config.ts alias evo-sdk to its
 * unbundled build). With evo-sdk's own inlined copy they silently fell back
 * (false / raw input) until a key-registration flow initialised the other one.
 */
import { describe, expect, it } from 'vitest'
import { WasmSdk } from '@dashevo/wasm-sdk'
import { ensureInitialized } from '@dashevo/evo-sdk'
import { compareUsernames, getPrimaryUsername, isUsernameContested } from './username'

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
  })
})
