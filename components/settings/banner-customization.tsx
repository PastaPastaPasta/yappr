'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useImageUpload } from '@/hooks/use-image-upload'
import { isIpfsProtocol, ipfsToGatewayUrl } from '@/lib/utils/ipfs-gateway'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { Button } from '@/components/ui/button'
import { invalidateBannerCache } from '@/components/ui/banner-image'
import { Loader2, ImagePlus, Trash2 } from 'lucide-react'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import toast from 'react-hot-toast'

interface BannerCustomizationProps {
  /** Callback when banner is saved, receives new URL or null if removed */
  onSave?: (newBannerUrl: string | null) => void
  /** Initial banner URL (ipfs:// or https://) */
  initialBannerUrl?: string | null
}

/**
 * Banner customization component for profile editing.
 * Allows uploading custom banner images via IPFS.
 */
export function BannerCustomization({ onSave, initialBannerUrl }: BannerCustomizationProps) {
  const { user } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [bannerUrl, setBannerUrl] = useState<string | null>(initialBannerUrl || null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(initialBannerUrl || null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(initialBannerUrl === undefined)
  const [imageLoading, setImageLoading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const { upload, isUploading, progress, error, isProviderConnected, checkProvider, clearError } = useImageUpload()

  // Check provider on mount
  useEffect(() => {
    checkProvider().catch(() => {})
  }, [checkProvider])

  // Load current banner from profile if not provided
  useEffect(() => {
    if (initialBannerUrl !== undefined) {
      setBannerUrl(initialBannerUrl)
      setOriginalUrl(initialBannerUrl)
      setLoading(false)
      return
    }

    if (!user?.identityId) {
      setLoading(false)
      return
    }

    const loadBanner = async () => {
      try {
        const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
        const profile = await unifiedProfileService.getProfile(user.identityId)
        const url = profile?.bannerUri || null
        setBannerUrl(url)
        setOriginalUrl(url)
      } catch (error) {
        logger.error('Failed to load banner:', error)
      } finally {
        setLoading(false)
      }
    }

    loadBanner().catch((error) => logger.error(error))
  }, [user?.identityId, initialBannerUrl])

  // Track image loading for IPFS URLs
  useEffect(() => {
    if (bannerUrl && isIpfsProtocol(bannerUrl)) {
      setImageLoading(true)
    } else {
      setImageLoading(false)
    }
  }, [bannerUrl])

  const hasChanges = bannerUrl !== originalUrl

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    clearError()

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    const maxBytes = 5 * 1024 * 1024
    if (file.size > maxBytes) {
      toast.error('Image must be smaller than 5MB')
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
      const ipfsUrl = `ipfs://${result.cid}`
      setBannerUrl(ipfsUrl)
      // Don't clear preview here - keep it visible until IPFS image loads
    } catch {
      setPreviewUrl(null)
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [upload, clearError])

  const handleClear = useCallback(() => {
    setBannerUrl(null)
    setPreviewUrl(null)
  }, [])

  const handleSave = async () => {
    if (!user?.identityId) return

    setSaving(true)
    try {
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

      await unifiedProfileService.updateProfile(user.identityId, {
        bannerUri: bannerUrl || '', // Empty string clears the field
      })

      invalidateBannerCache(user.identityId)
      setOriginalUrl(bannerUrl)

      toast.success('Banner saved!')
      onSave?.(bannerUrl)
    } catch (error) {
      logger.error('Failed to save banner:', error)
      toast.error('Failed to save banner')
    } finally {
      setSaving(false)
    }
  }

  // Convert IPFS URL to gateway URL for display
  const displayUrl = bannerUrl && isIpfsProtocol(bannerUrl)
    ? ipfsToGatewayUrl(bannerUrl)
    : bannerUrl

  const hasImage = previewUrl || displayUrl

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse">
          <div className="aspect-[3/1] rounded-xl bg-gray-200 dark:bg-gray-800" />
        </div>
      </div>
    )
  }

  // Provider not connected state
  if (!isProviderConnected) {
    return (
      <div className="space-y-4">
        <div className="aspect-[3/1] rounded-xl bg-gray-100 dark:bg-gray-800 border-2 border-dashed border-gray-300 dark:border-gray-700 flex items-center justify-center">
          <div className="text-center p-4">
            <Cog6ToothIcon className="h-10 w-10 mx-auto text-gray-400 mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
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
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
        disabled={isUploading}
      />

      {/* Main banner area - shows image or upload prompt */}
      <div className="relative aspect-[3/1] rounded-xl overflow-hidden bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900">
        {/* IPFS image - render when we have an IPFS URL so it can load */}
        {bannerUrl && isIpfsProtocol(bannerUrl) && (
          <IpfsImage
            src={bannerUrl}
            alt="Banner"
            className={`absolute inset-0 w-full h-full object-cover ${isUploading ? 'opacity-50' : ''}`}
            onLoad={() => {
              setImageLoading(false)
              setPreviewUrl(null) // Clear preview once IPFS image loads
            }}
            onError={() => setImageLoading(false)}
          />
        )}

        {/* Regular URL image */}
        {displayUrl && !isIpfsProtocol(bannerUrl || '') && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={displayUrl}
            alt="Banner"
            className={`absolute inset-0 w-full h-full object-cover ${isUploading ? 'opacity-50' : ''}`}
          />
        )}

        {/* Preview overlay - shown on top while IPFS image loads */}
        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Banner preview"
            className={`absolute inset-0 w-full h-full object-cover ${isUploading ? 'opacity-50' : ''}`}
          />
        )}

        {/* Loading indicator when IPFS is loading and no preview */}
        {imageLoading && !previewUrl && bannerUrl && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-8 w-8 text-gray-400 animate-spin" />
          </div>
        )}

        {/* Empty state */}
        {!hasImage && !isUploading && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="absolute inset-0 flex flex-col items-center justify-center cursor-pointer hover:bg-gray-200/50 dark:hover:bg-gray-700/50 transition-colors w-full"
          >
            <ImagePlus className="h-12 w-12 text-gray-400 mb-3" />
            <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
              Click to upload banner
            </span>
            <span className="text-xs text-gray-400 mt-1">
              1500×500 recommended • Max 5MB
            </span>
          </button>
        )}

        {/* Upload progress overlay */}
        {isUploading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm">
            <Loader2 className="h-10 w-10 text-white animate-spin mb-3" />
            <span className="text-white text-sm font-medium">Uploading... {progress}%</span>
          </div>
        )}

        {/* Action buttons overlay - shown when there's a visible image */}
        {(previewUrl || (hasImage && !imageLoading)) && !isUploading && (
          <div className="absolute inset-0 bg-black/0 hover:bg-black/40 transition-colors group">
            <div className="absolute inset-0 flex items-center justify-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 bg-white/90 hover:bg-white text-gray-900 rounded-lg font-medium text-sm transition-colors"
              >
                <ImagePlus className="h-4 w-4" />
                Change
              </button>
              <button
                onClick={handleClear}
                className="flex items-center gap-2 px-4 py-2 bg-red-500/90 hover:bg-red-500 text-white rounded-lg font-medium text-sm transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Error message */}
      {error && (
        <p className="text-sm text-red-500">{error}</p>
      )}

      {/* Save button - only show when there are changes */}
      {hasChanges && (
        <Button
          onClick={handleSave}
          disabled={saving}
          className="w-full"
        >
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            'Save Banner'
          )}
        </Button>
      )}
    </div>
  )
}
