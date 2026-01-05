'use client'

/**
 * Secure storage for sensitive data like private keys using sessionStorage
 * - Survives page reloads within the same tab
 * - Automatically cleared when tab/browser is closed
 * - Isolated per tab (other tabs cannot access)
 */
class SecureStorage {
  private prefix = 'yappr_secure_'

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
   * Store a value securely
   */
  set(key: string, value: any): void {
    if (!this.isAvailable()) return
    try {
      sessionStorage.setItem(this.prefix + key, JSON.stringify(value))
    } catch (e) {
      console.error('SecureStorage: Failed to store value:', e)
    }
  }

  /**
   * Get a value from secure storage
   */
  get(key: string): any {
    if (!this.isAvailable()) return null
    try {
      const item = sessionStorage.getItem(this.prefix + key)
      return item ? JSON.parse(item) : null
    } catch {
      return null
    }
  }

  /**
   * Check if a key exists
   */
  has(key: string): boolean {
    if (!this.isAvailable()) return false
    return sessionStorage.getItem(this.prefix + key) !== null
  }

  /**
   * Delete a value from secure storage
   */
  delete(key: string): boolean {
    if (!this.isAvailable()) return false
    const existed = this.has(key)
    sessionStorage.removeItem(this.prefix + key)
    return existed
  }

  /**
   * Clear all stored values with our prefix
   */
  clear(): void {
    if (!this.isAvailable()) return
    const keysToRemove: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(this.prefix)) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => sessionStorage.removeItem(key))
  }

  /**
   * Get all keys (for debugging - should not expose actual values)
   */
  keys(): string[] {
    if (!this.isAvailable()) return []
    const keys: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(this.prefix)) {
        keys.push(key.slice(this.prefix.length))
      }
    }
    return keys
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
  return secureStorage.get(`pk_${identityId}`) || null
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
