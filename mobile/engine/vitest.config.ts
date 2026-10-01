import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const root = path.resolve(__dirname, '../..')
const evoSdkVersion = JSON.parse(readFileSync(path.join(root, 'node_modules/@dashevo/evo-sdk/package.json'), 'utf8')).version

/**
 * Three projects:
 *  - unit:     codec, dispatcher, client, shims, DTO mappers. Offline.
 *  - contract: the engine API in Node against the live network (testnet, read only).
 *  - browser:  the built bundle in Playwright WebKit and Chromium over the real
 *              postMessage transport (needs `npm run build:testnet` first).
 */
export default defineConfig({
  resolve: {
    alias: { '@': root },
  },
  define: {
    // The Node harness runs from source; build.mjs defines the same for the bundle.
    __ENGINE_BUILD__: JSON.stringify({ variant: 'source', evoSdkVersion, builtAt: '' }),
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', environment: 'node', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'contract',
          environment: 'node',
          include: ['test/contract/**/*.test.ts'],
          setupFiles: ['test/setup/node-engine.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // DAPI flakiness: an unhealthy testnet node can fail a single read.
          retry: 1,
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          environment: 'node',
          include: ['test/browser/**/*.test.ts'],
          testTimeout: 600_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
