/**
 * `@dashevo/wasm-sdk/compressed` for the engine (aliased in build.mjs and
 * vitest.config.ts): evo-sdk already carries this module, and re-exports it,
 * so lib's one direct user (lib/services/identity-update-builder.ts, the
 * first-login `dash-st:` key registration) shares evo-sdk's WASM instance
 * instead of bundling a second 11 MB payload and instantiating a second
 * module. One instance also means the objects `sdk.identities.fetch` returns
 * and the classes the builder constructs come from the same module.
 *
 * evo-sdk's bundle drops the package's default export (the init function), so
 * it is rebuilt from `ensureInitialized`, which is idempotent.
 */
import { ensureInitialized } from '@dashevo/evo-sdk'

export * from '@dashevo/evo-sdk'

export default async function initWasm(): Promise<void> {
  await ensureInitialized()
}
