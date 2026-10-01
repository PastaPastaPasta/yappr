/**
 * Node stand-in for the WebView globals the engine needs. Node 22 already has
 * fetch, WebAssembly, crypto.subtle, TextEncoder, atob/btoa, DecompressionStream
 * and performance; what it lacks is Web Storage, which the engine replaces
 * anyway, so the harness installs the same storage shim the bundle does.
 *
 * `window` stays undefined on purpose: lib treats that as "no browser" (as
 * during SSR) and wasm-sdk takes its Node init path. Nothing in the read API
 * needs `window`.
 */

for (const key of Object.keys(process.env)) {
  // The contract suite targets testnet, the production web build's defaults;
  // a stray NEXT_PUBLIC_* from the shell would point lib elsewhere.
  if (key.startsWith('NEXT_PUBLIC_')) delete process.env[key]
}

// Imported only now: static imports are hoisted above the loop, and
// lib/storage-scope reads NEXT_PUBLIC_STORAGE_SCOPE when it loads.
const { createEngineStorage, installEngineStorage } = await import('../../src/shims/storage')
installEngineStorage(createEngineStorage())

export {}
