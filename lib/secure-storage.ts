'use client'

import { parsePrivateKey, privateKeyToWif, isLikelyWif } from '@/lib/crypto/wif'

/**
 * Secure storage for sensitive data like private keys
 * Supports two modes:
 * - localStorage: "Remember me" - shared across tabs, persists until logout
 * - sessionStorage: Default - isolated per tab, cleared when tab closes
 */
class SecureStorage {
  private prefix = 'yappr_secure_'
  private rememberKey = 'yappr_remember_me'

  private getKeysWithPrefix(storage: Storage): string[] {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(this.prefix)) {
        keys.push(key)
      }
    }
    return keys
  }

  private getStorage(): Storage | null {
    if (typeof window === 'undefined') return null
    // Check if "remember me" was selected
    const remember = localStorage.getItem(this.rememberKey) === 'true'
    return remember ? localStorage : sessionStorage
  }

  private isAvailable(): boolean {
    if (typeof window === 'undefined') return false
    try {
      const test = '__storage_test__'
      sessionStorage.setItem(test, test)
      sessionStorage.removeItem(test)
      return true
    } catch {
      return false
    }
  }

  /**
   * Set whether to remember the session across tabs
   */
  setRememberMe(remember: boolean): void {
    if (typeof window === 'undefined') return
    if (remember) {
      localStorage.setItem(this.rememberKey, 'true')
    } else {
      localStorage.removeItem(this.rememberKey)
    }
  }

  /**
   * Check if "remember me" is enabled
   */
  isRememberMe(): boolean {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(this.rememberKey) === 'true'
  }

  /**
   * Store a value securely
   */
  set(key: string, value: unknown): void {
    if (!this.isAvailable()) return
    const storage = this.getStorage()
    if (!storage) return
    try {
      storage.setItem(this.prefix + key, JSON.stringify(value))
    } catch (e) {
      console.error('SecureStorage: Failed to store value:', e)
    }
  }

  /**
   * Get a value from secure storage
   */
  get(key: string): unknown {
    if (!this.isAvailable()) return null
    // Check both storages - user might have switched modes
    try {
      const storage = this.getStorage()
      if (!storage) return null
      const item = storage.getItem(this.prefix + key)
      if (item) return JSON.parse(item)

      // Fallback: check the other storage in case mode changed
      const otherStorage = this.isRememberMe() ? sessionStorage : localStorage
      const fallback = otherStorage.getItem(this.prefix + key)
      return fallback ? JSON.parse(fallback) : null
    } catch {
      return null
    }
  }

  /**
   * Check if a key exists
   */
  has(key: string): boolean {
    if (!this.isAvailable()) return false
    const storage = this.getStorage()
    if (!storage) return false
    if (storage.getItem(this.prefix + key) !== null) return true
    // Check other storage as fallback
    const otherStorage = this.isRememberMe() ? sessionStorage : localStorage
    return otherStorage.getItem(this.prefix + key) !== null
  }

  /**
   * Delete a value from secure storage
   */
  delete(key: string): boolean {
    if (!this.isAvailable()) return false
    const existed = this.has(key)
    // Clear from both storages
    localStorage.removeItem(this.prefix + key)
    sessionStorage.removeItem(this.prefix + key)
    return existed
  }

  /**
   * Clear all stored values with our prefix (from both storages)
   */
  clear(): void {
    if (!this.isAvailable()) return

    this.getKeysWithPrefix(localStorage).forEach(key => localStorage.removeItem(key))
    this.getKeysWithPrefix(sessionStorage).forEach(key => sessionStorage.removeItem(key))
    localStorage.removeItem(this.rememberKey)
  }

  /**
   * Get all keys (for debugging - should not expose actual values)
   */
  keys(): string[] {
    if (!this.isAvailable()) return []

    const allKeys = [
      ...this.getKeysWithPrefix(localStorage),
      ...this.getKeysWithPrefix(sessionStorage)
    ]
    const uniqueKeys = new Set(allKeys.map(k => k.slice(this.prefix.length)))
    return Array.from(uniqueKeys)
  }

  /**
   * Get storage size
   */
  size(): number {
    return this.keys().length
  }
}

// Singleton instance
const secureStorage = new SecureStorage()

export default secureStorage

// Helper functions for common use cases
export const storePrivateKey = (identityId: string, privateKey: string) => {
  secureStorage.set(`pk_${identityId}`, privateKey)
}

export const getPrivateKey = (identityId: string): string | null => {
  const value = secureStorage.get(`pk_${identityId}`)
  return typeof value === 'string' ? value : null
}

export const clearPrivateKey = (identityId: string): boolean => {
  return secureStorage.delete(`pk_${identityId}`)
}

export const hasPrivateKey = (identityId: string): boolean => {
  return secureStorage.has(`pk_${identityId}`)
}

export const clearAllPrivateKeys = (): void => {
  const keys = secureStorage.keys()
  keys.filter(key => key.startsWith('pk_')).forEach(key => {
    secureStorage.delete(key)
  })
}

export const setRememberMe = (remember: boolean): void => {
  secureStorage.setRememberMe(remember)
}

