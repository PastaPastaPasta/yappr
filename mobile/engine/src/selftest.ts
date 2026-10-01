import { createEngineClient } from './rpc/client'
import { createHandlerSet } from './rpc/transport'
import type { EngineApi } from './api'

/**
 * selftest.html: the engine plus a host emulated in the same page, for
 * browsers where nothing can drive the page (Mobile Safari on the simulator,
 * Chrome on the emulator). It stubs `window.ReactNativeWebView` before
 * engine.js loads, runs boot → For You → post → profile, and prints the
 * timings into the page and `document.title`.
 */

const inbound = createHandlerSet()
window.ReactNativeWebView = { postMessage: message => setTimeout(() => inbound.deliver(message), 0) }

const client = createEngineClient<EngineApi>({
  send: message => setTimeout(() => window.__yapprEngineReceive?.(message), 0),
  onMessage: inbound.onMessage,
})

const lines: string[] = []
const print = (line: string) => {
  lines.push(line)
  const pre = document.getElementById('out')
  if (pre) pre.textContent = lines.join('\n')
}

async function run() {
  const t0 = performance.now()
  const since = (t: number) => Math.round(performance.now() - t)
  print(`origin ${self.origin} | ${navigator.userAgent}`)
  const hello = await client.ready
  print(`hello ${since(t0)} ms (bundle ${hello.bundleHash.slice(0, 12)})`)
  let t = performance.now()
  const info = await client.api.engine.boot()
  print(`boot ${since(t)} ms (sdk init ${info.bootMs} ms) ${info.network}/${info.topology} evo-sdk ${info.evoSdkVersion}`)
  t = performance.now()
  const page = await client.api.feed.forYou()
  print(`feed ${since(t)} ms, ${page.items.length} posts; cold start to feed ${since(t0)} ms`)
  const sample = page.items[0]
  if (sample) {
    t = performance.now()
    const post = await client.api.posts.get(sample.id)
    print(`post ${since(t)} ms: ${post?.author.username ?? post?.author.id}: ${post?.content.slice(0, 60)}`)
    t = performance.now()
    const profile = await client.api.profiles.get(sample.author.id)
    print(`profile ${since(t)} ms: ${profile?.displayName} (${profile?.stats.posts} posts)`)
  }
  document.title = `PASS cold-to-feed ${since(t0)} ms`
}

run().catch((error: unknown) => {
  print(`FAIL ${error instanceof Error ? error.message : String(error)}`)
  document.title = 'FAIL'
})
