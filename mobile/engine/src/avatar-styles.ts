/**
 * When the DiceBear styles can draw. In engine.js they arrive in a sidecar
 * script (./avatar-source.ts). Everywhere else (the Node harness) the real
 * styles are bundled in.
 */

let ready: Promise<void> = Promise.resolve()

export function setAvatarStylesReady(loading: Promise<void>): void {
  ready = loading
}

/** Resolves once the styles can draw; rejects if they could not load. */
export function avatarStylesReady(): Promise<void> {
  return ready
}
