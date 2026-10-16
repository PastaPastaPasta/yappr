/**
 * evo-sdk's published entry (`dist/evo-sdk.module.js`) inlines its own copy of
 * wasm-sdk, so the app resolves its unbundled build instead (next.config.js;
 * vitest.config.ts and mobile/engine/aliases.mjs do the same). Then evo-sdk and
 * the direct `@dashevo/wasm-sdk` imports (the key-registration builder, the
 * username statics) share one glue module and one WASM instance.
 *
 * From 5.0.0-rc.2 (platform#5405) a WASM wrapper (Identifier, IdentityPublicKey,
 * Document, ...) is refused by any instance but the one that made it; before,
 * the other instance read it in the wrong memory. A broken alias would
 * therefore fail every write that mixes the two, so it has to fail here first.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Identifier, ensureInitialized } from '@dashevo/evo-sdk'
import * as wasmSdk from '@dashevo/wasm-sdk'
import * as wasmSdkCompressed from '@dashevo/wasm-sdk/compressed'

const ID_BYTES = new Uint8Array(32).fill(3)
const EVO_SDK_DIST = path.resolve(__dirname, '../node_modules/@dashevo/evo-sdk/dist')

beforeAll(async () => {
  await ensureInitialized()
})

describe('one wasm-sdk instance', () => {
  it('next.config.js resolves evo-sdk to its unbundled build', () => {
    type WebpackHook = (config: object, context: { isServer: boolean }) => { resolve: { alias: Record<string, string> } }
    const nextConfig = createRequire(__filename)('../next.config.js') as { webpack: WebpackHook }
    const config = nextConfig.webpack({ resolve: { alias: {} }, module: { rules: [] } }, { isServer: false })
    expect(config.resolve.alias['@dashevo/evo-sdk$']).toBe(path.join(EVO_SDK_DIST, 'sdk.js'))
  })

  it('evo-sdk and the direct wasm-sdk imports share their classes', () => {
    expect(wasmSdk.Identifier).toBe(Identifier)
    expect(wasmSdkCompressed.Identifier).toBe(Identifier)
    const id = new wasmSdkCompressed.Identifier(ID_BYTES)
    expect(new Identifier(id).toBase58()).toBe(id.toBase58())
  })

  it('refuses a wrapper from a second instance, which is what a broken alias would produce', async () => {
    // The published entry the aliases avoid. It ships no types of its own, but its API is the unbundled build's.
    const bundled: typeof import('@dashevo/evo-sdk') = await import(path.join(EVO_SDK_DIST, 'evo-sdk.module.js'))
    await bundled.ensureInitialized()
    const foreign = new bundled.Identifier(ID_BYTES)
    expect(() => new Identifier(foreign)).toThrow(/Invalid identifier/)
  })
})
