'use client'

/**
 * Secure in-memory storage for sensitive data like private keys
 * This avoids storing sensitive data in localStorage/sessionStorage
 * Keys persist until page unload/close
 */
class SecureStorage {
  private storage: Map<string, any> = new Map()

  /**
   * Store a value securely in memory
   */
  set(key: string, value: any): void {
    this.storage.set(key, value)
  }

  /**
   * Get a value from secure storage
   */
  get(key: string): any {
    return this.storage.get(key)
  }

  /**
   * Check if a key exists
   */
  has(key: string): boolean {
    return this.storage.has(key)
  }

  /**
   * Delete a value from secure storage
   */
  delete(key: string): boolean {
    return this.storage.delete(key)
  }

  /**
   * Clear all stored values
   */
  clear(): void {
    this.storage.clear()
  }

  /**
   * Get all keys (for debugging - should not expose actual values)
   */
  keys(): string[] {
    return Array.from(this.storage.keys())
  }

  /**
   * Get storage size
   */
  size(): number {
    return this.storage.size
  }
}

// Singleton instance
const secureStorage = new SecureStorage()

// Clean up on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    secureStorage.clear()
  })

  // Also clean up on page hide (mobile support)
  window.addEventListener('pagehide', () => {
    secureStorage.clear()
  })
}

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
