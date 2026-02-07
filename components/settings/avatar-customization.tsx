'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useAvatarSettings, invalidateAvatarCache } from '@/hooks/use-avatar'
import {
  unifiedProfileService,
  DICEBEAR_STYLES,
  DICEBEAR_STYLE_LABELS,
  DEFAULT_AVATAR_STYLE,
  type DiceBearStyle,
} from '@/lib/services/unified-profile-service'
import { Button } from '@/components/ui/button'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { isIpfsProtocol, ipfsToGatewayUrl } from '@/lib/utils/ipfs-gateway'
import { ArrowPathIcon, SparklesIcon, PhotoIcon } from '@heroicons/react/24/outline'
import Image from 'next/image'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'

type AvatarSource = 'generated' | 'custom'

interface AvatarCustomizationProps {
  onSave?: () => void
  compact?: boolean
}

export function AvatarCustomization({ onSave, compact = false }: AvatarCustomizationProps) {
  const { user } = useAuth()
  const { settings, isCustomImage, customImageUrl, loading: loadingSettings, saving, save, saveCustomUrl } = useAvatarSettings(user?.identityId || '')

  // Tab state - determine initial tab based on current avatar type
  const [avatarSource, setAvatarSource] = useState<AvatarSource>('generated')
  const [style, setStyle] = useState<DiceBearStyle>(DEFAULT_AVATAR_STYLE)
  const [seed, setSeed] = useState('')
  const [customUrl, setCustomUrl] = useState<string | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  const [avatarsReady, setAvatarsReady] = useState(false)

  // Delay loading avatar images by 1 second to prevent rate limiting from page spam
  useEffect(() => {
    const timer = setTimeout(() => {
      setAvatarsReady(true)
    }, 1000)
    return () => clearTimeout(timer)
  }, [])

  // Initialize from settings and detect current avatar type
  useEffect(() => {
    if (isCustomImage && customImageUrl) {
      setAvatarSource('custom')
      setCustomUrl(customImageUrl)
    } else {
      setAvatarSource('generated')
      setCustomUrl(null)
    }

    if (settings) {
      setStyle(settings.style)
      setSeed(settings.seed)
    } else if (user?.identityId) {
      // Default to user ID as seed
      setSeed(user.identityId)
    }
  }, [settings, user?.identityId, isCustomImage, customImageUrl])

  // Track changes
  useEffect(() => {
    if (avatarSource === 'custom') {
      // For custom images, check if URL changed
      const isChanged = customUrl !== customImageUrl
      setHasChanges(isChanged)
    } else {
      // For generated avatars
      if (!settings) {
        // No saved settings, user ID is default
        const isChanged = style !== DEFAULT_AVATAR_STYLE || seed !== (user?.identityId || '')
        setHasChanges(isChanged)
      } else if (isCustomImage) {
        // Currently using custom image, switching to generated is a change
        setHasChanges(true)
      } else {
        const isChanged = style !== settings.style || seed !== settings.seed
        setHasChanges(isChanged)
      }
    }
  }, [style, seed, settings, user?.identityId, avatarSource, customUrl, customImageUrl, isCustomImage])

  // Preview URL
  const previewUrl = useMemo(() => {
    if (!seed) return ''
    return unifiedProfileService.getAvatarUrlFromConfig({ style, seed })
  }, [style, seed])

  const handleRandomize = () => {
    setSeed(unifiedProfileService.generateRandomSeed())
  }

  const handleSave = async () => {
    if (!user?.identityId) return

    let success: boolean

    if (avatarSource === 'custom' && customUrl) {
      // Save custom image URL
      success = await saveCustomUrl(customUrl)
    } else {
      // Save generated avatar settings
      success = await save(style, seed)
    }

    if (success) {
      // Invalidate cache to refresh avatars across the app
      invalidateAvatarCache(user.identityId)
      toast.success('Avatar saved!')
      onSave?.()
    } else {
      toast.error('Failed to save avatar')
    }
  }

  const handleReset = () => {
    // Reset to the current saved state
    if (isCustomImage && customImageUrl) {
      setAvatarSource('custom')
      setCustomUrl(customImageUrl)
    } else {
      setAvatarSource('generated')
      setCustomUrl(null)
      if (settings) {
        setStyle(settings.style)
        setSeed(settings.seed)
      } else if (user?.identityId) {
        setStyle(DEFAULT_AVATAR_STYLE)
        setSeed(user.identityId)
      }
    }
  }

  const handleCustomImageUpload = (ipfsUrl: string) => {
    setCustomUrl(ipfsUrl)
  }

  const handleClearCustomImage = () => {
    setCustomUrl(null)
  }

  if (loadingSettings || !avatarsReady) {
    return (
      <div className="space-y-4">
        <h3 className="font-semibold">Avatar</h3>
        <div className="animate-pulse space-y-4">
          <div className="flex justify-center">
            <div className="w-24 h-24 rounded-full bg-surface-200 dark:bg-surface-800" />
          </div>
          <div className="h-4 bg-surface-200 dark:bg-surface-800 rounded w-1/2 mx-auto" />
          <div className={`grid ${compact ? 'grid-cols-7 gap-1' : 'grid-cols-4 sm:grid-cols-5 gap-2'}`}>
            {Array.from({ length: compact ? 28 : 8 }).map((_, i) => (
              <div key={i} className={`aspect-square rounded-lg bg-surface-200 dark:bg-surface-800 ${compact ? 'p-1' : ''}`} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Compute preview URL based on current source
  const currentPreviewUrl = avatarSource === 'custom' && customUrl
    ? customUrl
    : previewUrl

  // Check if custom URL is IPFS and convert for display
  const displayPreviewUrl = currentPreviewUrl && isIpfsProtocol(currentPreviewUrl)
    ? ipfsToGatewayUrl(currentPreviewUrl)
    : currentPreviewUrl

  return (
    <div className="space-y-6">
      <h3 className="font-semibold">Avatar</h3>

      {/* Source Tabs */}
      <div className="flex border-b border-surface-200 dark:border-neutral-750">
        <button
          onClick={() => setAvatarSource('generated')}
          className={`flex-1 py-2 px-4 text-sm font-medium transition-colors relative ${
            avatarSource === 'generated'
              ? 'text-yappr-600 dark:text-yappr-400'
              : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            <SparklesIcon className="h-4 w-4" />
            Generated
          </span>
          {avatarSource === 'generated' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yappr-500" />
          )}
        </button>
        <button
          onClick={() => setAvatarSource('custom')}
          className={`flex-1 py-2 px-4 text-sm font-medium transition-colors relative ${
            avatarSource === 'custom'
              ? 'text-yappr-600 dark:text-yappr-400'
              : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            <PhotoIcon className="h-4 w-4" />
            Custom Image
          </span>
          {avatarSource === 'custom' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yappr-500" />
          )}
        </button>
      </div>

      {avatarSource === 'generated' ? (
        <>
          {/* Preview */}
          <div className="flex justify-center">
            {displayPreviewUrl ? (
              <Image
                src={displayPreviewUrl}
                alt="Avatar preview"
                width={96}
                height={96}
                className="w-24 h-24 rounded-full border-4 border-surface-200 dark:border-neutral-750"
                unoptimized
              />
            ) : (
              <div className="w-24 h-24 rounded-full bg-surface-200 dark:bg-surface-800 flex items-center justify-center">
                <SparklesIcon className="w-8 h-8 text-gray-400" />
              </div>
            )}
          </div>

          {/* Style Selection */}
          <div>
            <label className="text-sm font-medium mb-2 block">Style</label>
            <div className={`grid ${compact ? 'grid-cols-7 gap-1' : 'grid-cols-4 sm:grid-cols-5 gap-2'}`}>
              {DICEBEAR_STYLES.map((s) => {
                const isSelected = style === s
                const stylePreviewUrl = unifiedProfileService.getAvatarUrlFromConfig({ style: s, seed: seed || 'preview' })

                return (
                  <button
                    key={s}
                    onClick={() => setStyle(s)}
                    className={`relative ${compact ? 'p-1' : 'p-2'} rounded-lg border-2 transition-all ${
                      isSelected
                        ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-950/20'
                        : 'border-surface-200 dark:border-neutral-750 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                    title={DICEBEAR_STYLE_LABELS[s]}
                  >
                    <Image
                      src={stylePreviewUrl}
                      alt={DICEBEAR_STYLE_LABELS[s]}
                      width={48}
                      height={48}
                      className="w-full aspect-square rounded"
                      unoptimized
                    />
                    {!compact && <p className="text-[10px] text-center mt-1 truncate">{DICEBEAR_STYLE_LABELS[s]}</p>}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Seed Input */}
          <div>
            <label className="text-sm font-medium mb-2 block">Custom Seed</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                placeholder="Enter custom seed..."
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                maxLength={100}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleRandomize}
                className="px-3"
                title="Generate random seed"
              >
                <ArrowPathIcon className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Change the seed to generate a unique avatar
            </p>
          </div>
        </>
      ) : (
        /* Custom Image Tab */
        <div className="space-y-4">
          <ProfileImageUpload
            currentUrl={customUrl || undefined}
            onUpload={handleCustomImageUpload}
            onClear={handleClearCustomImage}
            aspectRatio="square"
            maxSizeMB={2}
            label=""
            placeholder="Click to upload your avatar"
          />
          <p className="text-xs text-gray-500 text-center">
            Upload a custom image for your avatar. Recommended: square image, at least 200x200px.
          </p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-2">
        {hasChanges && (
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={saving}
            className="flex-1"
          >
            Reset
          </Button>
        )}
        <Button
          onClick={handleSave}
          disabled={saving || !hasChanges || (avatarSource === 'generated' && !seed) || (avatarSource === 'custom' && !customUrl)}
          className="flex-1"
        >
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            'Save Avatar'
          )}
        </Button>
      </div>
    </div>
  )
}
