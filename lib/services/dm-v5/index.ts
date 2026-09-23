/**
 * DM v5 entry point for the app (docs/DM_V5.md): one engine per signed-in
 * identity, created from the login-derived ENCRYPTION key in the browser
 * secret store and the SDK chain adapter. Everything is gated on `dmIsV5()`.
 */

import bs58 from 'bs58'
import { dmIsV5 } from '@/lib/constants'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import { readScoped, writeScoped } from '@/lib/storage-scope'
import { DmEngine } from './engine'
import { SdkDmChain } from './sdk-chain'

export type { ConversationView, DmEngine, EngineSnapshot, MessageView } from './engine'
export type { RecoveryProgress } from './recovery'
export { MAX_GROUP_MEMBERS } from '@/lib/dm/group'
export { NoEncryptionKeyError } from './directs'

let current: { identityId: string; key: string; engine: DmEngine; detach: () => void } | null = null
const registryListeners = new Set<() => void>()

/** Notified when an engine is created or stopped (useSyncExternalStore-compatible). */
export function subscribeDmEngines(listener: () => void): () => void {
  registryListeners.add(listener)
  return () => registryListeners.delete(listener)
}

/** The running engine for `identityId`, without creating one. */
export function currentDmEngine(identityId: string): DmEngine | null {
  return current?.identityId === identityId ? current.engine : null
}

const notifyRegistry = () => registryListeners.forEach((listener) => listener())

const kv = { get: readScoped, set: writeScoped }

/** Coalesced self-state edits are saved when the page is hidden or closed (§5.5). */
function attachFlush(engine: DmEngine): () => void {
  const flush = () => {
    engine.flush().catch(() => undefined)
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', flush)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', flush)
  }
}

/**
 * The running engine for `identityId`, created on first use. Null when DM v5
 * is off or this device has no encryption key for the identity yet (the UI
 * asks for it). A different user or key replaces the engine.
 */
export function getDmEngine(identityId: string): DmEngine | null {
  if (!dmIsV5() || typeof window === 'undefined') return null
  const encPriv = getEncryptionKeyBytes(identityId)
  if (!encPriv) return null
  const key = bs58.encode(encPriv)
  if (current && current.identityId === identityId && current.key === key) return current.engine
  stopDmEngine()
  const id = bs58.decode(identityId)
  const engine = new DmEngine({ chain: new SdkDmChain(id), identityId: id, encPriv, kv, cacheKey: `yappr_dm_v5:${identityId}` })
  current = { identityId, key, engine, detach: attachFlush(engine) }
  notifyRegistry()
  return engine
}

/** Stop and forget the engine (logout or a user switch), saving pending self-state edits first. */
export function stopDmEngine(): void {
  if (!current) return
  const { engine, detach } = current
  current = null
  detach()
  engine.stop()
  engine.flush().catch(() => undefined)
  notifyRegistry()
}
