/**
 * How long the SDK's WASM took to load, decompress, compile and instantiate,
 * for Engine diagnostics (PRD SET-08). The WASM shim (shims/wasm-sdk.ts)
 * records it once its init succeeds; `engine.diagnostics()` reports it. Kept
 * apart from the shim so the API's types never pull in the raw wasm-bindgen glue.
 */
let initMs: number | undefined

export function recordWasmInit(ms: number): void {
  initMs = ms
}

/** Undefined until the WASM is up (and when it failed). */
export function wasmInitMs(): number | undefined {
  return initMs
}
