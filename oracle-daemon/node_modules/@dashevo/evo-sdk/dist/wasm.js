// ESM wrapper around @dashevo/wasm-sdk with one-time init
import initWasmSdk, * as wasm from '@dashevo/wasm-sdk/compressed';
let initPromise;
export async function ensureInitialized() {
    if (!initPromise) {
        initPromise = initWasmSdk().then(() => wasm);
    }
    return initPromise;
}
// Re-export all wasm SDK symbols for convenience
export * from '@dashevo/wasm-sdk/compressed';
export { default } from '@dashevo/wasm-sdk/compressed';
