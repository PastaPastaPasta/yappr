/**
 * Facts fixed when the engine is built. build.mjs (and the vitest config, for
 * the Node harness) `define`s `__ENGINE_BUILD__`; the bundle hash is the one
 * value that cannot be baked into the file it hashes, so engine.html sets it
 * on `globalThis` before the bundle runs.
 */

export interface EngineBuild {
  /** `devnet` | `testnet`, or `source` when running unbundled. */
  variant: string
  /** The @dashevo/evo-sdk version in the root lockfile. */
  evoSdkVersion: string
  builtAt: string
}

declare const __ENGINE_BUILD__: EngineBuild | undefined

declare global {
  var __YAPPR_ENGINE_BUNDLE_HASH__: string | undefined
}

export const ENGINE_BUILD: EngineBuild = typeof __ENGINE_BUILD__ !== 'undefined'
  ? __ENGINE_BUILD__
  : { variant: 'source', evoSdkVersion: 'unknown', builtAt: '' }

export function bundleHash(): string {
  return globalThis.__YAPPR_ENGINE_BUNDLE_HASH__ ?? 'unbundled'
}
