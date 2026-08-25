'use client'

import {
  createBrowserSecretStore,
  type BrowserStoredKeyType,
} from 'platform-auth'
import { isLikelyWif, parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'

const getConfiguredNetwork = (): 'testnet' | 'mainnet' => {
  if (process?.env?.NEXT_PUBLIC_NETWORK) {
    return process.env.NEXT_PUBLIC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  }
  return 'testnet'
}

const browserSecretStore = createBrowserSecretStore({
  prefix: 'yappr_secure_',
  network: getConfiguredNetwork(),
  crypto: {
    parsePrivateKey,
    privateKeyToWif,
    isLikelyWif,
  },
})

export type KeyType = BrowserStoredKeyType

export default browserSecretStore.secureStorage

export const {
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
} = browserSecretStore
