import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Module substitutions the bundle (build.mjs) and the tests (vitest.config.ts) share, so tests run what ships. */
export const ENGINE_ALIASES = {
  // lib's toasts become engine.notice events.
  'react-hot-toast': path.join(here, 'src/shims/toast.ts'),
  // One WASM instance: the key-registration builder shares evo-sdk's.
  '@dashevo/wasm-sdk/compressed': path.join(here, 'src/shims/wasm-sdk-compressed.ts'),
}
