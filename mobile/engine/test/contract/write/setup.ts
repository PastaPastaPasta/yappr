/**
 * Node stand-in for the WebView when the engine writes (ENGINE.md §12.1):
 * the devnet variant's env (sakura), the engine's storage shim, and a
 * `window`, because lib signs only "in a browser" (state-transition-service)
 * and its secret store is inert without one. With `window` defined, wasm-sdk
 * takes its browser init path, which Node 22 supports (DecompressionStream,
 * WebAssembly.compile).
 *
 * Does nothing while the suite skips (see ./env.ts).
 */
import { devnetEnv, writeSuiteSkipReason } from './env'

if (writeSuiteSkipReason() === null) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NEXT_PUBLIC_')) delete process.env[key]
  }
  Object.assign(process.env, devnetEnv())
  const { createEngineStorage, installEngineStorage } = await import('../../../src/shims/storage')
  installEngineStorage(createEngineStorage())
  Object.assign(globalThis, { window: globalThis })
}

export {}
