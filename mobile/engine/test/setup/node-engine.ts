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
import { scopedKey } from '@/lib/storage-scope'
import { createEngineStorage, installEngineStorage } from '../../src/shims/storage'

for (const key of Object.keys(process.env)) {
  // The contract suite targets testnet, the production web build's defaults;
  // a stray NEXT_PUBLIC_* from the shell would point lib elsewhere.
  if (key.startsWith('NEXT_PUBLIC_')) delete process.env[key]
}

const prefix = scopedKey('yappr_secure_')
export const nodeEngineStorage = createEngineStorage(key => key.startsWith(prefix))
installEngineStorage(nodeEngineStorage)
