/**
 * Browser-boot proof: the built engine (dist/testnet) in Playwright WebKit and
 * Chromium, the closest desktop stand-ins for WKWebView and Android WebView,
 * driven exactly like the RN host will drive it:
 *  - engine → host through a stubbed `window.ReactNativeWebView.postMessage`,
 *  - host → engine through `window.__yapprEngineReceive(json)` (what
 *    `injectJavaScript` does), with the real codec and client on the host side.
 *
 * Two origins: `file://` (the html shipped in the app bundle, origin `null`)
 * and a custom https base (`https://engine.yap.pr/`, served by route
 * interception, as `source={{ html, baseUrl }}` would). For each it records
 * cold boot, first/second feed page, a post and a profile, and the DAPI
 * responses' CORS headers. Results go to $EVIDENCE_DIR (default
 * mobile/engine/test-results/, gitignored).
 *
 * Read only, against testnet. Run `npm run build:testnet` first.
 */
import { chromium, webkit, type Browser, type BrowserType, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createEngineClient } from '../../src/rpc/client'
import { createHandlerSet, type Transport } from '../../src/rpc/transport'
import type { EngineApi } from '../../src/api'

const DIST = path.resolve(__dirname, '../../dist/testnet')
const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? path.resolve(__dirname, '../../test-results')
const RUNS = Number(process.env.RUNS ?? 2)
const HTTPS_BASE = 'https://engine.yap.pr/'

type Mode = 'file' | 'https'

interface RunResult {
  browser: string
  browserVersion: string
  mode: Mode
  run: number
  ok: boolean
  error?: string
  /** goto → engine.hello (download, parse and evaluate the bundle). */
  helloMs?: number
  /** engine.boot() round trip (wasm decompress + compile, SDK connect, contract preload). */
  bootMs?: number
  /** The engine's own measure of the SDK initialization inside boot. */
  engineBootMs?: number
  firstFeedMs?: number
  firstFeedItems?: number
  secondFeedMs?: number
  refreshFeedMs?: number
  postGetMs?: number
  profileGetMs?: number
  /** goto → first feed page rendered-ready: what a cold app start waits for. */
  coldToFeedMs?: number
  origin?: string
  dapi: { url: string; status: number; allowOrigin: string | null }[]
  failedRequests: { url: string; error: string }[]
  engineErrors: string[]
  /** Chromium CPU throttling factor (1 = none). */
  cpuThrottle: number
  probe?: { wasm: { op: string; ms: number }[]; workers: number; workerErrors: number; jsHeapMB?: number }
}

const results: RunResult[] = []

/** Run `fn` and return its value with its wall time in whole milliseconds. */
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now()
  const value = await fn()
  return [value, Math.round(performance.now() - started)]
}

/** Launch a browser for one test and close it whatever happens. */
async function withBrowser(type: BrowserType, fn: (browser: Browser) => Promise<void>): Promise<void> {
  const browser = await type.launch()
  try {
    await fn(browser)
  } finally {
    await browser.close()
  }
}

/** The host end of the bridge: inbound messages are fed to `deliver` by an exposed page function. */
function pageTransport(page: Page): { transport: Transport; deliver: (message: string) => void } {
  const inbound = createHandlerSet()
  return {
    transport: {
      send(message) {
        page.evaluate(m => window.__yapprEngineReceive?.(m), message).catch(() => {
          // The page closed mid-call; the client's timeout reports it.
        })
      },
      onMessage: inbound.onMessage,
    },
    deliver: inbound.deliver,
  }
}

interface RunOptions {
  cpuThrottle?: number
  /** Injected as `__YAPPR_ENGINE_STORAGE__` before load, as the host's injectedJavaScriptBeforeContentLoaded will. */
  snapshot?: { local?: Record<string, string>; secure?: Record<string, string> }
  /** The snapshot selects a feed language with no posts, so the first page must come back empty. */
  expectEmptyFeed?: boolean
}

