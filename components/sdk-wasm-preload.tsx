import { preloadSdkWasm, SDK_WASM_CACHE } from '@/lib/web-wasm-preload'

/** Keep this in the document head, outside client gates that suppress SSR.
 * Only the primary data entry routes and /login (sign-in reads the chain
 * straight away) start a parser-time download. */
export function SdkWasmPreload() {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''
  const paths = JSON.stringify(['feed', 'post', 'user', 'login'].flatMap(route => [
    `${basePath}/${route}`, `${basePath}/${route}/`,
  ])).replace(/</g, '\\u003c')
  const args = JSON.stringify([
    process.env.NEXT_PUBLIC_SDK_WASM_URL,
    SDK_WASM_CACHE,
  ]).replace(/</g, '\\u003c')
  return <script dangerouslySetInnerHTML={{ __html: `if(${paths}.includes(location.pathname))window.__yapprSdkWasm??=(${preloadSdkWasm.toString()})(...${args});` }} />
}
