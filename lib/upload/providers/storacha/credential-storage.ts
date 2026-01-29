'use client'

/**
 * Storacha Credential Storage
 *
 * Manages persistent storage of Storacha credentials using the same
 * pattern as lib/secure-storage.ts. Credentials are stored per-identity
 * to support multi-account scenarios.
 */

import type { StorachaCredentials } from '../../types'

const PREFIX = 'yappr_storacha_'

/**
 * Get storage for Storacha credentials.
 * Always uses localStorage since:
 * - Storacha credentials are not security-sensitive (only authorize uploads to user's own space)
 * - Re-verification via email is high-friction
 * - On-chain backup exists for cross-device sync
 */
function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  return localStorage
}

/**
 * Check if storage is available
 */
function isStorageAvailable(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const test = '__storage_test__'
    localStorage.setItem(test, test)
    localStorage.removeItem(test)
    return true
  } catch {
    return false
  }
}

/**
 * Store a value with the Storacha prefix
 */
function set(key: string, value: unknown): void {
  if (!isStorageAvailable()) return
  const storage = getStorage()
  if (!storage) return
  try {
    storage.setItem(PREFIX + key, JSON.stringify(value))
  } catch (e) {
    console.error('StorachaCredentialStorage: Failed to store value:', e)
  }
}

/**
 * Get a value from storage
 */
function get(key: string): unknown {
  if (!isStorageAvailable()) return null
  try {
    const storage = getStorage()
    if (!storage) return null
    const item = storage.getItem(PREFIX + key)
    if (item) return JSON.parse(item)

    // Fallback: check sessionStorage for credentials stored before this change
    const fallback = sessionStorage.getItem(PREFIX + key)
    return fallback ? JSON.parse(fallback) : null
  } catch {
    return null
  }
}

/**
 * Delete a value from storage
 */
function remove(key: string): boolean {
  if (!isStorageAvailable()) return false
  // Clear from both storages
  localStorage.removeItem(PREFIX + key)
  sessionStorage.removeItem(PREFIX + key)
  return true
}

/**
 * Check if a key exists
 */
function has(key: string): boolean {
  if (!isStorageAvailable()) return false
  const storage = getStorage()
  if (!storage) return false
  if (storage.getItem(PREFIX + key) !== null) return true
  // Check sessionStorage as fallback for credentials stored before this change
  return sessionStorage.getItem(PREFIX + key) !== null
}

// ==========================================
// Public API - Identity-scoped credentials
// ==========================================

/**
 * Store Storacha email for an identity
 */
export function storeStorachaEmail(identityId: string, email: string): void {
  set(`email_${identityId}`, email)
}

/**
 * Get Storacha email for an identity
 */
export function getStorachaEmail(identityId: string): string | null {
  const value = get(`email_${identityId}`)
  return typeof value === 'string' ? value : null
}

/**
 * Store serialized agent data for an identity
 */
export function storeStorachaAgent(identityId: string, agentData: string): void {
  set(`agent_${identityId}`, agentData)
}

/**
 * Get serialized agent data for an identity
 */
export function getStorachaAgent(identityId: string): string | null {
  const value = get(`agent_${identityId}`)
  return typeof value === 'string' ? value : null
}

/**
 * Store space DID for an identity
 */
export function storeStorachaSpace(identityId: string, spaceDid: string): void {
  set(`space_${identityId}`, spaceDid)
}

/**
 * Get space DID for an identity
 */
export function getStorachaSpace(identityId: string): string | null {
  const value = get(`space_${identityId}`)
  return typeof value === 'string' ? value : null
}

/**
 * Check if Storacha credentials exist for an identity
 */
export function hasStorachaCredentials(identityId: string): boolean {
  const hasEmail = has(`email_${identityId}`)
  const hasAgent = has(`agent_${identityId}`)
  const hasSpace = has(`space_${identityId}`)
  console.log('[Storacha Storage] hasCredentials check:', { identityId, hasEmail, hasAgent, hasSpace })
  return hasEmail && hasAgent && hasSpace
}

/**
 * Get all Storacha credentials for an identity
 */
export function getStorachaCredentials(identityId: string): StorachaCredentials | null {
  const email = getStorachaEmail(identityId)
  const agentData = getStorachaAgent(identityId)
  const spaceDid = getStorachaSpace(identityId)

  if (!email || !agentData || !spaceDid) {
    return null
  }

  return { email, agentData, spaceDid }
}

/**
 * Store all Storacha credentials for an identity
 */
export function storeStorachaCredentials(identityId: string, credentials: StorachaCredentials): void {
  console.log('[Storacha Storage] Storing credentials for identity:', identityId)
  storeStorachaEmail(identityId, credentials.email)
  storeStorachaAgent(identityId, credentials.agentData)
  storeStorachaSpace(identityId, credentials.spaceDid)
  console.log('[Storacha Storage] Credentials stored successfully')
}

/**
 * Clear all Storacha credentials for an identity
 */
export function clearStorachaCredentials(identityId: string): void {
  remove(`email_${identityId}`)
  remove(`agent_${identityId}`)
  remove(`space_${identityId}`)
}

/**
 * Clear all Storacha credentials (for all identities)
 */
export function clearAllStorachaCredentials(): void {
  if (!isStorageAvailable()) return

  const clearFromStorage = (storage: Storage) => {
    const keysToRemove: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(PREFIX)) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => storage.removeItem(key))
  }

  clearFromStorage(localStorage)
  clearFromStorage(sessionStorage)
}
