/**
 * ENGINE_ALIASES (aliases.mjs) point evo-sdk at its unbundled build and both
 * wasm-sdk specifiers at the shim, so evo-sdk, lib/utils/username and the
 * key-registration builder share one WASM instance. From 5.0.0-rc.3
 * (platform#5428) an instance refuses another instance's wrappers, so a broken
 * alias would fail every write that mixes them; it has to fail here first.
 */
import { describe, expect, it } from 'vitest'
import { Identifier, ensureInitialized } from '@dashevo/evo-sdk'
import * as wasmSdk from '@dashevo/wasm-sdk'
import * as wasmSdkCompressed from '@dashevo/wasm-sdk/compressed'

describe('one wasm-sdk instance in the engine', () => {
  it('evo-sdk and both wasm-sdk specifiers share their classes', async () => {
    await ensureInitialized()
    expect(wasmSdk.Identifier).toBe(Identifier)
    expect(wasmSdkCompressed.Identifier).toBe(Identifier)
    const id = new wasmSdkCompressed.Identifier(new Uint8Array(32).fill(3))
    expect(new Identifier(id).toBase58()).toBe(id.toBase58())
  })
})
