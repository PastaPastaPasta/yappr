import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Unit tests cover the pure modules under lib/ (crypto primitives, codecs,
// parsers) and offline WASM signing with network calls mocked. Live SDK and
// browser flows belong in e2e/.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
})
