/**
 * Pinata Upload Provider Types
 *
 * Pinata-specific type definitions for the upload provider system.
 */

/**
 * Credentials stored for Pinata connection
 */
export interface PinataCredentials {
  /** Pinata API JWT token */
  jwt: string
  /** Custom gateway domain (optional, e.g., "my-gateway.mypinata.cloud") */
  gateway?: string
}

/**
 * Pinata-specific provider status (simpler than Storacha - no email verification)
 */
export type PinataProviderStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
