'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { logger } from '@/lib/logger'
import {
  currentDmEngine,
  getDmEngine,
  stopDmEngine,
  subscribeDmEngines,
  type DmEngine,
  type EngineSnapshot,
} from '@/lib/services/dm-v5'
import { useNotificationStore } from '@/lib/stores/notification-store'
import { resolveUserDetailsBatch, type UserDetails } from '@/lib/utils/resolve-user-details'

const noopSubscribe = () => () => undefined
const nullSnapshot = (): EngineSnapshot | null => null

/**
 * The DM v5 engine for the signed-in user, started on first use. `engine` is
 * null while this device has no encryption key for the identity; call
 * `retry()` after the key has been entered.
 */
export function useDmEngine(identityId: string | undefined): { engine: DmEngine | null; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const engine = useSyncExternalStore(
    subscribeDmEngines,
    () => (identityId ? currentDmEngine(identityId) : null),
    () => null
  )
  useEffect(() => {
    if (!identityId) return
    getDmEngine(identityId)?.start().catch((error) => logger.warn('DM v5 engine failed to start:', error))
  }, [identityId, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { engine, retry }
}

export function useEngineSnapshot(engine: DmEngine | null): EngineSnapshot | null {
  return useSyncExternalStore(engine?.subscribe ?? noopSubscribe, engine?.getSnapshot ?? nullSnapshot, nullSnapshot)
}

/**
 * Keeps the Messages nav badge on the v5 unread total, and runs the background
 * poll on every page (§6.3: every 30 s while the app is open). Stops the
 * engine on logout.
 */
export function useDmV5Badge(identityId: string | undefined, enabled: boolean): void {
  const { engine } = useDmEngine(enabled ? identityId : undefined)
  const snapshot = useEngineSnapshot(engine)
  const total = snapshot?.unreadTotal
  useEffect(() => {
    if (!enabled) return
    if (!identityId) stopDmEngine()
  }, [enabled, identityId])
  useEffect(() => {
    if (enabled && total !== undefined) useNotificationStore.getState().setDmUnreadCount(total)
  }, [enabled, total])
}

/** Session cache of display names. Every update swaps in a new map, so it doubles as the store snapshot. */
let detailsCache: ReadonlyMap<string, UserDetails> = new Map()
const pending = new Set<string>()
const detailListeners = new Set<() => void>()

function subscribeDetails(listener: () => void): () => void {
  detailListeners.add(listener)
  return () => detailListeners.delete(listener)
}

const detailsSnapshot = () => detailsCache
const emptyDetails: ReadonlyMap<string, UserDetails> = new Map()

function loadDetails(ids: string[]): void {
  const missing = ids.filter((id) => id && !detailsCache.has(id) && !pending.has(id))
  if (missing.length === 0) return
  missing.forEach((id) => pending.add(id))
  resolveUserDetailsBatch(missing)
    .then((resolved) => {
      detailsCache = new Map([...Array.from(detailsCache.entries()), ...Array.from(resolved.entries())])
      detailListeners.forEach((listener) => listener())
    })
    .catch((error) => logger.warn('Could not load user details:', error))
    .finally(() => missing.forEach((id) => pending.delete(id)))
}

/** Display names and usernames for identity ids, loaded in batches and cached for the session. */
export function useUserDetails(ids: string[]): ReadonlyMap<string, UserDetails> {
  const key = Array.from(new Set(ids)).sort().join(',')
  const cache = useSyncExternalStore(subscribeDetails, detailsSnapshot, () => emptyDetails)
  useEffect(() => loadDetails(key.split(',')), [key])
  return cache
}

export function displayNameOf(details: ReadonlyMap<string, UserDetails>, id: string): string {
  const found = details.get(id)
  if (found?.displayName && !found.displayName.startsWith('User ')) return found.displayName
  if (found?.username) return found.username.replace(/\.dash$/, '')
  return `${id.slice(0, 8)}...`
}
