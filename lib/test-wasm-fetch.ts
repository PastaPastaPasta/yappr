import { readFileSync } from 'node:fs'
import { vi } from 'vitest'

/** A `fetch` stand-in for unit tests: serves `files` by URL, plus any `file:`
 * WASM, which is how the brotli decoder's glue loads its own WASM under Node. */
export function serveFiles(files: Record<string, () => Response> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('file:') && url.endsWith('.wasm')) {
      return new Response(readFileSync(new URL(url)), { headers: { 'Content-Type': 'application/wasm' } })
    }
    const file = files[url]
    if (!file) throw new Error(`unexpected fetch ${url}`)
    return file()
  })
}
