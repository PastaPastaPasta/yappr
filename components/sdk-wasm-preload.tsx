import { preloadSdkWasm, SDK_WASM_CACHE } from '@/lib/web-wasm-preload'

/**
 * Routes that render without Platform data. Every other route reads through
 * the SDK, so it starts the WASM download while the HTML is still parsing:
 * on a slow phone the download is most of the wait, and starting it at
 * hydration instead costs seconds.
 */
const STATIC_ROUTES = ['about', 'about/private-feeds', 'cookies', 'privacy', 'terms']

/** Keep this in the document head, outside client gates that suppress SSR. */
export function SdkWasmPreload() {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''
  const skip = JSON.stringify(STATIC_ROUTES.flatMap(route => [
    `${basePath}/${route}`, `${basePath}/${route}/`,
  ])).replace(/</g, '\\u003c')
  const args = JSON.stringify([
    process.env.NEXT_PUBLIC_SDK_WASM_URL,
    SDK_WASM_CACHE,
  ]).replace(/</g, '\\u003c')
  return <script dangerouslySetInnerHTML={{ __html: `if(!${skip}.includes(location.pathname))window.__yapprSdkWasm??=(${preloadSdkWasm.toString()})(...${args});` }} />
}
