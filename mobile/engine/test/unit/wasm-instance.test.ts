/**
 * ENGINE_ALIASES (aliases.mjs): evo-sdk resolves to its unbundled build (its
 * published bundle inlines a second WASM instance), and both wasm-sdk
 * specifiers to the shim, which loads the WASM through setWasmSource instead
 * of inlining it into engine.js. From 5.0.0-rc.2 (platform#5405) an instance
 * refuses another instance's wrappers (before, it read them in the wrong
 * memory), so a broken alias has to fail here first.
 */
import { describe, expect, it } from 'vitest'
import { Identifier, ensureInitialized } from '@dashevo/evo-sdk'
import * as wasmSdk from '@dashevo/wasm-sdk'
import * as wasmSdkCompressed from '@dashevo/wasm-sdk/compressed'

describe('one wasm-sdk instance in the engine', () => {
  it('both wasm-sdk specifiers are the shim', () => {
    expect(wasmSdk.default).toBe(wasmSdkCompressed.default)
    expect('setWasmSource' in wasmSdk).toBe(true)
  })

  it('evo-sdk and the shim share their classes', async () => {
    await ensureInitialized()
    expect(wasmSdk.Identifier).toBe(Identifier)
    const id = new wasmSdk.Identifier(new Uint8Array(32).fill(3))
    expect(new Identifier(id).toBase58()).toBe(id.toBase58())
  })
})
