'use client'

/**
 * Storacha Upload Provider
 *
 * Implementation of UploadProvider for Storacha (formerly web3.storage).
 * Handles email-based authentication, space management, and IPFS uploads.
 */

import type { UploadProvider, ProviderStatus, UploadOptions, UploadResult, StorachaCredentials } from '../../types'
import { UploadException, UploadErrorCode } from '../../errors'
import {
  storeStorachaCredentials,
  getStorachaCredentials,
  clearStorachaCredentials,
  hasStorachaCredentials,
} from './credential-storage'

// Re-export for convenience
export type { StorachaCredentials }

// Storacha client types (dynamically imported)
type StorachaClient = Awaited<ReturnType<typeof import('@storacha/client').create>>
type Account = Awaited<ReturnType<StorachaClient['login']>>
type AgentDataExport = Parameters<typeof import('@storacha/access/agent').AgentData.fromExport>[0]

const SPACE_NAME = 'yappr-uploads'
const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Custom JSON replacer for Storacha data types
 * Matches the format used by @storacha/access/utils/json.js
 */
function jsonReplacer(_k: string, v: unknown): unknown {
  if (v instanceof URL) {
    return { $url: v.toString() }
  } else if (v instanceof Map) {
    return { $map: Array.from(v.entries()) }
  } else if (v instanceof Uint8Array) {
    return { $bytes: Array.from(v) }
  } else if (v instanceof ArrayBuffer) {
    return { $bytes: Array.from(new Uint8Array(v)) }
  } else if (v && typeof v === 'object' && 'type' in v && v.type === 'Buffer' && 'data' in v && Array.isArray(v.data)) {
    return { $bytes: v.data }
  }
  return v
}

/**
 * Custom JSON reviver for Storacha data types
 * Matches the format used by @storacha/access/utils/json.js
 */
function jsonReviver(_k: string, v: unknown): unknown {
  if (!v || typeof v !== 'object') return v
  const obj = v as Record<string, unknown>
  if ('$url' in obj && typeof obj.$url === 'string') return new URL(obj.$url)
  if ('$map' in obj && Array.isArray(obj.$map)) return new Map(obj.$map)
  if ('$bytes' in obj && Array.isArray(obj.$bytes)) return new Uint8Array(obj.$bytes)
  return v
}

/**
 * Custom store driver that captures AgentDataExport for credential storage
 */
class InMemoryStore {
  private data: AgentDataExport | undefined = undefined

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async reset(): Promise<void> {
    this.data = undefined
  }

  async save(data: AgentDataExport): Promise<void> {
    this.data = data
  }

  async load(): Promise<AgentDataExport | undefined> {
    return this.data
  }

  getData(): AgentDataExport | undefined {
    return this.data
  }

  setData(data: AgentDataExport): void {
    this.data = data
  }
}

/**
 * Storacha upload provider implementation
 */
export class StorachaProvider implements UploadProvider {
  readonly name = 'Storacha'

  private client: StorachaClient | null = null
  private store: InMemoryStore | null = null
  private status: ProviderStatus = 'disconnected'
  private identityId: string | null = null
  private connectedEmail: string | null = null

  /**
   * Set the identity ID for credential storage
   */
  setIdentityId(identityId: string): void {
    this.identityId = identityId
  }

  /**
   * Get the connected email
   */
  getConnectedEmail(): string | null {
    return this.connectedEmail
  }

  /**
   * Get the space DID if connected
   */
  getSpaceDid(): string | null {
    if (!this.client || this.status !== 'connected') {
      return null
    }
    return this.client.currentSpace()?.did() ?? null
  }

