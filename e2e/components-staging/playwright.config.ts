import { defineConfig, devices } from '@playwright/test'

// Deliberately separate from the live-network suite in ../../playwright.config.ts.
const port = Number(process.env.COMPONENT_TEST_PORT ?? 3199)
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../../test-results/components-staging',
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  // The first test pays for Vite's cold transforms of the wizard, composer and teams page.
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    serviceWorkers: 'block',
  },
  webServer: {
    command: `npx vite --config e2e/components-staging/vite.config.ts --port ${port} --strictPort`,
    cwd: '../..',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
})
