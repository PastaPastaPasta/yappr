/** Web-only alias for the SDK's compressed initializer. Mobile has its own
 * alias/source; all web importers still share the original wasm-bindgen glue. */
import rawInit from '@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js'
import { preloadSdkWasm, sdkWasmUrl, storeSdkWasm, SDK_WASM_CACHE, SDK_WASM_SKIP_BROTLI } from './web-wasm-preload'

export * from '@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js'

let initializing: ReturnType<typeof rawInit> | undefined

export default function init(): ReturnType<typeof rawInit> {
  initializing ??= (async () => {
    const gzipUrl = process.env.NEXT_PUBLIC_SDK_WASM_URL
    if (!gzipUrl) throw new Error('SDK WASM asset is not configured')
    const url = sdkWasmUrl(gzipUrl)
    window.__yapprSdkWasm ??= preloadSdkWasm(url, SDK_WASM_CACHE)
    const response = await window.__yapprSdkWasm
    try {
      return await initializeResponse(response, url)
    } catch {
      // A damaged cache entry or a transient first download gets one fresh
      // attempt before evo-sdk retains the final initialization outcome. The
      // retry takes the gzip file, which every browser decodes.
      try {
        const cache = await caches.open(SDK_WASM_CACHE)
        await cache.delete(url)
      } catch { /* Storage is optional. The network retry still works. */ }
      try {
        if (url === gzipUrl) return await initializeResponse(await fetch(gzipUrl, { cache: 'reload' }), gzipUrl)
        // The brotli file failed: later visits skip it, and this one takes the
        // gzip file the ordinary way (a copy kept from an earlier visit counts).
        try { localStorage.setItem(SDK_WASM_SKIP_BROTLI, url) } catch { /* Storage is optional. */ }
        return await initializeResponse(await preloadSdkWasm(gzipUrl, SDK_WASM_CACHE), gzipUrl)
      } catch (error) {
        throw new Error('Couldn’t load Yappr. Please reload to try again.', { cause: error })
      }
    }
  })()
  return initializing
}

async function initializeResponse(response: Response | undefined, url: string): ReturnType<typeof rawInit> {
  const copy = response?.clone()
  const output = await rawInit({ module_or_path: await wasmResponse(response, url.endsWith('.br')) })
  if (copy) storeSdkWasm(url, SDK_WASM_CACHE, copy).catch(() => undefined)
  return output
}

async function wasmResponse(response: Response | undefined, brotli: boolean): Promise<Response> {
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
  // gzip by its magic. WASM itself (`\0asm`) passes through: a host that set
  // Content-Encoding, which the browser already decoded. Brotli has no magic
  // number, so the .br file is known by its name.
  let body: ReadableStream<BufferSource> = stream
  if (magic[0] === 0x1f && magic[1] === 0x8b) body = stream.pipeThrough(new DecompressionStream('gzip'))
  else if (brotli && !(magic[0] === 0x00 && magic[1] === 0x61)) body = stream.pipeThrough(new DecompressionStream('brotli' as CompressionFormat))
  return new Response(body, { headers: { 'Content-Type': 'application/wasm' } })
}
