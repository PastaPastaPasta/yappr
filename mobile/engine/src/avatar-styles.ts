/**
 * When the DiceBear styles can draw. In engine.js they arrive in a sidecar
 * script (avatars/collection-shim.ts); the WebView entry sets the promise.
 * Everywhere else (the Node harness) the real styles are bundled in.
 */
import type * as Collection from '@dicebear/collection'

declare global {
  interface Window {
    /** Set by engine.avatars.js. */
    __YAPPR_ENGINE_AVATARS__?: typeof Collection
  }
}

let ready: Promise<void> = Promise.resolve()

export function setAvatarStylesReady(loading: Promise<void>): void {
  ready = loading
}

/** Resolves once the styles can draw; rejects if they could not load. */
export function avatarStylesReady(): Promise<void> {
  return ready
}
