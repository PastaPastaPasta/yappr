'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useAvatarSettings, invalidateAvatarCache } from '@/hooks/use-avatar'
import {
  DICEBEAR_STYLES,
  DICEBEAR_STYLE_LABELS,
  DiceBearStyle,
  DEFAULT_STYLE,
  getAvatarUrl,
  generateRandomSeed,
} from '@/lib/avatar-utils'
import { Button } from '@/components/ui/button'
import { ArrowPathIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'

interface AvatarCustomizationProps {
  onSave?: () => void
  compact?: boolean
}

export function AvatarCustomization({ onSave, compact = false }: AvatarCustomizationProps) {
  const { user } = useAuth()
  const { settings, loading: loadingSettings, saving, save } = useAvatarSettings(user?.identityId || '')

  const [style, setStyle] = useState<DiceBearStyle>(DEFAULT_STYLE)
  const [seed, setSeed] = useState('')
  const [hasChanges, setHasChanges] = useState(false)
  const [avatarsReady, setAvatarsReady] = useState(false)

  // Delay loading avatar images by 1 second to prevent rate limiting from page spam
  useEffect(() => {
    const timer = setTimeout(() => {
      setAvatarsReady(true)
    }, 1000)
    return () => clearTimeout(timer)
  }, [])

  // Initialize from settings
  useEffect(() => {
    if (settings) {
      setStyle(settings.style)
      setSeed(settings.seed)
    } else if (user?.identityId) {
      // Default to user ID as seed
      setSeed(user.identityId)
    }
  }, [settings, user?.identityId])

  // Track changes
  useEffect(() => {
    if (!settings) {
      // No saved settings, user ID is default
      const isChanged = style !== DEFAULT_STYLE || seed !== (user?.identityId || '')
      setHasChanges(isChanged)
    } else {
      const isChanged = style !== settings.style || seed !== settings.seed
      setHasChanges(isChanged)
    }
  }, [style, seed, settings, user?.identityId])

  // Preview URL
  const previewUrl = useMemo(() => {
    if (!seed) return ''
    return getAvatarUrl({ style, seed })
  }, [style, seed])

  const handleRandomize = () => {
    setSeed(generateRandomSeed())
  }

  const handleSave = async () => {
    if (!user?.identityId) return

    const success = await save(style, seed)
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
    if (settings) {
      setStyle(settings.style)
      setSeed(settings.seed)
    } else if (user?.identityId) {
      setStyle(DEFAULT_STYLE)
      setSeed(user.identityId)
    }
  }

  if (loadingSettings || !avatarsReady) {
    return (
      <div className="space-y-4">
        <h3 className="font-semibold">Avatar</h3>
        <div className="animate-pulse space-y-4">
          <div className="flex justify-center">
            <div className="w-24 h-24 rounded-full bg-gray-200 dark:bg-gray-800" />
          </div>
          <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-1/2 mx-auto" />
          <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="aspect-square rounded-lg bg-gray-200 dark:bg-gray-800" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h3 className="font-semibold">Avatar</h3>

      {/* Preview */}
      <div className="flex justify-center">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="Avatar preview"
            className="w-24 h-24 rounded-full border-4 border-gray-200 dark:border-gray-700"
            crossOrigin="anonymous"
          />
        ) : (
          <div className="w-24 h-24 rounded-full bg-gray-200 dark:bg-gray-800 flex items-center justify-center">
            <SparklesIcon className="w-8 h-8 text-gray-400" />
          </div>
        )}
      </div>

      {/* Style Selection */}
      <div>
        <label className="text-sm font-medium mb-2 block">Style</label>
        <div className={`grid gap-2 ${compact ? 'grid-cols-3' : 'grid-cols-4 sm:grid-cols-5'}`}>
          {DICEBEAR_STYLES.map((s) => {
            const isSelected = style === s
            const stylePreviewUrl = getAvatarUrl({ style: s, seed: seed || 'preview' })

            return (
              <button
                key={s}
                onClick={() => setStyle(s)}
                className={`relative p-2 rounded-lg border-2 transition-all ${
                  isSelected
                    ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-950/20'
                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
                title={DICEBEAR_STYLE_LABELS[s]}
              >
                <img
                  src={stylePreviewUrl}
                  alt={DICEBEAR_STYLE_LABELS[s]}
                  className="w-full aspect-square rounded"
                  crossOrigin="anonymous"
                />
                <p className="text-[10px] text-center mt-1 truncate">{DICEBEAR_STYLE_LABELS[s]}</p>
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
          disabled={saving || !hasChanges || !seed}
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
