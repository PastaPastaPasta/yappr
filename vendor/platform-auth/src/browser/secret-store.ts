'use client'

import type { EncryptionKeyType, NetworkName } from '../core/types'

export interface BrowserSecretStoreCrypto {
  parsePrivateKey(privateKey: string): { privateKey: Uint8Array }
  privateKeyToWif(privateKey: Uint8Array, network: NetworkName, compressed: boolean): string
  isLikelyWif(value: string): boolean
}

export interface BrowserSecretStoreOptions {
  prefix?: string
  network: NetworkName
  crypto: BrowserSecretStoreCrypto
}

export type BrowserStoredKeyType = EncryptionKeyType

class BrowserStorage {
  public constructor(private readonly prefix: string) {}

  private getKeysWithPrefix(storage: Storage): string[] {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(this.prefix)) {
        keys.push(key)
      }
    }
    return keys
  }

  private getStorage(): Storage | null {
    if (typeof window === 'undefined') return null
    return localStorage
  }

  private getLegacyStorage(): Storage | null {
    if (typeof window === 'undefined') return null
    return sessionStorage
  }

  private isAvailable(): boolean {
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

  public set(key: string, value: unknown): void {
    if (!this.isAvailable()) return
    const storage = this.getStorage()
    if (!storage) return
    try {
      storage.setItem(this.prefix + key, JSON.stringify(value))
      this.getLegacyStorage()?.removeItem(this.prefix + key)
    } catch {
      // Keep storage helpers silent; callers handle absence/failure the same way as Yappr did.
    }
  }

  public get(key: string): unknown {
    if (!this.isAvailable()) return null
    try {
      const storage = this.getStorage()
      if (!storage) return null
      const item = storage.getItem(this.prefix + key)
      if (item) return JSON.parse(item)

      const legacyStorage = this.getLegacyStorage()
      const fallback = legacyStorage?.getItem(this.prefix + key)
      if (!fallback) return null

      const parsed = JSON.parse(fallback)
      storage.setItem(this.prefix + key, fallback)
      legacyStorage?.removeItem(this.prefix + key)
      return parsed
    } catch {
      return null
    }
  }

  public has(key: string): boolean {
    if (!this.isAvailable()) return false
    const storage = this.getStorage()
    if (!storage) return false
    if (storage.getItem(this.prefix + key) !== null) return true
    return this.getLegacyStorage()?.getItem(this.prefix + key) !== null
  }

  public delete(key: string): boolean {
    if (!this.isAvailable()) return false
    const existed = this.has(key)
    localStorage.removeItem(this.prefix + key)
    sessionStorage.removeItem(this.prefix + key)
    return existed
  }

  public clear(): void {
    if (!this.isAvailable()) return
    this.getKeysWithPrefix(localStorage).forEach((key) => localStorage.removeItem(key))
    this.getKeysWithPrefix(sessionStorage).forEach((key) => sessionStorage.removeItem(key))
  }

  public keys(): string[] {
    if (!this.isAvailable()) return []

    const allKeys = [
      ...this.getKeysWithPrefix(localStorage),
      ...this.getKeysWithPrefix(sessionStorage),
    ]
    const uniqueKeys = new Set(allKeys.map((key) => key.slice(this.prefix.length)))
    return Array.from(uniqueKeys)
  }

  public size(): number {
    return this.keys().length
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

export function generatePrfInput(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

export function createBrowserSecretStore(options: BrowserSecretStoreOptions) {
  const storage = new BrowserStorage(options.prefix ?? 'platform_auth_secure_')

  const storePrivateKey = (identityId: string, privateKey: string): void => {
    storage.set(`pk_${identityId}`, privateKey)
  }

  const getPrivateKey = (identityId: string): string | null => {
    const value = storage.get(`pk_${identityId}`)
    return typeof value === 'string' ? value : null
  }

  const clearPrivateKey = (identityId: string): boolean => storage.delete(`pk_${identityId}`)

  const hasPrivateKey = (identityId: string): boolean => storage.has(`pk_${identityId}`)

  const clearAllPrivateKeys = (): void => {
    storage.keys().filter((key) => key.startsWith('pk_')).forEach((key) => {
      storage.delete(key)
    })
  }

  const storeLoginKey = (identityId: string, loginKey: Uint8Array): void => {
    storage.set(`lk_${identityId}`, bytesToBase64(loginKey))
  }

  const getLoginKey = (identityId: string): string | null => {
    const value = storage.get(`lk_${identityId}`)
    return typeof value === 'string' ? value : null
  }

  const getLoginKeyBytes = (identityId: string): Uint8Array | null => {
    const value = getLoginKey(identityId)
    return value ? base64ToBytes(value) : null
  }

  const hasLoginKey = (identityId: string): boolean => storage.has(`lk_${identityId}`)

  const clearLoginKey = (identityId: string): boolean => storage.delete(`lk_${identityId}`)

  const storeAuthVaultDek = (identityId: string, dek: Uint8Array): void => {
    storage.set(`avd_${identityId}`, bytesToBase64(dek))
  }

  const getAuthVaultDek = (identityId: string): string | null => {
    const value = storage.get(`avd_${identityId}`)
    return typeof value === 'string' ? value : null
  }

  const getAuthVaultDekBytes = (identityId: string): Uint8Array | null => {
    const value = getAuthVaultDek(identityId)
    return value ? base64ToBytes(value) : null
  }

  const hasAuthVaultDek = (identityId: string): boolean => storage.has(`avd_${identityId}`)

  const clearAuthVaultDek = (identityId: string): boolean => storage.delete(`avd_${identityId}`)

  const storeNormalizedWif = (storageKey: string, privateKey: string): void => {
    if (options.crypto.isLikelyWif(privateKey)) {
      storage.set(storageKey, privateKey)
      return
    }

    const parsed = options.crypto.parsePrivateKey(privateKey)
    const wif = options.crypto.privateKeyToWif(parsed.privateKey, options.network, true)
    storage.set(storageKey, wif)
  }

  const getKeyBytes = (value: string | null): Uint8Array | null => {
    if (!value) return null
    try {
      const parsed = options.crypto.parsePrivateKey(value)
      return parsed.privateKey
    } catch {
      return null
    }
  }

  const storeEncryptionKey = (identityId: string, encryptionKey: string): void => {
    storeNormalizedWif(`ek_${identityId}`, encryptionKey)
  }

  const getEncryptionKey = (identityId: string): string | null => {
    const value = storage.get(`ek_${identityId}`)
    return typeof value === 'string' ? value : null
  }

  const getEncryptionKeyBytes = (identityId: string): Uint8Array | null => getKeyBytes(getEncryptionKey(identityId))

  const hasEncryptionKey = (identityId: string): boolean => storage.has(`ek_${identityId}`)

  const clearEncryptionKey = (identityId: string): boolean => storage.delete(`ek_${identityId}`)

  const storeEncryptionKeyType = (identityId: string, type: BrowserStoredKeyType): void => {
    storage.set(`ek_type_${identityId}`, type)
  }

  const getEncryptionKeyType = (identityId: string): BrowserStoredKeyType | null => {
    const value = storage.get(`ek_type_${identityId}`)
    return value === 'derived' || value === 'external' ? value : null
  }

  const clearEncryptionKeyType = (identityId: string): boolean => storage.delete(`ek_type_${identityId}`)

  const storeTransferKey = (identityId: string, transferKey: string): void => {
    storeNormalizedWif(`tk_${identityId}`, transferKey)
  }

  const getTransferKey = (identityId: string): string | null => {
    const value = storage.get(`tk_${identityId}`)
    return typeof value === 'string' ? value : null
  }

  const getTransferKeyBytes = (identityId: string): Uint8Array | null => getKeyBytes(getTransferKey(identityId))

  const hasTransferKey = (identityId: string): boolean => storage.has(`tk_${identityId}`)

  const clearTransferKey = (identityId: string): boolean => storage.delete(`tk_${identityId}`)

  return {
    secureStorage: storage,
    storePrivateKey,
    getPrivateKey,
    clearPrivateKey,
    hasPrivateKey,
    clearAllPrivateKeys,
    storeLoginKey,
    getLoginKey,
    getLoginKeyBytes,
    hasLoginKey,
    clearLoginKey,
    storeAuthVaultDek,
    getAuthVaultDek,
    getAuthVaultDekBytes,
    hasAuthVaultDek,
    clearAuthVaultDek,
    storeEncryptionKey,
    getEncryptionKey,
    getEncryptionKeyBytes,
    hasEncryptionKey,
    clearEncryptionKey,
    storeEncryptionKeyType,
    getEncryptionKeyType,
    clearEncryptionKeyType,
    storeTransferKey,
    getTransferKey,
    getTransferKeyBytes,
    hasTransferKey,
    clearTransferKey,
  }
}
