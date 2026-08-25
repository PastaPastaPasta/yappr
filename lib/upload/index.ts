/**
 * Upload Module
 *
 * Provides a provider-agnostic upload system for Yappr.
 * Supports Storacha and Pinata as IPFS upload backends.
 */

export * from './types'
export * from './errors'
export { providerRegistry } from './provider-registry'

// Storacha provider
export { getStorachaProvider, StorachaProvider } from './providers/storacha/storacha-provider'
export type { StorachaCredentials } from './providers/storacha/storacha-provider'
export {
  hasStorachaCredentials,
  getStorachaCredentials,
  clearStorachaCredentials,
} from './providers/storacha/credential-storage'

// Pinata provider
export { getPinataProvider, PinataProvider } from './providers/pinata/pinata-provider'
export type { PinataCredentials } from './providers/pinata/pinata-provider'
export {
  hasPinataCredentials,
  getPinataCredentials,
  clearPinataCredentials,
} from './providers/pinata/credential-storage'
