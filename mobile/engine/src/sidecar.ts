/**
 * The scripts build.mjs writes beside engine.js, kept out of it so the bundle
 * every engine start parses is small (README "How the wasm loads"). Each one
 * sets a single `window` global, and every page runs them after engine.js,
 * so the engine says hello first:
 *
 * - iOS `index.html`, `engine.html` and `selftest.html` load them by URL;
 * - the Android loader page inserts them, in order (`async = false`);
 * - `engine.inline.html` (iOS dev, and dev clients built before the split)
 *   inlines them.
 *
 * engine.js runs before either sidecar on all of these, so a capture-phase
 * listener installed while it evaluates sees every sidecar's `load` or
 * `error`, whenever it happens. Nothing is ever fetched or injected: a page
 * without a sidecar fails fast instead.
 */

export const SIDECARS = { wasm: 'engine.wasm.js', avatars: 'engine.avatars.js' } as const

type Sidecar = (typeof SIDECARS)[keyof typeof SIDECARS]
type Outcome = 'load' | 'error'

const outcomes = new Map<Sidecar, Outcome>()
const changed = new Set<() => void>()

function sidecarOf(target: EventTarget | null): Sidecar | undefined {
  if (!(target instanceof HTMLScriptElement)) return undefined
  const src = target.getAttribute('src') ?? ''
  return Object.values(SIDECARS).find(file => src === file || src.endsWith(`/${file}`))
}

function record(event: Event) {
  const sidecar = sidecarOf(event.target)
  if (!sidecar) return
  outcomes.set(sidecar, event.type as Outcome)
  for (const listener of changed) listener()
}

// Script events do not bubble; capture sees them all.
document.addEventListener('load', record, true)
document.addEventListener('error', record, true)
document.addEventListener('DOMContentLoaded', () => { for (const listener of changed) listener() })

/** Resolves on the next sidecar outcome or DOMContentLoaded. */
function nextChange(): Promise<void> {
  return new Promise(resolve => {
    const listener = () => {
      changed.delete(listener)
      resolve()
    }
    changed.add(listener)
  })
}

/**
 * The value `take` reads from the global `file` sets, once that script has
 * run. `take` should also delete the global, so a large one can be collected;
 * call this once per sidecar.
 */
export async function loadSidecar<T>(file: Sidecar, take: () => T | undefined): Promise<T> {
  for (;;) {
    const value = take()
    if (value !== undefined) return value
    const outcome = outcomes.get(file)
    if (outcome === 'error') throw new Error(`${file} did not load`)
    if (outcome === 'load') throw new Error(`${file} ran but did not set its global`)
    // Once the page is parsed, a sidecar it does not reference is never coming.
    if (document.readyState !== 'loading' && !document.querySelector(`script[src$="${file}"]`)) {
      throw new Error(`${file} is not on the page`)
    }
    await nextChange()
  }
}
