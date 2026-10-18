import { defineConfig } from '@playwright/test'
import base from '../components/playwright.config'

const port = Number(process.env.COMPONENT_TEST_PORT ?? 3197)
export default defineConfig({
  ...base,
  testMatch: 'qa-round1.spec.ts',
  outputDir: '../../test-results/components-qa-round1',
  webServer: {
    ...base.webServer,
    url: `http://127.0.0.1:${port}/qa-round1.html`,
    command: `npx vite --config e2e/components-qa-round1/qa-round1-vite.config.ts --port ${port} --strictPort`,
  },
})
