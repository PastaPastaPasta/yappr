import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

/**
 * Module substitutions the bundle (build.mjs) and the tests (vitest.config.ts)
 * share, so tests run what ships. Each key matches that exact specifier only,
 * never its subpaths.
 */
export const ENGINE_ALIASES = {
  // lib's toasts become engine.notice events.
  'react-hot-toast': path.join(here, 'src/shims/toast.ts'),
  // evo-sdk's unbundled entry: its published bundle (dist/evo-sdk.module.js) inlines
  // its own glue and an 11 MB base64 WASM. This one imports `@dashevo/wasm-sdk/compressed`.
  '@dashevo/evo-sdk': path.join(root, 'node_modules/@dashevo/evo-sdk/dist/sdk.js'),
  // One glue module and one WASM instance for evo-sdk, lib/utils/username and the
  // key-registration builder, with the WASM loaded from outside the bundle.
  '@dashevo/wasm-sdk': path.join(here, 'src/shims/wasm-sdk.ts'),
  '@dashevo/wasm-sdk/compressed': path.join(here, 'src/shims/wasm-sdk.ts'),
}
