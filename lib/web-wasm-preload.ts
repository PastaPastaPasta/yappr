export const SDK_WASM_CACHE = `yappr-sdk-wasm:${process.env.NEXT_PUBLIC_BASE_PATH || '/'}`

/** localStorage key holding a brotli asset URL that failed to load here. */
export const SDK_WASM_SKIP_BROTLI = 'yappr-sdk-wasm-skip-brotli'

/** The SDK asset this browser should download: the brotli file (about a
 * third smaller) where DecompressionStream reads brotli and that file has not
 * failed here before, else the gzip file. Self-contained like
 * {@link preloadSdkWasm}: it is also inlined in the head, so the storage key
 * is spelled out rather than taken from SDK_WASM_SKIP_BROTLI. */
export function sdkWasmUrl(gzipUrl: string): string {
  const brotliUrl = gzipUrl.replace(/\.gz$/, '.br')
  try {
    new DecompressionStream('brotli' as CompressionFormat)
  } catch {
    return gzipUrl
  }
  try {
    if (localStorage.getItem('yappr-sdk-wasm-skip-brotli') === brotliUrl) return gzipUrl
  } catch { /* Storage may be blocked; nothing has been remembered then. */ }
  return brotliUrl
}

/** Runs while parsing HTML, before hydration. Keep this function self-contained:
 * its source is also the inline bootstrap in the static export. */
export function preloadSdkWasm(url: string, cacheName: string): Promise<Response | undefined> {
  return (async () => {
    try {
      const cache = await caches.open(cacheName)
      const cached = await cache.match(url)
      if (cached) return cached
    } catch {
      // Storage may be blocked, full, or unavailable. Network still works.
    }
    const response = await fetch(url, { cache: 'force-cache' })
    if (!response.ok) throw new Error(`SDK download failed (${response.status})`)
    return response
  })().catch(() => undefined) // A speculative failure must not be unhandled.
}

/** Called only after WASM initializes successfully. Invalid responses are
 * never stored, including a completed HTTP 200 containing a broken payload. */
export async function storeSdkWasm(url: string, cacheName: string, response: Response): Promise<void> {
  const cache = await caches.open(cacheName)
  if (await cache.match(url)) return
  await cache.put(url, response)
  // Bound disk use to this version, within this deployment only.
  const keys = await cache.keys()
  const currentUrl = new URL(url, location.href).href
  await Promise.all(keys.filter(key => key.url !== currentUrl).map(key => cache.delete(key)))
}

declare global {
  interface Window {
    __yapprSdkWasm?: Promise<Response | undefined>
  }
}
