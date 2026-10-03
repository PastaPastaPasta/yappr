/**
 * `@dashevo/wasm-sdk` and `@dashevo/wasm-sdk/compressed` for the engine
 * (aliased in aliases.mjs, for the bundle and the tests alike). evo-sdk's
 * unbundled entry (`dist/sdk.js`, also aliased) imports `./compressed` and
 * inits it once, so with this shim every importer (evo-sdk, lib's username
 * check, the first-login key-registration builder) shares one wasm-bindgen
 * glue module and one WASM instance.
 *
 * Unlike the package's own entries, the shim inlines no WASM: init() asks the
 * source installed with `setWasmSource` (the WebView: ../wasm-source.ts; Node
 * tests: test/setup/wasm.ts). That keeps the 25 MB module out of engine.js,
 * which every engine start would otherwise scan, base64 included.
 */
import rawInit, { type InitInput, type InitOutput } from '@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js'
import { recordWasmInit } from '../wasm-timing'

export * from '@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js'

export type WasmSource = () => Promise<InitInput>

let source: WasmSource | null = null
let initializing: Promise<InitOutput> | null = null

export function setWasmSource(next: WasmSource): void {
  source = next
}

/**
 * Initialize the WASM, once: every call shares the first one's outcome,
 * failure included, as evo-sdk's own `ensureInitialized` does. A WASM that
 * did not load is the engine's end (`engine.boot()` reports it, and the host
 * starts a fresh page).
 */
export default function init(): Promise<InitOutput> {
  initializing ??= (async () => {
    if (!source) throw new Error('No WASM source: call setWasmSource() before the SDK initializes')
    const started = performance.now()
    const output = await rawInit({ module_or_path: await source() })
    recordWasmInit(Math.round(performance.now() - started))
    return output
  })()
  return initializing
}
