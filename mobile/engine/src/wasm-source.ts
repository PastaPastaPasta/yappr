/**
 * Where the WebView engine gets the SDK's WASM: engine.wasm.js (./sidecar.ts),
 * which build.mjs writes as one assignment of the module, gzipped and
 * base64-encoded, to `window.__YAPPR_ENGINE_WASM__`. In engine.js it would be
 * 11 of the bundle's 15 MB. The module is decompressed and compiled while it
 * streams (`instantiateStreaming`, off the main thread), and the base64 string
 * is dropped once decoded.
 */
import { setWasmSource } from './shims/wasm-sdk'
import { loadSidecar } from './sidecar'

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const typed = Uint8Array as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> }
  if (typed.fromBase64) return typed.fromBase64(text)
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The module as a streaming `application/wasm` response, decompressed on the fly. */
async function webViewWasm(): Promise<Response> {
  const gzipped = decodeBase64(await loadSidecar('engine.wasm.js'))
  const body = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(body, { headers: { 'Content-Type': 'application/wasm' } })
}

setWasmSource(webViewWasm)
