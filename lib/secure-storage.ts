'use client'

import {
  createBrowserSecretStore,
  type BrowserStoredKeyType,
} from 'platform-auth'
import { isLikelyWif, parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'
import { scopedKey } from '@/lib/storage-scope'
import { keyNetwork } from '@/lib/constants'

const browserSecretStore = createBrowserSecretStore({
  prefix: scopedKey('yappr_secure_'),
  // Stored secrets are WIF-encoded, so this follows the key network: devnet reuses testnet's prefixes.
  network: keyNetwork(),
  crypto: {
    parsePrivateKey,
    privateKeyToWif,
    isLikelyWif,
  },
})

export type KeyType = BrowserStoredKeyType

export const {
  storePrivateKey,
  getPrivateKey,
  clearPrivateKey,
  hasPrivateKey,
  storeLoginKey,
  getLoginKeyBytes,
  clearLoginKey,
  storeAuthVaultDek,
  getAuthVaultDekBytes,
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
  hasTransferKey,
  clearTransferKey,
} = browserSecretStore
