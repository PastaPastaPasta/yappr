/**
 * Upload Error Handling
 *
 * Error types and utilities for the upload system.
 */

/**
 * Types of errors that can occur during upload operations
 */
export enum UploadErrorCode {
  /** No provider is connected */
  NOT_CONNECTED = 'NOT_CONNECTED',
  /** Provider connection failed */
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  /** Email verification failed or timed out */
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
  /** Email verification timed out */
  VERIFICATION_TIMEOUT = 'VERIFICATION_TIMEOUT',
  /** Upload failed due to network issues */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** Upload failed due to storage issues */
  STORAGE_ERROR = 'STORAGE_ERROR',
  /** File validation failed (type, size, etc.) */
  INVALID_FILE = 'INVALID_FILE',
  /** Storage quota exceeded */
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  /** Space creation failed */
  SPACE_CREATION_FAILED = 'SPACE_CREATION_FAILED',
  /** Credential storage/retrieval failed */
  CREDENTIAL_ERROR = 'CREDENTIAL_ERROR',
  /** Unknown error */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Custom error class for upload operations
 */
export class UploadException extends Error {
  public readonly code: UploadErrorCode
  public readonly cause?: Error

  constructor(code: UploadErrorCode, message: string, cause?: Error) {
    super(message)
    this.name = 'UploadException'
    this.code = code
    this.cause = cause
    // Maintain proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, UploadException)
    }
  }

  /**
   * Check if the error is retryable
   */
  isRetryable(): boolean {
    return [
      UploadErrorCode.NETWORK_ERROR,
      UploadErrorCode.VERIFICATION_TIMEOUT,
    ].includes(this.code)
  }

  /**
   * Get a user-friendly error message
   */
  getUserMessage(): string {
    switch (this.code) {
      case UploadErrorCode.NOT_CONNECTED:
        return 'Please connect a storage provider in Settings first'
      case UploadErrorCode.CONNECTION_FAILED:
        return 'Failed to connect to storage provider'
      case UploadErrorCode.VERIFICATION_FAILED:
        return 'Email verification failed. Please try again.'
      case UploadErrorCode.VERIFICATION_TIMEOUT:
        return 'Email verification timed out. Please check your inbox and try again.'
      case UploadErrorCode.NETWORK_ERROR:
        return 'Network error during upload. Please check your connection and try again.'
      case UploadErrorCode.STORAGE_ERROR:
        return 'Storage error during upload. Please try again.'
      case UploadErrorCode.INVALID_FILE:
        return this.message || 'Invalid file. Please check file type and size.'
      case UploadErrorCode.QUOTA_EXCEEDED:
        return 'Storage quota exceeded. Please upgrade your plan or delete some files.'
      case UploadErrorCode.SPACE_CREATION_FAILED:
        return 'Failed to create storage space. Please try again.'
      case UploadErrorCode.CREDENTIAL_ERROR:
        return 'Failed to save connection credentials. Please try again.'
      default:
        return this.message || 'An unexpected error occurred'
    }
  }
}

/**
 * Type guard to check if an error is an UploadException
 */
export function isUploadException(error: unknown): error is UploadException {
  return error instanceof UploadException
}

/**
 * Extract user-friendly message from any error
 */
export function getUploadErrorMessage(error: unknown): string {
  if (isUploadException(error)) {
    return error.getUserMessage()
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'An unexpected error occurred'
}
