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
        // The brotli file (or its decoder) failed: later visits skip it, and this
        // one takes the gzip file the ordinary way (a copy kept from an earlier
        // visit counts).
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
  const { wasm, keep } = await wasmResponse(response, url.endsWith('.br'))
  let output: Awaited<ReturnType<typeof rawInit>>
  try {
    output = await rawInit({ module_or_path: wasm })
  } catch (error) {
    discard(keep.body, error)
    throw error
  }
  storeSdkWasm(url, SDK_WASM_CACHE, keep).catch(() => undefined)
  return output
}

type Wasm = { wasm: Response, keep: Response }

/** The WASM to initialize, and the copy to keep for later visits. */
async function wasmResponse(response: Response | undefined, brotli: boolean): Promise<Wasm> {
  if (!response?.ok || !response.body) throw new Error('SDK download failed')
  const copy = response.clone()
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
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) { prefix.forEach(chunk => controller.enqueue(chunk)) },
    async pull(controller) {
      const chunk = await reader.read()
      if (chunk.done) controller.close()
      else controller.enqueue(chunk.value)
    },
    cancel(reason) { return reader.cancel(reason) },
  })
  // WASM itself (`\0asm`) passes through: decoded by the browser (a host that
  // set Content-Encoding) or by this app on an earlier visit. Otherwise the
  // .br file is brotli by its name (a brotli stream can begin with the gzip
  // magic bytes) and the .gz file is gzip by its magic.
  if (magic[0] === 0x00 && magic[1] === 0x61) return { wasm: asWasm(stream), keep: copy }
  if (brotli) return brotliWasm(stream, copy)
  const gzip = magic[0] === 0x1f && magic[1] === 0x8b
  return { wasm: asWasm(gzip ? stream.pipeThrough(new DecompressionStream('gzip')) : stream), keep: copy }
}

/** Brotli through this browser's DecompressionStream, else through a small
 * WASM decoder loaded only here (Chrome, Android). That path keeps the decoded
 * WASM rather than the download, so later visits need no decoder. */
async function brotliWasm(stream: ReadableStream<Uint8Array<ArrayBuffer>>, copy: Response): Promise<Wasm> {
  try {
    return { wasm: asWasm(stream.pipeThrough(new DecompressionStream('brotli' as CompressionFormat))), keep: copy }
  } catch { /* No brotli in this DecompressionStream. */ }
  let decoded: ReadableStream<Uint8Array<ArrayBuffer>>
  try {
    const { brotliDecoderStream } = await import('./brotli-decoder')
    decoded = stream.pipeThrough(await brotliDecoderStream())
  } catch (error) {
    // Stop the brotli download before the gzip retry starts.
    discard(stream, error)
    discard(copy.body, error)
    throw error
  }
  discard(copy.body)
  const [wasm, keep] = decoded.tee()
  return { wasm: asWasm(wasm), keep: asWasm(keep) }
}

function asWasm(body: ReadableStream<BufferSource>): Response {
  return new Response(body, { headers: { 'Content-Type': 'application/wasm' } })
}

/** Cancels without waiting: a teed source stops only once both branches are
 * cancelled, so awaiting one branch alone can hang. */
function discard(stream: ReadableStream | null, reason?: unknown): void {
  stream?.cancel(reason).catch(() => undefined)
}