  /**
   * Setup with email - full flow including verification
   * Returns when the user has clicked the verification link
   */
  async setupWithEmail(email: string, signal?: AbortSignal): Promise<void> {
    if (!this.identityId) {
      throw new UploadException(UploadErrorCode.CREDENTIAL_ERROR, 'Identity ID not set')
    }

    this.status = 'connecting'

    try {
      // Dynamically import to avoid SSR issues
      const { create } = await import('@storacha/client')
      const { generate } = await import('@ucanto/principal/ed25519')

      // Create a custom store to capture agent data for export
      this.store = new InMemoryStore()

      // Generate Ed25519 key instead of default RSA
      // Ed25519 keys are extractable and can be serialized, unlike browser RSA keys
      const principal = await generate()

      // Create a new client with our custom store and Ed25519 principal
      this.client = await create({ store: this.store, principal })

      this.status = 'verification_pending'

      // Login with email - this sends verification email and waits for click
      let account: Account
      try {
        console.log('[Storacha] Starting login for:', email)
        account = await Promise.race([
          this.client.login(email as `${string}@${string}`, { signal }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new UploadException(UploadErrorCode.VERIFICATION_TIMEOUT, 'Email verification timed out')),
              VERIFICATION_TIMEOUT_MS
            )
          )
        ])
        console.log('[Storacha] Login completed successfully')
      } catch (error) {
        console.error('[Storacha] Login error:', error)
        console.error('[Storacha] Error type:', typeof error)
        console.error('[Storacha] Error constructor:', error?.constructor?.name)
        if (error instanceof UploadException) {
          throw error
        }
        const errorMessage = error instanceof Error ? error.message : String(error)
        throw new UploadException(
          UploadErrorCode.VERIFICATION_FAILED,
          `Email verification failed: ${errorMessage}`,
          error instanceof Error ? error : undefined
        )
      }

      // Wait for plan - user needs to select a plan on console.storacha.network
      console.log('[Storacha] Waiting for plan selection...')
      this.status = 'awaiting_plan'
      try {
        await account.plan.wait()
        console.log('[Storacha] Plan confirmed')
      } catch (error) {
        console.warn('[Storacha] Plan wait failed:', error)
        throw new UploadException(
          UploadErrorCode.CONNECTION_FAILED,
          'Failed to confirm plan. Please select a plan at console.storacha.network',
          error instanceof Error ? error : undefined
        )
      }

      // Check for existing spaces or create new one
      console.log('[Storacha] Checking for existing spaces...')
      const spaces = this.client.spaces()
      console.log('[Storacha] Found spaces:', spaces.length)
      const space = spaces.find(s => s.name === SPACE_NAME)
      let spaceDid: `did:key:${string}`

      if (!space) {
        try {
          // Create a new space associated with the account
          const ownedSpace = await this.client.createSpace(SPACE_NAME, { account })
          spaceDid = ownedSpace.did()
        } catch (error) {
          throw new UploadException(
            UploadErrorCode.SPACE_CREATION_FAILED,
            'Failed to create upload space',
            error instanceof Error ? error : undefined
          )
        }
      } else {
        spaceDid = space.did()
      }

      // Set as current space
      console.log('[Storacha] Setting current space:', spaceDid)
      await this.client.setCurrentSpace(spaceDid)

      // Export and store credentials
      console.log('[Storacha] Saving credentials...')
      await this.saveCredentials(email, spaceDid)
      console.log('[Storacha] Credentials saved')