export const isRememberMe = (): boolean => {
  return secureStorage.isRememberMe()
}

export const clearRememberMe = (): void => {
  if (typeof window === 'undefined') return
  localStorage.removeItem('yappr_remember_me')
}

// Encryption key storage for private feed operations
// Keys are stored in WIF format for consistency with other private keys

/**
 * Get the configured network from environment
 */
const getConfiguredNetwork = (): 'testnet' | 'mainnet' => {
  if (process?.env?.NEXT_PUBLIC_NETWORK) {
    return process.env.NEXT_PUBLIC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  }
  return 'testnet'
}

/**
 * Store encryption key in WIF format.
 * Accepts both WIF and hex formats - converts hex to WIF before storing.
 */
export const storeEncryptionKey = (identityId: string, encryptionKey: string) => {
  // If already WIF, store as-is
  if (isLikelyWif(encryptionKey)) {
    secureStorage.set(`ek_${identityId}`, encryptionKey)
    return
  }

  // Parse the key (handles both hex and WIF)
  const parsed = parsePrivateKey(encryptionKey)

  // Convert to WIF for storage using configured network
  const network = getConfiguredNetwork()
  const wif = privateKeyToWif(parsed.privateKey, network, true)
  secureStorage.set(`ek_${identityId}`, wif)
}

/**
 * Get encryption key as raw string (for display/backup purposes).
 * Returns the stored format (WIF for new keys, possibly hex for legacy).
 */
export const getEncryptionKey = (identityId: string): string | null => {
  const value = secureStorage.get(`ek_${identityId}`)
  return typeof value === 'string' ? value : null
}

/**
 * Get encryption key as Uint8Array bytes.
 * Handles both WIF and legacy hex formats automatically.
 */
export const getEncryptionKeyBytes = (identityId: string): Uint8Array | null => {
  const value = getEncryptionKey(identityId)
  if (!value) return null

  try {
    const parsed = parsePrivateKey(value)
    return parsed.privateKey
  } catch {
    return null
  }
}

export const hasEncryptionKey = (identityId: string): boolean => {
  return secureStorage.has(`ek_${identityId}`)
}

export const clearEncryptionKey = (identityId: string): boolean => {
  return secureStorage.delete(`ek_${identityId}`)
}

// Key type tracking for encryption and transfer keys
// 'derived' means the key was derived from auth key and can be re-derived
// 'external' means the key was pre-existing/manually entered and must be backed up
// Note: This type is also defined in lib/crypto/key-derivation.ts - kept separate
// to avoid circular import issues since secure-storage is a low-level module.

export type KeyType = 'derived' | 'external'

/**
 * Store the type of encryption key (derived or external)
 */
export const storeEncryptionKeyType = (identityId: string, type: KeyType) => {
  secureStorage.set(`ek_type_${identityId}`, type)
}

/**
 * Get the type of encryption key
 */
export const getEncryptionKeyType = (identityId: string): KeyType | null => {
  const value = secureStorage.get(`ek_type_${identityId}`)
  return value === 'derived' || value === 'external' ? value : null
}

/**
 * Clear encryption key type
 */
export const clearEncryptionKeyType = (identityId: string): boolean => {
  return secureStorage.delete(`ek_type_${identityId}`)
}

// Transfer key storage for credit transfer operations
// Keys are stored in WIF format for consistency with other private keys

/**
 * Store transfer key in WIF format.
 * Accepts both WIF and hex formats - converts hex to WIF before storing.
 */
export const storeTransferKey = (identityId: string, transferKey: string) => {
  // If already WIF, store as-is
  if (isLikelyWif(transferKey)) {
    secureStorage.set(`tk_${identityId}`, transferKey)
    return
  }

  // Parse the key (handles both hex and WIF)
  const parsed = parsePrivateKey(transferKey)

  // Convert to WIF for storage using configured network
  const network = getConfiguredNetwork()
  const wif = privateKeyToWif(parsed.privateKey, network, true)
  secureStorage.set(`tk_${identityId}`, wif)
}

/**
 * Get transfer key as raw string (for display/backup purposes).
 * Returns the stored format (WIF for new keys, possibly hex for legacy).
 */
export const getTransferKey = (identityId: string): string | null => {
  const value = secureStorage.get(`tk_${identityId}`)
  return typeof value === 'string' ? value : null
}

/**
 * Get transfer key as Uint8Array bytes.
 * Handles both WIF and legacy hex formats automatically.
 */
export const getTransferKeyBytes = (identityId: string): Uint8Array | null => {
  const value = getTransferKey(identityId)
  if (!value) return null

  try {
    const parsed = parsePrivateKey(value)
    return parsed.privateKey
  } catch {
    return null
  }
}

/**
 * Check if transfer key is stored
 */
export const hasTransferKey = (identityId: string): boolean => {
  return secureStorage.has(`tk_${identityId}`)
}

/**
 * Clear transfer key from storage
 */
export const clearTransferKey = (identityId: string): boolean => {
  return secureStorage.delete(`tk_${identityId}`)
}
