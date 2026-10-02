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

export * from '@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js'

export type WasmSource = () => Promise<InitInput>

let source: WasmSource | null = null
let initializing: Promise<InitOutput> | null = null

export function setWasmSource(next: WasmSource): void {
  source = next
}

/**
 * Initialize the WASM once. Concurrent and repeated calls share one init; a
 * failed one is forgotten, so the next call (a boot retry) tries again.
 */
export default function init(): Promise<InitOutput> {
  initializing ??= (async () => {
    if (!source) throw new Error('No WASM source: call setWasmSource() before the SDK initializes')
    return rawInit({ module_or_path: await source() })
  })().catch((error: unknown) => {
    initializing = null
    throw error
  })
  return initializing
}
