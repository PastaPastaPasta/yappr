import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const root = path.resolve(__dirname, '../..')
const evoSdkVersion = JSON.parse(readFileSync(path.join(root, 'node_modules/@dashevo/evo-sdk/package.json'), 'utf8')).version

/**
 * Four projects:
 *  - unit:     codec, dispatcher, client, shims, DTO mappers, classify, tickets, session. Offline.
 *  - contract: the engine API in Node against the live network (testnet, read only).
 *  - contract-write: real writes on sakura with pool identities (serial; skips until W-SAKURA).
 *  - browser:  the built bundle in Playwright WebKit and Chromium over the real
 *              postMessage transport (needs `npm run build:testnet` first).
 */
export default defineConfig({
  resolve: {
    // The same module aliases as build.mjs, so tests run what the bundle runs.
    alias: [
      { find: /^@\//, replacement: `${root}/` },
      { find: /^react-hot-toast$/, replacement: path.resolve(__dirname, 'src/shims/toast.ts') },
      { find: /^@dashevo\/wasm-sdk\/compressed$/, replacement: path.resolve(__dirname, 'src/shims/wasm-sdk-compressed.ts') },
    ],
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
          exclude: ['test/contract/write/**'],
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
          // Real writes on sakura with pool personas 90-99: serial, never retried blindly
          // (ENGINE.md 12.3). Skips with a reason until W-SAKURA and YAPPR_SAKURA_IDENTITIES.
          name: 'contract-write',
          environment: 'node',
          include: ['test/contract/write/**/*.test.ts'],
          setupFiles: ['test/contract/write/setup.ts'],
          // One process, one file at a time: the personas' nonces must never race.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          sequence: { concurrent: false },
          testTimeout: 300_000,
          hookTimeout: 300_000,
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
