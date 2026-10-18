/** Read-only paired cold/warm probe. See docs/RELEASE_PERFORMANCE.md. */
import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'

const base = process.argv[2]
const output = process.argv[3]
if (!base || !new URL(base).pathname.match(/^\/devnet\/?$/) || !output) {
  throw new Error('Usage: node scripts/measure-first-content.mjs URL/devnet output.json')
}
const routes = {
  feed: 'feed/',
  post: 'post/?id=GR9yYCN1p9oTmJTBRkUgdRpgwHqUE45AVd2bhmnT5s4A',
  profile: 'user/?id=Hga7gpqFN123hqkNueaeKvV6GVJgvJWpyYuuCXpe6J4m',
}
const browser = await chromium.launch()
const results = []
try {
  for (const profile of ['mobile', 'desktop']) {
    for (const [route, path] of Object.entries(routes)) {
      // A fresh profile for each route, followed by a second full navigation
      // with HTTP/Cache Storage intact; application memory never carries over.
      const context = await browser.newContext({
        viewport: profile === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      })
      try {
        await context.addInitScript(() => {
          const events = []
          window.__firstContent = { events, article: null }
          for (const method of ['instantiate', 'instantiateStreaming', 'compile', 'compileStreaming']) {
            const original = WebAssembly[method]
            if (!original) continue
            WebAssembly[method] = async function (...args) {
              events.push({ type: `wasm.${method}.start`, t: performance.now() })
              try { return await original.apply(this, args) }
              finally { events.push({ type: `wasm.${method}.end`, t: performance.now() }) }
            }
          }
          for (const method of ['debug', 'log', 'info', 'warn', 'error']) {
            const original = console[method]
            console[method] = function (...args) {
              events.push({ type: `console.${method}`, t: performance.now(), text: args.map(String).join(' ').slice(0, 1200) })
              return original.apply(this, args)
            }
          }
          new MutationObserver(() => {
            if (!window.__firstContent.article && document.querySelector('article')) {
              window.__firstContent.article = performance.now()
            }
          }).observe(document, { childList: true, subtree: true })
        })
        const page = await context.newPage()
        const cdp = await context.newCDPSession(page)
        await cdp.send('Network.enable')
        if (profile === 'mobile') {
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false, latency: 60, downloadThroughput: 9e6 / 8, uploadThroughput: 1e6 / 8,
          })
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        }
        for (const cache of ['cold', 'warm']) {
          const errors = []
          const onError = error => errors.push(error.message)
          page.on('pageerror', onError)
          let failure
          try {
            await page.goto(`${base.replace(/\/$/, '')}/${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
            await page.waitForSelector('article', { timeout: 90000 })
          } catch (error) { failure = error.message }
          // First article can precede completion of the first page's enrichment.
          await page.waitForTimeout(1500)
          const data = await page.evaluate(() => ({
            firstContent: window.__firstContent,
            paints: performance.getEntriesByType('paint').map(entry => entry.toJSON()),
            resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()),
            navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()),
            loadingCopy: document.body.innerText.includes('Connecting to Dash Platform'),
          }))
          const result = { profile, route, cache, errors, failure, ...data }
          results.push(result)
          writeFileSync(output, JSON.stringify({ base, browser: browser.version(), results }, null, 2))
          console.log(JSON.stringify({ profile, route, cache, articleMs: data.firstContent?.article ?? null, errors, failure }))
          page.off('pageerror', onError)
          // Keep diagnostics, then stop instead of hammering an unhealthy gateway.
          if (failure) throw new Error(failure)
        }
      } finally { await context.close() }
    }
  }
} finally { await browser.close() }
