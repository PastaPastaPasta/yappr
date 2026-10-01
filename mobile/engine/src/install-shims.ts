import { stringify } from './protocol/codec'
import { PROTOCOL_VERSION } from './protocol/envelope'
import { createEngineStorage, installEngineStorage, takeInjectedSnapshot } from './shims/storage'
import { installVisibilityOverride } from './shims/lifecycle'

/**
 * Runs before any lib module is evaluated (it is the WebView entry's first
 * import, and esbuild keeps import evaluation order), so module-scope reads of
 * `localStorage` already see the engine's storage, hydrated from the snapshot
 * the host injected before load.
 *
 * It also reports uncaught errors straight to the bridge: if a lib module
 * throws while loading, the bundle stops before the dispatcher exists, and
 * this log line is the only thing the host hears besides its hello timeout.
 */

function report(prefix: string, reason: unknown) {
  const text = reason instanceof Error ? reason.stack ?? `${reason.name}: ${reason.message}` : String(reason)
  try {
    window.ReactNativeWebView?.postMessage(stringify({ t: 'log', v: PROTOCOL_VERSION, level: 'error', message: `${prefix}: ${text}` }))
  } catch {
    // No bridge: nothing to report to.
  }
}

window.addEventListener('error', event => report('Uncaught', event.error ?? event.message))
window.addEventListener('unhandledrejection', event => report('Unhandled rejection', event.reason))

export const engineStorage = createEngineStorage()

/** Keys the host filed under the wrong area; the entry logs them once the bridge is up. */
export const { misrouted: misroutedStorageKeys } = engineStorage.hydrate(takeInjectedSnapshot())
installEngineStorage(engineStorage)
installVisibilityOverride()

// Nothing in lib uses IndexedDB (ENGINE.md §9.1), and nothing on the host backs
// it up: an unexpected user should fail loudly rather than write to an
// origin store that disappears with the WebView's data.
Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true })