async function runOnce(browser: Browser, browserName: string, mode: Mode, run: number, { cpuThrottle = 1, snapshot, expectEmptyFeed = false }: RunOptions = {}): Promise<RunResult> {
  const result: RunResult = {
    browser: browserName, browserVersion: browser.version(), mode, run, ok: false,
    dapi: [], failedRequests: [], engineErrors: [], cpuThrottle,
  }
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    if (cpuThrottle > 1) {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
    }
    const { transport, deliver } = pageTransport(page)
    await page.exposeFunction('__engineToHost', deliver)
    if (snapshot) {
      await page.addInitScript((injected) => { (window as { __YAPPR_ENGINE_STORAGE__?: unknown }).__YAPPR_ENGINE_STORAGE__ = injected }, snapshot)
    }
    await page.addInitScript(() => {
      const w = window as unknown as {
        __engineToHost: (m: string) => void
        ReactNativeWebView: { postMessage(m: string): void }
        __probe: { wasm: { op: string; ms: number }[]; workers: number; workerErrors: number }
      }
      w.ReactNativeWebView = { postMessage: (m: string) => { w.__engineToHost(m) } }
      // Where the wasm compile happens (main thread vs the SDK's blob Worker) and what it costs.
      const probe = w.__probe = { wasm: [] as { op: string; ms: number }[], workers: 0, workerErrors: 0 }
      for (const op of ['compile', 'instantiate'] as const) {
        const original = WebAssembly[op] as (...args: unknown[]) => Promise<unknown>
        ;(WebAssembly as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
          const started = performance.now()
          return original.apply(WebAssembly, args).finally(() => probe.wasm.push({ op, ms: Math.round(performance.now() - started) }))
        }
      }
      const NativeWorker = window.Worker
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options)
          probe.workers++
          this.addEventListener('error', () => { probe.workerErrors++ })
        }
      }
    })

    page.on('response', (response) => {
      const url = response.url()
      if (/:(1443|443)\//.test(url) && !url.startsWith(HTTPS_BASE)) {
        result.dapi.push({ url, status: response.status(), allowOrigin: response.headers()['access-control-allow-origin'] ?? null })
      }
    })
    page.on('requestfailed', request => {
      result.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' })
    })

    if (mode === 'https') {
      await page.route(`${HTTPS_BASE}**`, async (route) => {
        const file = path.join(DIST, new URL(route.request().url()).pathname.replace(/^\//, ''))
        if (!existsSync(file)) return route.fulfill({ status: 404, body: 'not found' })
        await route.fulfill({
          status: 200,
          contentType: file.endsWith('.js') ? 'text/javascript' : 'text/html',
          body: readFileSync(file),
        })
      })
    }

    const client = createEngineClient<EngineApi>(transport, {
      timeoutMs: 120_000,
      onLog: (level, message) => { if (level === 'error') result.engineErrors.push(message.slice(0, 500)) },
    })

    const url = mode === 'file' ? pathToFileURL(path.join(DIST, 'engine.html')).href : `${HTTPS_BASE}engine.html`
    const t0 = performance.now()
    await page.goto(url)
    await client.ready
    result.helloMs = Math.round(performance.now() - t0)
    result.origin = await page.evaluate(() => self.origin)

    const [info, bootMs] = await timed(() => client.api.engine.boot())
    result.bootMs = bootMs
    result.engineBootMs = info.bootMs
    result.probe = await page.evaluate(() => {
      const w = window as unknown as { __probe: NonNullable<RunResult['probe']> }
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      return { ...w.__probe, jsHeapMB: memory ? Math.round(memory.usedJSHeapSize / 1e6) : undefined }
    })

    const [first, firstFeedMs] = await timed(() => client.api.feed.forYou())
    result.firstFeedMs = firstFeedMs
    result.coldToFeedMs = Math.round(performance.now() - t0)
    result.firstFeedItems = first.items.length
    if (expectEmptyFeed) {
      expect(first.items).toEqual([])
      result.ok = true
      client.close()
      return result
    }
    expect(first.items.length).toBeGreaterThan(0)
    // lib reads the session from localStorage: viewer marks appear only if the injected snapshot was seen.
    expect(first.items[0].viewer !== undefined).toBe(snapshot !== undefined)

    if (first.hasMore) [, result.secondFeedMs] = await timed(() => client.api.feed.forYou({ cursor: first.cursor }))
    // Warm re-read of the first page: the steady-state cost of a refresh.
    ;[, result.refreshFeedMs] = await timed(() => client.api.feed.forYou())

    const sample = first.items[0]
    const [post, postGetMs] = await timed(() => client.api.posts.get(sample.id))
    result.postGetMs = postGetMs
    expect(post?.id).toBe(sample.id)

    const [profile, profileGetMs] = await timed(() => client.api.profiles.get(sample.author.id))
    result.profileGetMs = profileGetMs
    expect(profile?.id).toBe(sample.author.id)

    result.ok = true
    client.close()
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    await context.close()
    results.push(result)
  }
  return result
}

