import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Unit tests cover the pure modules under lib/ (crypto primitives, codecs,
// parsers) and the vendored platform-auth core. Anything that touches the SDK
// or the DOM belongs in e2e/.
export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname) },
      // Same substitution as next.config.js: evo-sdk's published entry inlines its own
      // copy of wasm-sdk, so resolve the unbundled build to run what ships (one shared
      // wasm instance with the direct @dashevo/wasm-sdk imports).
      {
        find: /^@dashevo\/evo-sdk$/,
        replacement: path.resolve(__dirname, 'node_modules/@dashevo/evo-sdk/dist/sdk.js'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'vendor/platform-auth/src/**/*.test.ts'],
  },
})
