/**
 * Upload Provider System Types
 *
 * Provider-agnostic interfaces for file upload functionality.
 * Designed to support multiple storage backends (Storacha, etc.)
 */

/**
 * Status of an upload provider connection
 */
export type ProviderStatus =
  | 'disconnected'
  | 'connecting'
  | 'verification_pending'
  | 'awaiting_plan'
  | 'connected'
  | 'error'

/**
 * Options for uploading an image
 */
export interface UploadOptions {
  /** Optional callback for upload progress (0-100) */
  onProgress?: (progress: number) => void
}

/**
 * Result of a successful upload
 */
export interface UploadResult {
  /** Content Identifier for the uploaded file */
  cid: string
  /** Size of the uploaded file in bytes */
  size?: number
  /** MIME type of the uploaded file */
  mime?: string
  /** URL to access the file (HTTPS gateway URL for contract compatibility) */
  url: string
}

/**
 * Provider interface that all upload providers must implement
 */
export interface UploadProvider {
  /** Human-readable name of the provider */
  readonly name: string

  /**
   * Connect to the provider using stored credentials.
   * For fresh connections, use provider-specific methods like setupWithEmail.
   */
  connect(): Promise<void>

  /**
   * Disconnect from the provider and optionally clear credentials.
   * @param clearCredentials If true, removes stored credentials
   */
  disconnect(clearCredentials?: boolean): Promise<void>

  /**
   * Check if the provider is currently connected and ready for uploads.
   */
  isConnected(): boolean

  /**
   * Get the current connection status.
   */
  getStatus(): ProviderStatus

  /**
   * Upload an image file to the provider.
   * @param file The image file to upload
   * @param options Optional upload configuration
   * @returns Promise resolving to upload result with CID and URL
   */
  uploadImage(file: File, options?: UploadOptions): Promise<UploadResult>
}

/**
 * Storacha-specific credentials for backup/restore
 */
export interface StorachaCredentials {
  /** Email address used to authenticate */
  email: string
  /** Base64-encoded serialized agent data */
  agentData: string
  /** Space DID used for uploads */
  spaceDid: string
}

/**
 * Extended backup data structure that includes Storacha credentials
 */
export interface ExtendedBackupData {
  /** Backup format version */
  version: 2
  /** The encrypted login key (from v1) */
  loginKey: string
  /** Optional Storacha credentials */
  storachaCredentials?: StorachaCredentials
}
