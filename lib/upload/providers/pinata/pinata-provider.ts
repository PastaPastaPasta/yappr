'use client'

import { logger } from '@/lib/logger';
/**
 * Pinata Upload Provider
 *
 * Implementation of UploadProvider for Pinata IPFS pinning service.
 * Unlike Storacha, Pinata uses API key (JWT) authentication - no email verification needed.
 */

import type { UploadProvider, ProviderStatus, UploadOptions, UploadResult } from '../../types'
import type { PinataCredentials } from './types'
import { UploadException, UploadErrorCode } from '../../errors'
import {
  storePinataCredentials,
  getPinataCredentials,
  clearPinataCredentials,
  hasPinataCredentials,
} from './credential-storage'

// Re-export for convenience
export type { PinataCredentials }

// Pinata SDK type (dynamically imported)
type PinataSDKType = InstanceType<typeof import('pinata').PinataSDK>

/**
 * Pinata upload provider implementation
 */
export class PinataProvider implements UploadProvider {
  readonly name = 'Pinata'

  private client: PinataSDKType | null = null
  private status: ProviderStatus = 'disconnected'
  private identityId: string | null = null
  private connectedJwt: string | null = null
  private connectedGateway: string | null = null

  /**
   * Set the identity ID for credential storage
   */
  setIdentityId(identityId: string): void {
    this.identityId = identityId
  }

  /**
   * Get the connected gateway domain
   */
  getConnectedGateway(): string | null {
    return this.connectedGateway
  }

  /**
   * Get masked JWT for display (shows first 4 and last 4 chars)
   */
  getMaskedJwt(): string | null {
    if (!this.connectedJwt) return null
    if (this.connectedJwt.length <= 12) return '****'
    return `${this.connectedJwt.slice(0, 4)}...${this.connectedJwt.slice(-4)}`
  }

