import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Yappr E2E tests.
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e/tests',

  /* Global setup to validate test identities */
  globalSetup: './e2e/global-setup.ts',

  /* Run tests in files in parallel */
  fullyParallel: false, // Blockchain state transitions require sequential execution

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only - blockchain operations can be flaky */
  retries: process.env.CI ? 1 : 0,

  /* Single worker due to shared blockchain state and identity dependencies */
  workers: 1,

  /* Reporter configuration */
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list']
  ],

  /* Shared settings for all projects */
  use: {
    /* Base URL for navigation */
    baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test */
    trace: 'on-first-retry',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on first retry */
    video: 'on-first-retry',

    /* Extended timeout for blockchain operations */
    actionTimeout: 30000,
    navigationTimeout: 30000,
  },

  /* Extended test timeout for blockchain operations */
  timeout: 120000,

  /* Expect timeout for assertions */
  expect: {
    timeout: 30000,
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Run local dev server before starting the tests */
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },

  /* Output directory for test artifacts */
  outputDir: 'test-results/',
});
