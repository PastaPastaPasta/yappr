'use client'

import { useState, useEffect } from 'react'
import { PlusIcon, TrashIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { SocialLink } from '@/lib/types'

interface SocialLinksInputProps {
  links: SocialLink[]
  onChange: (links: SocialLink[]) => void
  maxLinks?: number
  disabled?: boolean
  allowedPlatforms?: string[]
  label?: string
  description?: string
}

// Supported social platforms
const SOCIAL_PLATFORMS = [
  { id: 'email', label: 'Email', placeholder: 'email@example.com' },
  { id: 'signal', label: 'Signal', placeholder: 'phone or username' },
  { id: 'twitter', label: 'Twitter/X', placeholder: '@username' },
  { id: 'github', label: 'GitHub', placeholder: 'username' },
  { id: 'discord', label: 'Discord', placeholder: 'username#1234' },
  { id: 'telegram', label: 'Telegram', placeholder: '@username' },
  { id: 'youtube', label: 'YouTube', placeholder: '@channel' },
  { id: 'twitch', label: 'Twitch', placeholder: 'username' },
  { id: 'instagram', label: 'Instagram', placeholder: '@username' },
  { id: 'linkedin', label: 'LinkedIn', placeholder: 'username' },
  { id: 'mastodon', label: 'Mastodon', placeholder: '@user@instance' },
  { id: 'nostr', label: 'Nostr', placeholder: 'npub...' },
  { id: 'other', label: 'Other', placeholder: 'handle or URL' },
] as const

type SocialPlatform = typeof SOCIAL_PLATFORMS[number]['id']

function getPlatformLabel(platformId: string): string {
  const platform = SOCIAL_PLATFORMS.find(p => p.id === platformId)
  return platform?.label || platformId
}

function getPlatformPlaceholder(platformId: string): string {
  const platform = SOCIAL_PLATFORMS.find(p => p.id === platformId)
  return platform?.placeholder || 'handle'
}

export function SocialLinksInput({
  links,
  onChange,
  maxLinks = 10,
  disabled = false,
  allowedPlatforms,
  label = 'Social Links',
  description = 'Add links to your social media profiles',
}: SocialLinksInputProps) {
  // Filter platforms based on allowedPlatforms prop
  const availablePlatforms = allowedPlatforms
    ? SOCIAL_PLATFORMS.filter(p => allowedPlatforms.includes(p.id))
    : SOCIAL_PLATFORMS

  // Get default platform from available platforms, or fall back to first global platform
  const getDefaultPlatform = (): SocialPlatform => {
    if (availablePlatforms.length > 0) {
      return availablePlatforms[0].id as SocialPlatform
    }
    return SOCIAL_PLATFORMS[0].id as SocialPlatform
  }

  const [selectedPlatform, setSelectedPlatform] = useState<SocialPlatform>(getDefaultPlatform())
  const [handle, setHandle] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Sync selectedPlatform when allowedPlatforms changes
  useEffect(() => {
    const validPlatforms = availablePlatforms.map(p => p.id)
    if (!validPlatforms.includes(selectedPlatform)) {
      // Inline the default platform logic to avoid dependency on unstable function reference
      const defaultPlatform = availablePlatforms.length > 0
        ? availablePlatforms[0].id as SocialPlatform
        : SOCIAL_PLATFORMS[0].id as SocialPlatform
      setSelectedPlatform(defaultPlatform)
    }
  }, [allowedPlatforms, availablePlatforms, selectedPlatform])

  const handleAddLink = () => {
    if (!handle.trim()) {
      setError('Please enter a handle or username')
      return
    }

    if (links.length >= maxLinks) {
      setError(`Maximum ${maxLinks} social links allowed`)
      return
    }

    // Check for duplicate platform (except 'other')
    if (selectedPlatform !== 'other' && links.some(l => l.platform === selectedPlatform)) {
      setError(`${getPlatformLabel(selectedPlatform)} is already added`)
      return
    }

    onChange([...links, { platform: selectedPlatform, handle: handle.trim() }])
    setHandle('')
    setError(null)
  }

  const handleRemoveLink = (index: number) => {
    const updated = links.filter((_, i) => i !== index)
    onChange(updated)
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddLink()
    }
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {description}
      </p>

      {/* Existing links */}
      {links.length > 0 && (
        <div className="space-y-2">
          {links.map((link, index) => (
            <div
              key={index}
              className="flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-800 rounded-lg"
            >
              <span className="px-2 py-0.5 text-xs font-medium bg-gray-200 dark:bg-gray-700 rounded">
                {getPlatformLabel(link.platform)}
              </span>
              <span className="flex-1 text-sm truncate text-gray-600 dark:text-gray-300">
                {link.handle}
              </span>
              <button
                type="button"
                onClick={() => handleRemoveLink(index)}
                disabled={disabled}
                className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-50"
              >
                <TrashIcon className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new link */}
      {links.length < maxLinks && (
        <div className="flex gap-2">
          <select
            value={selectedPlatform}
            onChange={(e) => setSelectedPlatform(e.target.value as SocialPlatform)}
            disabled={disabled}
            className="px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-900
                       border-gray-300 dark:border-gray-600
                       focus:ring-2 focus:ring-blue-500 focus:border-transparent
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {availablePlatforms.map(platform => (
              <option key={platform.id} value={platform.id}>
                {platform.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={handle}
            onChange={(e) => {
              setHandle(e.target.value)
              setError(null)
            }}
            onKeyPress={handleKeyPress}
            disabled={disabled}
            placeholder={getPlatformPlaceholder(selectedPlatform)}
            className="flex-1 px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-900
                       border-gray-300 dark:border-gray-600
                       focus:ring-2 focus:ring-blue-500 focus:border-transparent
                       disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={handleAddLink}
            disabled={disabled || !handle.trim()}
            className="px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600
                       disabled:opacity-50 disabled:cursor-not-allowed
                       flex items-center gap-1"
          >
            <PlusIcon className="w-4 h-4" />
            Add
          </button>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-500">
          <ExclamationTriangleIcon className="w-4 h-4" />
          {error}
        </div>
      )}
    </div>
  )
}
