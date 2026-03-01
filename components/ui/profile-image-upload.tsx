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
  placeholder = 'Click or drag to upload',
}: ProfileImageUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { upload, isUploading, progress, error, isProviderConnected, checkProvider, clearError } = useImageUpload()
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

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

  const processFile = useCallback(async (file: File) => {
    // Reset errors
    setLocalError(null)
    clearError()

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setLocalError('Please select an image file')
      return
    }

    // Validate file size
    const maxBytes = maxSizeMB * 1024 * 1024
    if (file.size > maxBytes) {
      setLocalError(`Image must be smaller than ${maxSizeMB}MB`)
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
      const ipfsUrl = `ipfs://${result.cid}`
      onUpload(ipfsUrl)
      setPreviewUrl(null)
    } catch {
      setPreviewUrl(null)
    }
  }, [upload, maxSizeMB, onUpload, clearError])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    await processFile(file)

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [processFile])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    if (isUploading) return

    const file = e.dataTransfer.files[0]
    if (file) {
      await processFile(file)
    }
  }, [isUploading, processFile])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isUploading) setIsDragging(true)
  }, [isUploading])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set false if leaving the container (not entering a child)
    if (e.currentTarget === e.target) setIsDragging(false)
  }, [])

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
          className={`relative ${aspectClass} bg-gray-50 dark:bg-gray-900/60 border border-dashed border-gray-200 dark:border-gray-800 flex items-center justify-center cursor-default`}
        >
          <div className="text-center p-4">
            <Cog6ToothIcon className="h-6 w-6 mx-auto text-gray-400 dark:text-gray-600 mb-2" />
            <p className="text-xs text-gray-500 dark:text-gray-500 mb-2">
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
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        className={`relative ${aspectClass} bg-gray-50 dark:bg-gray-900/60 border border-dashed transition-colors overflow-hidden ${
          isDragging
            ? 'border-yappr-500 bg-yappr-500/10 dark:bg-yappr-500/10'
            : 'border-gray-200 dark:border-gray-800 hover:border-yappr-500/60 dark:hover:border-yappr-500/40'
        } focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:ring-offset-2 ${
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
            <PhotoIcon className={`h-10 w-10 mb-2 ${isDragging ? 'text-yappr-500' : 'text-gray-400'}`} />
            <span className={`text-sm ${isDragging ? 'text-yappr-500' : 'text-gray-500 dark:text-gray-400'}`}>
              {isDragging ? 'Drop image here' : placeholder}
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
