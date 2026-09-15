/**
 * Upload Module
 *
 * Provides a provider-agnostic upload system for Yappr.
 * Supports Storacha and Pinata as IPFS upload backends.
 */

export * from './types'
export * from './errors'
// getLocalImageUrl is deliberately not re-exported: its consumers are display
// components, which import ./local-image-cache directly to avoid pulling the
// provider SDKs in through this barrel.
export { cacheLocalImage } from './local-image-cache'

// Storacha provider
export { getStorachaProvider } from './providers/storacha/storacha-provider'
export type { StorachaCredentials } from './providers/storacha/storacha-provider'

// Pinata provider
export { getPinataProvider } from './providers/pinata/pinata-provider'
export type { PinataCredentials } from './providers/pinata/pinata-provider'
