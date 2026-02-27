'use client'

import { logger } from '@/lib/logger';
import { useState, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { getStorachaProvider, getPinataProvider, isUploadException, getUploadErrorMessage } from '@/lib/upload'
import type { UploadResult, UploadProvider } from '@/lib/upload'

export interface UseImageUploadResult {
  /** Upload a file and return the result with CID and URL */
  upload: (file: File) => Promise<UploadResult>
  /** Whether an upload is currently in progress */
  isUploading: boolean
  /** Upload progress (0-100) */
  progress: number
  /** Error message if upload failed */
  error: string | null
  /** Whether a storage provider is connected */
  isProviderConnected: boolean
  /** Check and update provider connection status */
  checkProvider: () => Promise<boolean>
  /** Clear any error state */
  clearError: () => void
}

/**
 * Get connected provider (Storacha or Pinata) for the given identity
 */
function getConnectedProvider(identityId: string): UploadProvider | null {
  // Check Storacha first
  const storacha = getStorachaProvider()
  storacha.setIdentityId(identityId)
  if (storacha.isConnected()) {
    return storacha
  }

  // Check Pinata
  const pinata = getPinataProvider()
  pinata.setIdentityId(identityId)
  if (pinata.isConnected()) {
    return pinata
  }

  return null
}

/**
 * Try to connect a provider using stored credentials
 */
async function tryConnectProvider(identityId: string): Promise<UploadProvider | null> {
  // Try Storacha
  const storacha = getStorachaProvider()
  storacha.setIdentityId(identityId)
  if (storacha.hasStoredCredentials()) {
    try {
      await storacha.connect()
      return storacha
    } catch {
      // Credentials invalid or expired
    }
  }

  // Try Pinata
  const pinata = getPinataProvider()
  pinata.setIdentityId(identityId)
  if (pinata.hasStoredCredentials()) {
    try {
      await pinata.connect()
      return pinata
    } catch {
      // Credentials invalid or expired
    }
  }

  return null
}

/**
 * Hook for handling image uploads to IPFS via Storacha or Pinata.
 *
 * Usage:
 * ```tsx
 * const { upload, isUploading, progress, isProviderConnected } = useImageUpload()
 *
 * const handleUpload = async (file: File) => {
 *   try {
 *     const result = await upload(file)
 *     logger.info('Uploaded:', result.url) // ipfs://CID
 *   } catch (err) {
 *     // Error is also available in error state
 *   }
 * }
 * ```
 */
export function useImageUpload(): UseImageUploadResult {
  const { user } = useAuth()
  const [isUploading, setIsUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isProviderConnected, setIsProviderConnected] = useState(false)

  /**
   * Check if a storage provider is connected
   */
  const checkProvider = useCallback(async (): Promise<boolean> => {
    if (!user) {
      setIsProviderConnected(false)
      return false
    }

    try {
      // Check if already connected
      const connectedProvider = getConnectedProvider(user.identityId)
      if (connectedProvider) {
        setIsProviderConnected(true)
        return true
      }

      // Try to connect with stored credentials
      const provider = await tryConnectProvider(user.identityId)
      if (provider) {
        setIsProviderConnected(true)
        return true
      }

      setIsProviderConnected(false)
      return false
    } catch {
      setIsProviderConnected(false)
      return false
    }
  }, [user])

  /**
   * Upload a file to IPFS
   */
  const upload = useCallback(async (file: File): Promise<UploadResult> => {
    if (!user) {
      const errorMsg = 'Not logged in'
      setError(errorMsg)
      throw new Error(errorMsg)
    }

    setIsUploading(true)
    setProgress(0)
    setError(null)

    try {
      // Get connected provider or try to connect
      let provider = getConnectedProvider(user.identityId)
      if (!provider) {
        provider = await tryConnectProvider(user.identityId)
      }

      if (!provider) {
        throw new Error('No storage provider connected. Please connect a provider in Settings.')
      }

      const result = await provider.uploadImage(file, {
        onProgress: (p) => setProgress(p)
      })

      setProgress(100)
      setIsProviderConnected(true)
      return result
    } catch (err) {
      const errorMsg = getUploadErrorMessage(err)
      setError(errorMsg)

      // Update connection status if it was a connection error
      if (isUploadException(err) && err.code === 'NOT_CONNECTED') {
        setIsProviderConnected(false)
      }

      throw err
    } finally {
      setIsUploading(false)
    }
  }, [user])

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    upload,
    isUploading,
    progress,
    error,
    isProviderConnected,
    checkProvider,
    clearError,
  }
}
