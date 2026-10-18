export const SDK_WASM_CACHE = `yappr-sdk-wasm:${process.env.NEXT_PUBLIC_BASE_PATH || '/'}`

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
