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

/** What removing a secret found, and whether it is now gone from every storage area. */
export interface SecretRemoval {
  existed: boolean
  /** False when a copy is still there: the browser refused to remove it. */
  complete: boolean
}

function mergeRemovals(removals: SecretRemoval[]): SecretRemoval {
  return {
    existed: removals.some((removal) => removal.existed),
    complete: removals.every((removal) => removal.complete),
  }
}

/**
 * Secrets live in localStorage; sessionStorage holds copies an earlier version
 * kept there. Every operation reaches each area on its own: a full or
 * read-only store still reads, lists and removes what it holds, so a failed
 * write never stops a secret from being removed.
 */
class BrowserStorage {
  public constructor(private readonly prefix: string) {}

  /** The storage area, or null where there is none or the browser blocks it. */
  private static area(kind: 'local' | 'session'): Storage | null {
    if (typeof window === 'undefined') return null
    try {
      return kind === 'local' ? localStorage : sessionStorage
    } catch {
      return null
    }
  }

  private static read(storage: Storage | null, name: string): string | null {
    try {
      return storage?.getItem(name) ?? null
    } catch {
      return null
    }
  }

  /** Writes `value` and reads it back: true only once the area holds it. */
  private static write(storage: Storage | null, name: string, value: string): boolean {
    if (!storage) return false
    try {
      storage.setItem(name, value)
    } catch {
      return false
    }
    return BrowserStorage.read(storage, name) === value
  }

  private static remove(storage: Storage | null, name: string): SecretRemoval {
    if (!storage) return { existed: false, complete: true }
    const existed = BrowserStorage.read(storage, name) !== null
    try {
      storage.removeItem(name)
    } catch {
      // Checked below.
    }
    try {
      return { existed, complete: storage.getItem(name) === null }
    } catch {
      // Unreadable afterwards: nothing confirms the copy is gone.
      return { existed, complete: false }
    }
  }

  private namesWithPrefix(storage: Storage | null): string[] {
    const names: string[] = []
    if (!storage) return names
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const name = storage.key(index)
        if (name?.startsWith(this.prefix)) names.push(name)
      }
    } catch {
      // Unreadable: nothing in it can be listed.
    }
    return names
  }

  /** Throws when the browser does not keep the value, so no caller goes on believing it saved. */
  public set(key: string, value: unknown): void {
    const name = this.prefix + key
    if (!BrowserStorage.write(BrowserStorage.area('local'), name, JSON.stringify(value))) {
      throw new Error('This browser could not save your key')
    }
    // The saved value now outranks any older copy, which only has to go.
    BrowserStorage.remove(BrowserStorage.area('session'), name)
  }

  public get(key: string): unknown {
    const name = this.prefix + key
    const storage = BrowserStorage.area('local')
    const item = BrowserStorage.read(storage, name)
    if (item) return parseStored(item)

    const legacyStorage = BrowserStorage.area('session')
    const fallback = BrowserStorage.read(legacyStorage, name)
    if (!fallback) return null
    const parsed = parseStored(fallback)
    // Moved to localStorage; the old copy goes only once the new one reads back, so a failed write loses nothing.
    if (parsed !== null && BrowserStorage.write(storage, name, fallback)) BrowserStorage.remove(legacyStorage, name)
    return parsed
  }

  public has(key: string): boolean {
    const name = this.prefix + key
    return BrowserStorage.read(BrowserStorage.area('local'), name) !== null
      || BrowserStorage.read(BrowserStorage.area('session'), name) !== null
  }

  public delete(key: string): SecretRemoval {
    const name = this.prefix + key
    return mergeRemovals([
      BrowserStorage.remove(BrowserStorage.area('local'), name),
      BrowserStorage.remove(BrowserStorage.area('session'), name),
    ])
  }

  public clear(): SecretRemoval {
    return mergeRemovals(this.keys().map((key) => this.delete(key)))
  }

  public keys(): string[] {
    const allNames = [
      ...this.namesWithPrefix(BrowserStorage.area('local')),
      ...this.namesWithPrefix(BrowserStorage.area('session')),
    ]
    return Array.from(new Set(allNames.map((name) => name.slice(this.prefix.length))))
  }

  public size(): number {
    return this.keys().length
  }
}

function parseStored(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
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

export function createBrowserSecretStore(options: BrowserSecretStoreOptions) {
  const storage = new BrowserStorage(options.prefix ?? 'platform_auth_secure_')

  const storePrivateKey = (identityId: string, privateKey: string): void => {
    storage.set(`pk_${identityId}`, privateKey)
  }

  const getPrivateKey = (identityId: string): string | null => {
    const value = storage.get(`pk_${identityId}`)
    return typeof value === 'string' ? value : null
  }

  const clearPrivateKey = (identityId: string): SecretRemoval => storage.delete(`pk_${identityId}`)

  const hasPrivateKey = (identityId: string): boolean => storage.has(`pk_${identityId}`)

  const clearAllPrivateKeys = (): SecretRemoval =>
    mergeRemovals(storage.keys().filter((key) => key.startsWith('pk_')).map((key) => storage.delete(key)))

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

  const clearLoginKey = (identityId: string): SecretRemoval => storage.delete(`lk_${identityId}`)

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

  const clearEncryptionKey = (identityId: string): SecretRemoval => storage.delete(`ek_${identityId}`)

  const storeEncryptionKeyType = (identityId: string, type: BrowserStoredKeyType): void => {
    storage.set(`ek_type_${identityId}`, type)
  }

  const getEncryptionKeyType = (identityId: string): BrowserStoredKeyType | null => {
    const value = storage.get(`ek_type_${identityId}`)
    return value === 'derived' || value === 'external' ? value : null
  }

  const clearEncryptionKeyType = (identityId: string): SecretRemoval => storage.delete(`ek_type_${identityId}`)

  const storeTransferKey = (identityId: string, transferKey: string): void => {
    storeNormalizedWif(`tk_${identityId}`, transferKey)
  }

  const getTransferKey = (identityId: string): string | null => {
    const value = storage.get(`tk_${identityId}`)
    return typeof value === 'string' ? value : null
  }

  const getTransferKeyBytes = (identityId: string): Uint8Array | null => getKeyBytes(getTransferKey(identityId))

  const hasTransferKey = (identityId: string): boolean => storage.has(`tk_${identityId}`)

  const clearTransferKey = (identityId: string): SecretRemoval => storage.delete(`tk_${identityId}`)

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
