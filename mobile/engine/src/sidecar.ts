/**
 * The scripts build.mjs writes beside engine.js, kept out of it so the bundle
 * every engine start parses is small (README "How the wasm loads"). Each one
 * sets a single `window` global. Pages place them after engine.js, so the
 * engine says hello first:
 *
 * - engine.inline.html (iOS) inlines them after the bundle: they have run by
 *   DOMContentLoaded;
 * - engine.html and the Android loader page load them by URL, in order and in
 *   parallel with engine.js: the engine waits for each one's `load`;
 * - any other page gets them injected from beside the page.
 */

export const SIDECARS = { wasm: 'engine.wasm.js', avatars: 'engine.avatars.js' } as const

function domReady(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve()
  return new Promise(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }))
}

/**
 * The value `take` reads from the global `file` sets, once that script has
 * run. `take` should also delete the global, so a large one can be collected.
 */
export async function loadSidecar<T>(file: string, take: () => T | undefined): Promise<T> {
  await domReady()
  const ready = take()
  if (ready !== undefined) return ready
  let script = document.querySelector<HTMLScriptElement>(`script[src$="${file}"]`)
  if (!script) {
    script = document.createElement('script')
    script.src = file
    document.head.appendChild(script)
  }
  await new Promise<void>((resolve, reject) => {
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error(`${file} did not load`)), { once: true })
  })
  const loaded = take()
  if (loaded === undefined) throw new Error(`${file} loaded but did not set its global`)
  return loaded
}
