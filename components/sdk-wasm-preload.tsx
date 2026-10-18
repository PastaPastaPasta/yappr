import { preloadSdkWasm, SDK_WASM_CACHE } from '@/lib/web-wasm-preload'

/** Parser-time download on the three primary data entry routes. Other routes
 * retain on-demand initialization, including static legal/help pages. */
export function SdkWasmPreload() {
  const args = JSON.stringify([
    process.env.NEXT_PUBLIC_SDK_WASM_URL,
    SDK_WASM_CACHE,
  ]).replace(/</g, '\\u003c')
  return <script dangerouslySetInnerHTML={{ __html: `window.__yapprSdkWasm??=(${preloadSdkWasm.toString()})(...${args});` }} />
}
