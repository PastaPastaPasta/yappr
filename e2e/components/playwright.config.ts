import { defineConfig, devices } from '@playwright/test'

// Deliberately separate from the live-network suite in ../../playwright.config.ts.
const port = Number(process.env.COMPONENT_TEST_PORT ?? 3197)
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../../test-results/components',
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    serviceWorkers: 'block',
  },
  webServer: {
    command: `npx vite --config e2e/components/vite.config.ts --port ${port} --strictPort`,
    cwd: '../..',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
})