const engines: [string, BrowserType][] = [['webkit', webkit], ['chromium', chromium]]

describe.skipIf(!existsSync(path.join(DIST, 'engine.html')))('engine boots in a browser runtime', () => {
  const runAll = (browser: Browser, name: string, mode: Mode, options?: RunOptions) => async () => {
    for (let run = 1; run <= RUNS; run++) {
      const result = await runOnce(browser, name, mode, run, options)
      expect(result.error ?? null).toBeNull()
    }
  }

  for (const [name, type] of engines) {
    for (const mode of ['file', 'https'] as Mode[]) {
      it(`${name} over ${mode}`, () => withBrowser(type, browser => runAll(browser, name, mode)()))
    }
  }

  // A rough stand-in for a mid-range Android phone: Chromium with the CPU slowed 4x.
  it('chromium over file, CPU throttled 4x', () =>
    withBrowser(chromium, browser => runAll(browser, 'chromium', 'file', { cpuThrottle: 4 })()))

  // The host's storage snapshot reaches lib: a session injected before load makes the engine signed in.
  it('webkit over file, with a host storage snapshot', () => withBrowser(webkit, async (browser) => {
    // A session for an arbitrary, well-formed identity id. Nothing is signed or written.
    const session = JSON.stringify({ user: { identityId: '4t8Ww2SDcMgLqT2PqGzMSwbeEv6P8r7WFoDA8BmZHRC8' }, timestamp: 0 })
    const result = await runOnce(browser, 'webkit', 'file', 1, { snapshot: { local: { yappr_session: session } } })
    expect(result.error ?? null).toBeNull()
  }))

  // Module-scope hydration: lib/store.ts's zustand `persist` reads `yappr-settings` when it loads,
  // long before boot. A persisted feed language with no posts must empty the v2 For You page.
  it('webkit over file, with a persisted setting read at module load', () => withBrowser(webkit, async (browser) => {
    const settings = JSON.stringify({ state: { feedLanguage: 'zz' }, version: 1 })
    const result = await runOnce(browser, 'webkit', 'file', 1, { snapshot: { local: { 'yappr-settings': settings } }, expectEmptyFeed: true })
    expect(result.error ?? null).toBeNull()
  }))

  afterAll(() => {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(path.join(EVIDENCE_DIR, `browser-boot-${stamp}.json`), JSON.stringify(results, null, 2))
    const rows = results.map(r => [
      r.browser + (r.cpuThrottle > 1 ? `@${r.cpuThrottle}x` : ''), r.mode, r.run, r.ok ? 'ok' : `FAIL ${r.error?.slice(0, 80)}`, r.origin, r.helloMs, r.bootMs, r.engineBootMs,
      r.firstFeedMs, r.firstFeedItems, r.secondFeedMs ?? '-', r.refreshFeedMs, r.postGetMs, r.profileGetMs, r.coldToFeedMs,
      [...new Set(r.dapi.map(d => d.allowOrigin))].join('|'), r.failedRequests.length,
      r.probe?.wasm.map(w => `${w.op}:${w.ms}`).join(',') || '-', r.probe?.workers ?? '-', r.probe?.jsHeapMB ?? '-',
    ].join('\t'))
    const header = 'browser\tmode\trun\tresult\torigin\thelloMs\tbootMs\tengineBootMs\tfeed1Ms\titems\tfeed2Ms\trefreshMs\tpostMs\tprofileMs\tcoldToFeedMs\tACAO\tfailedReqs\twasmMainThread\tworkers\tjsHeapMB'
    const table = [header, ...rows].join('\n')
    writeFileSync(path.join(EVIDENCE_DIR, `browser-boot-${stamp}.tsv`), `${table}\n`)
    process.stdout.write(`\n${table}\n`)
  })
})
