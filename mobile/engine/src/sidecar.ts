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

import type * as AvatarStyles from '@dicebear/collection'

declare global {
  interface Window {
    /** Set by engine.wasm.js: the SDK's WASM, gzip + base64. */
    __YAPPR_ENGINE_WASM__?: string
    /** Set by engine.avatars.js: the DiceBear styles. */
    __YAPPR_ENGINE_AVATARS__?: typeof AvatarStyles
  }
}

/** Each sidecar and the global it sets. */
const SIDECARS = {
  'engine.wasm.js': '__YAPPR_ENGINE_WASM__',
  'engine.avatars.js': '__YAPPR_ENGINE_AVATARS__',
} as const

type Sidecar = keyof typeof SIDECARS
type Outcome = 'load' | 'error'

const outcomes = new Map<Sidecar, Outcome>()
const changed = new Set<() => void>()

function sidecarOf(element: EventTarget | null): Sidecar | undefined {
  if (!(element instanceof HTMLScriptElement)) return undefined
  const src = element.getAttribute('src') ?? ''
  return (Object.keys(SIDECARS) as Sidecar[]).find(file => src === file || src.endsWith(`/${file}`))
}

function notify() {
  for (const listener of changed) listener()
}

// Script events do not bubble; capture sees them all.
for (const type of ['load', 'error'] as const) {
  document.addEventListener(type, (event) => {
    const sidecar = sidecarOf(event.target)
    if (!sidecar) return
    outcomes.set(sidecar, type)
    notify()
  }, true)
}
document.addEventListener('DOMContentLoaded', notify)

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

/** The global `file` sets, once it has run, removed from `window` so a large one can be collected. Call once per sidecar. */
export async function loadSidecar<S extends Sidecar>(file: S): Promise<NonNullable<Window[(typeof SIDECARS)[S]]>> {
  const key = SIDECARS[file]
  for (;;) {
    const value = window[key] as Window[(typeof SIDECARS)[S]]
    if (value !== undefined) {
      delete window[key]
      return value as NonNullable<typeof value>
    }
    const outcome = outcomes.get(file)
    if (outcome === 'error') throw new Error(`${file} did not load`)
    if (outcome === 'load') throw new Error(`${file} ran but did not set ${key}`)
    // Once the page is parsed, a sidecar it does not reference is never coming.
    if (document.readyState !== 'loading' && ![...document.scripts].some(script => sidecarOf(script) === file)) {
      throw new Error(`${file} is not on the page`)
    }
    await nextChange()
  }
}
