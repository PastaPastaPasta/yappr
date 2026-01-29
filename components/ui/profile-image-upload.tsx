'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useImageUpload } from '@/hooks/use-image-upload'
import { isIpfsProtocol } from '@/lib/utils/ipfs-gateway'
import { IpfsImage } from './ipfs-image'
import { PhotoIcon, XMarkIcon, Cog6ToothIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { Button } from './button'
import Link from 'next/link'

export interface ProfileImageUploadProps {
  /** Current ipfs:// or data: URL */
  currentUrl?: string
  /** Callback when image is uploaded (returns ipfs://CID URL) */
  onUpload: (ipfsUrl: string) => void
  /** Optional callback when image is cleared */
  onClear?: () => void
  /** Aspect ratio - square for avatar, banner for wide */
  aspectRatio?: 'square' | 'banner'
  /** Maximum file size in MB */
  maxSizeMB?: number
  /** Label for the upload area */
  label?: string
  /** Placeholder text when no image */
  placeholder?: string
}

/**
 * Profile image upload component for avatars and banners.
 * Handles IPFS uploads via connected provider (Pinata/Storacha).
 */
export function ProfileImageUpload({
  currentUrl,
  onUpload,
  onClear,
  aspectRatio = 'square',
  maxSizeMB = 5,
  label = 'Upload Image',
  placeholder = 'Click to upload',
}: ProfileImageUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { upload, isUploading, progress, error, isProviderConnected, checkProvider, clearError } = useImageUpload()
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  const [imageLoading, setImageLoading] = useState(false)

  // Check provider on mount
  useEffect(() => {
    checkProvider().catch(() => {
      // Silently handle - state will be updated
    })
  }, [checkProvider])

  // Track when we have an IPFS URL to show (for loading state)
  useEffect(() => {
    if (currentUrl && isIpfsProtocol(currentUrl)) {
      setImageLoading(true)
    } else {
      setImageLoading(false)
    }
  }, [currentUrl])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Reset errors
    setLocalError(null)
    clearError()

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setLocalError('Please select an image file')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    // Validate file size
    const maxBytes = maxSizeMB * 1024 * 1024
    if (file.size > maxBytes) {
      setLocalError(`Image must be smaller than ${maxSizeMB}MB`)
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    // Create local preview
    const reader = new FileReader()
    reader.onload = () => {
      setPreviewUrl(reader.result as string)
    }
    reader.readAsDataURL(file)

    try {
      const result = await upload(file)
      // Return ipfs:// URL for storage (canonical format)
      const ipfsUrl = `ipfs://${result.cid}`
      onUpload(ipfsUrl)
      setPreviewUrl(null) // Clear preview, will use the uploaded URL
    } catch (err) {
      // Error is already set in the hook
      setPreviewUrl(null)
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [upload, maxSizeMB, onUpload, clearError])

  const handleClear = useCallback(() => {
    setPreviewUrl(null)
    setLocalError(null)
    clearError()
    onClear?.()
  }, [onClear, clearError])

  const handleClick = useCallback(() => {
    if (isUploading) return
    fileInputRef.current?.click()
  }, [isUploading])

  const aspectClass = aspectRatio === 'square'
    ? 'aspect-square rounded-full'
    : 'aspect-[3/1] rounded-lg'

  const currentError = localError || error

  // Show provider connection prompt if not connected
  if (!isProviderConnected) {
    return (
      <div className="space-y-2">
        {label && (
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {label}
          </label>
        )}
        <div
          className={`relative ${aspectClass} bg-gray-100 dark:bg-gray-800 border-2 border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center cursor-default`}
        >
          <div className="text-center p-4">
            <Cog6ToothIcon className="h-8 w-8 mx-auto text-gray-400 mb-2" />
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
              Connect a storage provider to upload images
            </p>
            <Link href="/settings">
              <Button size="sm" variant="outline">
                Go to Settings
              </Button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {label && (
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
        disabled={isUploading}
      />

      <div
        role="button"
        tabIndex={isUploading ? -1 : 0}
        aria-disabled={isUploading}
        onClick={handleClick}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !isUploading) {
            e.preventDefault()
            handleClick()
          }
        }}
        className={`relative ${aspectClass} bg-gray-100 dark:bg-gray-800 border-2 border-dashed border-gray-300 dark:border-gray-600 hover:border-yappr-500 dark:hover:border-yappr-500 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:ring-offset-2 transition-colors overflow-hidden ${
          isUploading ? 'cursor-wait' : 'cursor-pointer'
        }`}
      >
        {/* Current or preview image */}
        {(previewUrl || currentUrl) && (
          <>
            {/* Use IpfsImage for IPFS URLs (handles gateway fallback), regular img for data URLs */}
            {previewUrl ? (
              // Preview from file input (data: URL)
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="Preview"
                className={`absolute inset-0 w-full h-full object-cover ${
                  isUploading ? 'opacity-50' : ''
                }`}
              />
            ) : currentUrl && isIpfsProtocol(currentUrl) ? (
              // IPFS URL - use IpfsImage for gateway fallback
              <>
                {imageLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800">
                    <Loader2 className="h-6 w-6 text-gray-400 animate-spin" />
                  </div>
                )}
                <IpfsImage
                  src={currentUrl}
                  alt="Preview"
                  className={`absolute inset-0 w-full h-full object-cover ${
                    isUploading ? 'opacity-50' : ''
                  }`}
                  onLoad={() => setImageLoading(false)}
                  onError={() => setImageLoading(false)}
                />
              </>
            ) : currentUrl ? (
              // Regular URL
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={currentUrl}
                alt="Preview"
                className={`absolute inset-0 w-full h-full object-cover ${
                  isUploading ? 'opacity-50' : ''
                }`}
              />
            ) : null}
            {/* Clear button */}
            {!isUploading && onClear && !imageLoading && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleClear()
                }}
                className="absolute top-2 right-2 p-1.5 bg-black/50 hover:bg-black/70 rounded-full transition-colors"
                title="Remove image"
              >
                <XMarkIcon className="h-4 w-4 text-white" />
              </button>
            )}
          </>
        )}

        {/* Upload progress overlay */}
        {isUploading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/30">
            <Loader2 className="h-8 w-8 text-white animate-spin mb-2" />
            <span className="text-white text-sm font-medium">{progress}%</span>
          </div>
        )}

        {/* Empty state */}
        {!previewUrl && !currentUrl && !isUploading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <PhotoIcon className="h-10 w-10 text-gray-400 mb-2" />
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {placeholder}
            </span>
            <span className="text-xs text-gray-400 mt-1">
              Max {maxSizeMB}MB
            </span>
          </div>
        )}
      </div>

      {/* Error message */}
      {currentError && (
        <p className="text-sm text-red-500">{currentError}</p>
      )}
    </div>
  )
}
