'use client'

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
