import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright runs against the *real* `/testing` build of the app, served from
 * `out/` by `scripts/serve-static.mjs`, talking to the real Dash testnet.
 * Nothing is mocked.
 *
 * The build is deliberately NOT part of `webServer` — CI (and you, locally)
 * runs `npm run build:testing` first, then `npx playwright test`. That keeps
 * the artifact under test identical to the one that gets deployed.
 *
 * Two projects:
 *   - `smoke`  read-only, no identity, safe on fork PRs.
 *   - `write`  real state transitions signed by a bot identity derived from
 *              `E2E_SEED_PHRASE`. Self-skips (visibly) when that is absent.
 *
 * Everything runs serially with a single worker: DAPI rate-limits hard and
 * parallel SDK clients exhaust the available addresses.
 */

const PORT = Number(process.env.E2E_PORT ?? 3000)
const BASE_PATH = process.env.E2E_BASE_PATH ?? '/testing'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // A single state transition can take tens of seconds, and a spec may chain
  // several of them plus a chain read-back poll.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}${BASE_PATH}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'smoke',
      testDir: './e2e/smoke',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'write',
      testDir: './e2e/write',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `node scripts/serve-static.mjs --port ${PORT} --base ${BASE_PATH}`,
    url: `http://localhost:${PORT}${BASE_PATH}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
