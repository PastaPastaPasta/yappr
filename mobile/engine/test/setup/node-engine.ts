/**
 * Node stand-in for the WebView globals the engine needs. Node 22 already has
 * fetch, WebAssembly, crypto.subtle, TextEncoder, atob/btoa, DecompressionStream
 * and performance; what it lacks is Web Storage, which the engine replaces
 * anyway, so the harness installs the same storage shim the bundle does.
 *
 * `window` stays undefined on purpose: lib treats that as "no browser" (as
 * during SSR). Nothing in the read API needs `window`. The WASM comes from
 * the package file (./wasm.ts), through the engine's own shim.
 */

import { readFileSync } from 'node:fs'

for (const key of Object.keys(process.env)) {
  // The contract suite targets testnet, the production web build's defaults;
  // a stray NEXT_PUBLIC_* from the shell would point lib elsewhere.
  if (key.startsWith('NEXT_PUBLIC_')) delete process.env[key]
}

// ENGINE_VARIANT=devnet runs the same suite on the devnet build's env (.env.devnet), as build.mjs does.
if (process.env.ENGINE_VARIANT === 'devnet') {
  const file = readFileSync(new URL('../../../../.env.devnet', import.meta.url), 'utf8')
  for (const line of file.split('\n')) {
    const match = /^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

// Imported only now: static imports are hoisted above the loops, and
// lib/storage-scope reads NEXT_PUBLIC_STORAGE_SCOPE when it loads.
const { createEngineStorage, installEngineStorage } = await import('../../src/shims/storage')
installEngineStorage(createEngineStorage())

export {}
