'use client'

/**
 * Pinata Credential Storage
 *
 * Manages persistent storage of Pinata API credentials using the same
 * pattern as Storacha credential storage. Credentials are stored per-identity
 * to support multi-account scenarios.
 */

import type { PinataCredentials } from './types'

const PREFIX = 'yappr_pinata_'

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
 * Store a value with the Pinata prefix
 */
function set(key: string, value: unknown): void {
  if (!isStorageAvailable()) return
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch (e) {
    console.error('PinataCredentialStorage: Failed to store value:', e)
  }
}

/**
 * Get a value from storage
 */
function get(key: string): unknown {
  if (!isStorageAvailable()) return null
  try {
    const item = localStorage.getItem(PREFIX + key)
    return item ? JSON.parse(item) : null
  } catch {
    return null
  }
}

/**
 * Delete a value from storage
 */
function remove(key: string): boolean {
  if (!isStorageAvailable()) return false
  localStorage.removeItem(PREFIX + key)
  return true
}

/**
 * Check if a key exists
 */
function has(key: string): boolean {
  if (!isStorageAvailable()) return false
  return localStorage.getItem(PREFIX + key) !== null
}

// ==========================================
// Public API - Identity-scoped credentials
// ==========================================

/**
 * Store Pinata JWT for an identity
 */
export function storePinataJwt(identityId: string, jwt: string): void {
  set(`jwt_${identityId}`, jwt)
}

/**
 * Get Pinata JWT for an identity
 */
export function getPinataJwt(identityId: string): string | null {
  const value = get(`jwt_${identityId}`)
  return typeof value === 'string' ? value : null
}

/**
 * Store Pinata gateway for an identity
 */
export function storePinataGateway(identityId: string, gateway: string): void {
  set(`gateway_${identityId}`, gateway)
}

/**
 * Get Pinata gateway for an identity
 */
export function getPinataGateway(identityId: string): string | null {
  const value = get(`gateway_${identityId}`)
  return typeof value === 'string' ? value : null
}

/**
 * Check if Pinata credentials exist for an identity
 */
export function hasPinataCredentials(identityId: string): boolean {
  const hasJwt = has(`jwt_${identityId}`)
  console.log('[Pinata Storage] hasCredentials check:', { identityId, hasJwt })
  return hasJwt
}

/**
 * Get all Pinata credentials for an identity
 */
export function getPinataCredentials(identityId: string): PinataCredentials | null {
  const jwt = getPinataJwt(identityId)

  if (!jwt) {
    return null
  }

  const gateway = getPinataGateway(identityId)
  return { jwt, gateway: gateway || undefined }
}

/**
 * Store all Pinata credentials for an identity
 */
export function storePinataCredentials(identityId: string, credentials: PinataCredentials): void {
  console.log('[Pinata Storage] Storing credentials for identity:', identityId)
  storePinataJwt(identityId, credentials.jwt)
  if (credentials.gateway) {
    storePinataGateway(identityId, credentials.gateway)
  } else {
    // Clear any previously stored gateway when new credentials don't include one
    remove(`gateway_${identityId}`)
  }
  console.log('[Pinata Storage] Credentials stored successfully')
}

/**
 * Clear all Pinata credentials for an identity
 */
export function clearPinataCredentials(identityId: string): void {
  remove(`jwt_${identityId}`)
  remove(`gateway_${identityId}`)
}

/**
 * Clear all Pinata credentials (for all identities)
 */
export function clearAllPinataCredentials(): void {
  if (!isStorageAvailable()) return

  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(PREFIX)) {
      keysToRemove.push(key)
    }
  }
  keysToRemove.forEach(key => localStorage.removeItem(key))
}
