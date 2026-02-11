import { test as base, chromium, type Page, type Browser, type BrowserContext } from '@playwright/test'

let browser: Browser | null = null
let context: BrowserContext | null = null
let sharedPage: Page | null = null

/**
 * Extended test fixture that uses a single persistent browser instance.
 *
 * The app loads the @dashevo/evo-sdk WASM module which can crash Chromium
 * renderer processes in constrained environments. By reusing a single browser
 * instance and blocking WASM binaries, tests stay stable and focused on
 * verifying the rendered UI.
 */
export const test = base.extend({
  page: async ({ }, use) => {
    if (!browser) {
      browser = await chromium.launch({
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process',
          '--headless=new',
        ],
      })
    }

    if (!context) {
      context = await browser.newContext()
    }

    if (!sharedPage || sharedPage.isClosed()) {
      sharedPage = await context.newPage()
      await sharedPage.route('**/*.wasm', (route) => route.abort())
    }

    await use(sharedPage)
  },
})

export { expect } from '@playwright/test'
