'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useImageUpload } from '@/hooks/use-image-upload'
import { useFileDrop } from '@/hooks/use-file-drop'
import { isIpfsProtocol } from '@/lib/utils/ipfs-gateway'
import { validateHttpUrl } from '@/lib/utils'
import { IpfsImage } from './ipfs-image'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { PhotoIcon, XMarkIcon, LinkIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'

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
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { upload, isUploading, progress, error, isProviderConnected, checkProvider, clearError } = useImageUpload()
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [showUrlInput, setShowUrlInput] = useState(false)

  const [imageLoading, setImageLoading] = useState(false)

  useEffect(() => {
    checkProvider().catch(() => {
      // Silently handle - state will be updated
    })
  }, [checkProvider])

  useEffect(() => {
    setImageLoading(Boolean(currentUrl && isIpfsProtocol(currentUrl)))
  }, [currentUrl])

  const processFile = useCallback(async (file: File) => {
    setLocalError(null)
    clearError()

    if (!file.type.startsWith('image/')) {
      setLocalError('Please select an image file')
      return
    }

    const maxBytes = maxSizeMB * 1024 * 1024
    if (file.size > maxBytes) {
      setLocalError(`Image must be smaller than ${maxSizeMB}MB`)
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      setPreviewUrl(reader.result as string)
    }
    reader.readAsDataURL(file)

    try {
      const result = await upload(file)
      onUpload(`ipfs://${result.cid}`)
      setPreviewUrl(null)
    } catch (err) {
      setPreviewUrl(null)
      const msg = err instanceof Error ? err.message : 'Image upload failed'
      if (msg.toLowerCase().includes('provider')) {
        toast.error('No storage provider connected. Set one up in Settings to upload images.')
      } else {
        toast.error(msg)
      }
    }
  }, [upload, maxSizeMB, onUpload, clearError])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    await processFile(file)

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [processFile])

  const { isDragging, dropZoneProps } = useFileDrop({
    disabled: isUploading,
    onDrop: processFile,
  })

  const handleClear = useCallback(() => {
    setPreviewUrl(null)
    setLocalError(null)
    clearError()
    onClear?.()
  }, [onClear, clearError])

  const handleClick = useCallback(() => {
    if (isUploading) return
    if (!isProviderConnected) {
      toast.error('No storage provider connected. Set one up in Settings to upload images.', {
        duration: 5000,
      })
      router.push('/settings')
      return
    }
    fileInputRef.current?.click()
  }, [isUploading, isProviderConnected, router])

  const handleUrlSubmit = useCallback(() => {
    const validated = validateHttpUrl(urlInput)
    if (!validated) {
      setLocalError('Please enter a valid http or https URL')
      return
    }
    setLocalError(null)
    clearError()
    onUpload(validated)
    setUrlInput('')
    setShowUrlInput(false)
  }, [urlInput, onUpload, clearError])

  const aspectClass = aspectRatio === 'square'
    ? 'aspect-square rounded-full'
    : 'aspect-[3/1] rounded-lg'

  const currentError = localError || error
  const imageClass = `absolute inset-0 w-full h-full object-cover ${isUploading ? 'opacity-50' : ''}`

  function renderImage(): React.ReactNode {
    if (previewUrl) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={previewUrl} alt="Preview" className={imageClass} />
    }

    if (!currentUrl) return null

    if (isIpfsProtocol(currentUrl)) {
      return (
        <>
          {imageLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800">
              <Loader2 className="h-6 w-6 text-gray-400 animate-spin" />
            </div>
          )}
          <IpfsImage
            src={currentUrl}
            alt="Preview"
            className={imageClass}
            onLoad={() => setImageLoading(false)}
            onError={() => setImageLoading(false)}
          />
        </>
      )
    }

    // Regular http(s) URL
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={currentUrl} alt="Preview" className={imageClass} />
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
        {...dropZoneProps}
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
            {renderImage()}
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
              {isDragging ? 'Drop image here' : isProviderConnected ? placeholder : 'Paste a URL below'}
            </span>
            {isProviderConnected && (
              <span className="text-xs text-gray-400 mt-1">
                Max {maxSizeMB}MB
              </span>
            )}
          </div>
        )}
      </div>

      {/* URL paste toggle + input */}
      {!currentUrl && !previewUrl && (
        showUrlInput ? (
          <div className="flex gap-1.5">
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleUrlSubmit() } }}
              placeholder="https://example.com/image.jpg"
              className="h-7 flex-1 rounded border border-gray-700 bg-gray-900/60 px-2 text-xs text-gray-300 placeholder:text-gray-600 focus:border-yappr-500 focus:outline-none"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={handleUrlSubmit}
              className="shrink-0 rounded bg-gray-800 px-2 text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-300"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => { setShowUrlInput(false); setUrlInput('') }}
              className="shrink-0 rounded px-1 text-xs text-gray-500 hover:text-gray-300"
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowUrlInput(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-400"
          >
            <LinkIcon className="h-3 w-3" />
            Paste image URL
          </button>
        )
      )}

      {/* Error message */}
      {currentError && (
        <p className="text-sm text-red-500">{currentError}</p>
      )}
    </div>
  )
}
