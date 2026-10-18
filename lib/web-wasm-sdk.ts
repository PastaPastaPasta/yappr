/** Web-only alias for the SDK's compressed initializer. Mobile has its own
 * alias/source; all web importers still share the original wasm-bindgen glue. */
import rawInit from '@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js'
import { preloadSdkWasm, storeSdkWasm, SDK_WASM_CACHE } from './web-wasm-preload'

export * from '@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js'

let initializing: ReturnType<typeof rawInit> | undefined

export default function init(): ReturnType<typeof rawInit> {
  initializing ??= (async () => {
    const url = process.env.NEXT_PUBLIC_SDK_WASM_URL
    if (!url) throw new Error('SDK WASM asset is not configured')
    window.__yapprSdkWasm ??= preloadSdkWasm(url, SDK_WASM_CACHE)
    const response = await window.__yapprSdkWasm
    try {
      return await initializeResponse(response, url)
    } catch {
      // A damaged cache entry or a transient first download gets one fresh
      // attempt before evo-sdk retains the final initialization outcome.
      try {
        const cache = await caches.open(SDK_WASM_CACHE)
        await cache.delete(url)
      } catch { /* Storage is optional. The network retry still works. */ }
      try {
        return await initializeResponse(await fetch(url, { cache: 'reload' }), url)
      } catch (error) {
        throw new Error('Couldn’t load Yappr. Please reload to try again.', { cause: error })
      }
    }
  })()
  return initializing
}

async function initializeResponse(response: Response | undefined, url: string): ReturnType<typeof rawInit> {
  const copy = response?.clone()
  const output = await rawInit({ module_or_path: await wasmResponse(response) })
  if (copy) storeSdkWasm(url, SDK_WASM_CACHE, copy).catch(() => undefined)
  return output
}

async function wasmResponse(response: Response | undefined): Promise<Response> {
  if (!response?.ok || !response.body) throw new Error('SDK download failed')
  // Static hosts normally send the gzip file as-is. Also accept hosts that
  // set Content-Encoding: gzip and let the browser decompress it already.
  const reader = response.body.getReader()
  const prefix: Uint8Array<ArrayBuffer>[] = []
  const magic = new Uint8Array(2)
  let read = 0
  while (read < magic.length) {
    const chunk = await reader.read()
    if (chunk.done) break
    prefix.push(chunk.value)
    const count = Math.min(chunk.value.length, magic.length - read)
    magic.set(chunk.value.subarray(0, count), read)
    read += count
  }
  const stream = new ReadableStream<BufferSource>({
    start(controller) { prefix.forEach(chunk => controller.enqueue(chunk)) },
    async pull(controller) {
      const chunk = await reader.read()
      if (chunk.done) controller.close()
      else controller.enqueue(chunk.value)
    },
    cancel(reason) { return reader.cancel(reason) },
  })
  const body = magic[0] === 0x1f && magic[1] === 0x8b
    ? stream.pipeThrough(new DecompressionStream('gzip'))
    : stream
  return new Response(body, { headers: { 'Content-Type': 'application/wasm' } })
}
