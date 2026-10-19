import { defineConfig } from '@playwright/test'
import base from './qa-round1-playwright.config'
const port = Number(process.env.COMPONENT_TEST_PORT ?? 3197)
export default defineConfig({ ...base, testMatch: 'tqa.spec.ts', outputDir: '../../test-results/components-testnet', webServer: {
  ...base.webServer, url: `http://127.0.0.1:${port}/tqa.html`, command: `npx vite --config e2e/components-qa-round1/tqa-vite.config.ts --port ${port} --strictPort`,
} })
