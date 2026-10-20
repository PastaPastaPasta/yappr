import { sdkWasmBootstrap } from '@/lib/sdk-wasm-bootstrap'
import { SDK_WASM_CACHE } from '@/lib/web-wasm-preload'

/** Keep this in the document head, outside client gates that suppress SSR. */
export function SdkWasmPreload() {
  const html = sdkWasmBootstrap(process.env.NEXT_PUBLIC_BASE_PATH || '', process.env.NEXT_PUBLIC_SDK_WASM_URL ?? '', SDK_WASM_CACHE)
  return <script dangerouslySetInnerHTML={{ __html: html }} />
}