      this.connectedEmail = email
      this.status = 'connected'
      console.log('[Storacha] Setup complete, status:', this.status)
    } catch (error) {
      this.status = 'error'
      this.client = null
      if (error instanceof UploadException) {
        throw error
      }
      throw new UploadException(
        UploadErrorCode.CONNECTION_FAILED,
        'Failed to connect to Storacha',
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
    const credentials = getStorachaCredentials(this.identityId)
    if (!credentials) {
      throw new UploadException(UploadErrorCode.NOT_CONNECTED, 'No stored credentials found')
    }

    this.status = 'connecting'

    try {
      await this.restoreFromCredentials(credentials)
      this.connectedEmail = credentials.email
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
  private async restoreFromCredentials(credentials: StorachaCredentials): Promise<void> {
    const { create } = await import('@storacha/client')

    // Parse the stored agent data using custom reviver that handles Map, Uint8Array, etc.
    const exportedData = JSON.parse(atob(credentials.agentData), jsonReviver) as AgentDataExport

    // Create a store pre-loaded with the exported data
    this.store = new InMemoryStore()
    this.store.setData(exportedData)

    // Create client with the store containing our saved data
    this.client = await create({ store: this.store })

    // Set the current space
    await this.client.setCurrentSpace(credentials.spaceDid as `did:key:${string}`)
  }

  /**
   * Save credentials for later restoration
   */
  private async saveCredentials(email: string, spaceDid: string): Promise<void> {
    if (!this.identityId || !this.client || !this.store) {
      throw new UploadException(UploadErrorCode.CREDENTIAL_ERROR, 'Cannot save credentials without client')
    }

    // Get exported agent data from our store
    try {
      const exported = this.store.getData()
      if (!exported) {
        throw new Error('No agent data available in store')
      }

      // Use custom JSON serialization that handles Map, Uint8Array, ArrayBuffer, URL
      // This matches the format used by @storacha/access internally
      const jsonStr = JSON.stringify(exported, jsonReplacer)
      const agentDataB64 = btoa(jsonStr)

      console.log('[Storacha] Credential sizes:', {
        jsonLength: jsonStr.length,
        base64Length: agentDataB64.length,
        delegationsCount: Array.isArray(exported.delegations)
          ? exported.delegations.length
          : exported.delegations instanceof Map
            ? exported.delegations.size
            : 0
      })

      const credentials: StorachaCredentials = {
        email,
        agentData: agentDataB64,
        spaceDid,
      }

      storeStorachaCredentials(this.identityId, credentials)
    } catch (error) {
      throw new UploadException(
        UploadErrorCode.CREDENTIAL_ERROR,
        'Failed to export authentication data',
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Disconnect from the provider
   */
  async disconnect(clearCredentials = true): Promise<void> {
    this.client = null
    this.store = null
    this.connectedEmail = null
    this.status = 'disconnected'

    if (clearCredentials && this.identityId) {
      clearStorachaCredentials(this.identityId)
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
    return hasStorachaCredentials(this.identityId)
  }

  /**
   * Get stored credentials (for backup purposes)
   */
  getCredentials(): StorachaCredentials | null {
    if (!this.identityId) return null
    return getStorachaCredentials(this.identityId)
  }

  /**
   * Restore from backup credentials (without email verification)
   */
  async restoreFromBackup(credentials: StorachaCredentials): Promise<void> {
    if (!this.identityId) {
      throw new UploadException(UploadErrorCode.CREDENTIAL_ERROR, 'Identity ID not set')
    }

    this.status = 'connecting'

    try {
      await this.restoreFromCredentials(credentials)

      // Save to local storage
      storeStorachaCredentials(this.identityId, credentials)

      this.connectedEmail = credentials.email
      this.status = 'connected'
    } catch (error) {
      this.status = 'error'
      this.client = null
      throw new UploadException(
        UploadErrorCode.CONNECTION_FAILED,
        'Failed to restore from backup',
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Upload an image file
   */
  async uploadImage(file: File, options?: UploadOptions): Promise<UploadResult> {
    if (!this.client || this.status !== 'connected') {
      throw new UploadException(UploadErrorCode.NOT_CONNECTED, 'Not connected to Storacha')
    }

    // Validate file type
    if (!file.type.startsWith('image/')) {
      throw new UploadException(UploadErrorCode.INVALID_FILE, 'Only image files are supported')
    }

    // Validate file size (10MB limit)
    const MAX_SIZE = 10 * 1024 * 1024
    if (file.size > MAX_SIZE) {
      throw new UploadException(UploadErrorCode.INVALID_FILE, 'Image must be under 10MB')
    }

    try {
      // Report initial progress
      options?.onProgress?.(0)

      // Upload the file
      const cid = await this.client.uploadFile(file, {
        onShardStored: (meta) => {
          // Approximate progress based on shards
          // This is a rough estimate since we don't know total shards upfront
          console.log('Shard stored:', meta.cid.toString())
          options?.onProgress?.(50)
        }
      })

      // Report completion
      options?.onProgress?.(100)

      const cidString = cid.toString()
      return {
        cid: cidString,
        size: file.size,
        mime: file.type,
        url: `ipfs://${cidString}`
      }
    } catch (error) {
      // Check for quota errors
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('quota') || errorMsg.includes('limit')) {
        throw new UploadException(UploadErrorCode.QUOTA_EXCEEDED, 'Storage quota exceeded')
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
let storachaProviderInstance: StorachaProvider | null = null

/**
 * Get the Storacha provider singleton
 */
export function getStorachaProvider(): StorachaProvider {
  if (!storachaProviderInstance) {
    storachaProviderInstance = new StorachaProvider()
  }
  return storachaProviderInstance
}