  /**
   * Setup with API key - validates and stores credentials
   */
  async setupWithApiKey(jwt: string, gateway?: string): Promise<void> {
    if (!this.identityId) {
      throw new UploadException(UploadErrorCode.CREDENTIAL_ERROR, 'Identity ID not set')
    }

    this.status = 'connecting'

    try {
      // Dynamically import to avoid SSR issues
      const { PinataSDK } = await import('pinata')

      // Create client with provided credentials
      this.client = new PinataSDK({
        pinataJwt: jwt,
        pinataGateway: gateway,
      })

      // Validate credentials by testing the connection
      logger.info('[Pinata] Testing connection...')
      try {
        await this.client.testAuthentication()
        logger.info('[Pinata] Authentication successful')
      } catch (error) {
        logger.error('[Pinata] Authentication failed:', error)
        throw new UploadException(
          UploadErrorCode.CREDENTIAL_ERROR,
          'Invalid API key. Please check your JWT and try again.',
          error instanceof Error ? error : undefined
        )
      }

      // Store credentials
      const credentials: PinataCredentials = { jwt, gateway }
      storePinataCredentials(this.identityId, credentials)

      this.connectedJwt = jwt
      this.connectedGateway = gateway || null
      this.status = 'connected'
      logger.info('[Pinata] Setup complete, status:', this.status)
    } catch (error) {
      this.status = 'error'
      this.client = null
      if (error instanceof UploadException) {
        throw error
      }
      throw new UploadException(
        UploadErrorCode.CONNECTION_FAILED,
        'Failed to connect to Pinata',
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Connect using stored credentials
   */
  async connect(): Promise<void> {
    if (!this.identityId) {
      throw new UploadException(UploadErrorCode.CREDENTIAL_ERROR, 'Identity ID not set')
    }

    // Check for stored credentials
    const credentials = getPinataCredentials(this.identityId)
    if (!credentials) {
      throw new UploadException(UploadErrorCode.NOT_CONNECTED, 'No stored credentials found')
    }

    this.status = 'connecting'

    try {
      await this.restoreFromCredentials(credentials)
      this.connectedJwt = credentials.jwt
      this.connectedGateway = credentials.gateway || null
      this.status = 'connected'
    } catch (error) {
      this.status = 'error'
      this.client = null
      throw new UploadException(
        UploadErrorCode.CONNECTION_FAILED,
        'Failed to restore connection',
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Restore client from credentials
   */
  private async restoreFromCredentials(credentials: PinataCredentials): Promise<void> {
    const { PinataSDK } = await import('pinata')

    this.client = new PinataSDK({
      pinataJwt: credentials.jwt,
      pinataGateway: credentials.gateway,
    })

    // Verify credentials are still valid
    try {
      await this.client.testAuthentication()
    } catch (error) {
      throw new UploadException(
        UploadErrorCode.CREDENTIAL_ERROR,
        'Stored API key is no longer valid',
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Disconnect from the provider
   */
  async disconnect(clearCredentials = true): Promise<void> {
    this.client = null
    this.connectedJwt = null
    this.connectedGateway = null
    this.status = 'disconnected'

    if (clearCredentials && this.identityId) {
      clearPinataCredentials(this.identityId)
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.status === 'connected' && this.client !== null
  }

  /**
   * Get current status
   */
  getStatus(): ProviderStatus {
    return this.status
  }

  /**
   * Check if credentials exist for the current identity
   */
  hasStoredCredentials(): boolean {
    if (!this.identityId) return false
    return hasPinataCredentials(this.identityId)
  }

  /**
   * Get stored credentials (for backup purposes)
   */
  getCredentials(): PinataCredentials | null {
    if (!this.identityId) return null
    return getPinataCredentials(this.identityId)
  }

  /**
   * Upload an image file
   */
  async uploadImage(file: File, options?: UploadOptions): Promise<UploadResult> {
    if (!this.client || this.status !== 'connected') {
      throw new UploadException(UploadErrorCode.NOT_CONNECTED, 'Not connected to Pinata')
    }

    // Validate file type
    if (!file.type.startsWith('image/')) {
      throw new UploadException(UploadErrorCode.INVALID_FILE, 'Only image files are supported')
    }

    // Validate file size (15MB limit for safety, well under Pinata's limits)
    const MAX_SIZE = 15 * 1024 * 1024
    if (file.size > MAX_SIZE) {
      throw new UploadException(UploadErrorCode.INVALID_FILE, 'Image must be under 15MB')
    }

    try {
      // Report initial progress
      options?.onProgress?.(0)

      // Upload the file using public upload
      logger.info('[Pinata] Uploading file:', file.name, file.size)
      options?.onProgress?.(25)

      const result = await this.client.upload.public.file(file)

      // Report completion
      options?.onProgress?.(100)

      logger.info('[Pinata] Upload complete:', result.cid)

      return {
        cid: result.cid,
        size: file.size,
        mime: file.type,
        url: `ipfs://${result.cid}`
      }
    } catch (error) {
      logger.error('[Pinata] Upload error:', error)

      const errorMsg = error instanceof Error ? error.message : String(error)

      // Check for permission errors (403)
      if (errorMsg.includes('403') || errorMsg.includes('Forbidden') || errorMsg.includes('permission')) {
        throw new UploadException(
          UploadErrorCode.CREDENTIAL_ERROR,
          'Permission denied. Make sure your API key has "Files: Write" permission enabled.'
        )
      }

      // Check for quota/rate limit errors
      if (errorMsg.includes('quota') || errorMsg.includes('limit') || errorMsg.includes('429')) {
        throw new UploadException(UploadErrorCode.QUOTA_EXCEEDED, 'Rate limit or quota exceeded. Please try again later.')
      }

      throw new UploadException(
        UploadErrorCode.STORAGE_ERROR,
        'Failed to upload file',
        error instanceof Error ? error : undefined
      )
    }
  }
}

// Singleton instance
let pinataProviderInstance: PinataProvider | null = null

/**
 * Get the Pinata provider singleton
 */
export function getPinataProvider(): PinataProvider {
  if (!pinataProviderInstance) {
    pinataProviderInstance = new PinataProvider()
  }
  return pinataProviderInstance
}
