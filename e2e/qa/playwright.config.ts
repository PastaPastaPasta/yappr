import { defineConfig, devices } from '@playwright/test'
const port = Number(process.env.QA_TEST_PORT ?? 3198)
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', outputDir: '../../test-results/qa',
  workers: 1, forbidOnly: !!process.env.CI, timeout: 30_000,
  use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${port}`, serviceWorkers: 'block' },
  webServer: { command: `npx vite --config e2e/qa/vite.config.ts --port ${port} --strictPort`, cwd: '../..', url: `http://127.0.0.1:${port}` },
})
