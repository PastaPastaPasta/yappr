import { scopedKey } from '@/lib/storage-scope'
import { createEngineStorage, installEngineStorage, takeInjectedSnapshot } from './shims/storage'
import { installVisibilityOverride } from './shims/lifecycle'

/**
 * Runs before any lib module is evaluated (it is the WebView entry's first
 * import, and esbuild keeps import evaluation order), so module-scope reads of
 * `localStorage` already see the engine's storage, hydrated from the snapshot
 * the host injected before load.
 */

/** lib/secure-storage's prefix, after the deployment scope. */
const SECURE_PREFIX = scopedKey('yappr_secure_')

export const engineStorage = createEngineStorage(key => key.startsWith(SECURE_PREFIX))

engineStorage.hydrate(takeInjectedSnapshot())
installEngineStorage(engineStorage)
installVisibilityOverride()
