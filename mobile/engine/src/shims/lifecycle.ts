/**
 * App lifecycle → DOM lifecycle events.
 *
 * The hidden WebView never becomes visible or hidden by itself, so lib code
 * that flushes on `visibilitychange`/`pagehide` (the DM v5 outbox, caches)
 * would never run. The host forwards React Native `AppState` here and the
 * engine replays it as the events a browser tab would fire.
 */

export type AppLifecycleState = 'active' | 'background' | 'inactive'

let hidden = false

/** Make `document.visibilityState`/`hidden` follow the app instead of the (always hidden) WebView. */
export function installVisibilityOverride(doc: Document = document): void {
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  Object.defineProperty(doc, 'hidden', { configurable: true, get: () => hidden })
}

/**
 * Apply an AppState change. `background` fires `visibilitychange` then
 * `pagehide` (the order a tab being backgrounded sees); `active` fires
 * `visibilitychange` then `pageshow`. `inactive` (iOS app switcher, a system
 * sheet) changes nothing, as a briefly occluded tab stays visible.
 */
export function dispatchLifecycle(state: AppLifecycleState, win: Window = window): void {
  if (state === 'inactive') return
  const nextHidden = state === 'background'
  if (nextHidden === hidden) return
  hidden = nextHidden
  win.document.dispatchEvent(new Event('visibilitychange'))
  if (hidden) win.dispatchEvent(new Event('pagehide'))
  else win.dispatchEvent(new Event('pageshow'))
}

/** Forward connectivity changes; lib's SDK bootstrap rebuilds on `online`. */
export function dispatchConnectivity(online: boolean, win: Window = window): void {
  win.dispatchEvent(new Event(online ? 'online' : 'offline'))
}
