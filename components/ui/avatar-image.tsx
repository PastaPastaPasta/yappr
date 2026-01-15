'use client'

import { useState, useEffect, memo } from 'react'
import { PresenceIndicator } from './presence-indicator'

// Module-level cache for avatar URLs to prevent redundant fetches
const avatarCache = new Map<string, { url: string; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const pendingRequests = new Map<string, Promise<string>>()

async function fetchAvatarUrl(userId: string): Promise<string> {
  // Guard against empty userId to prevent seed= URLs
  if (!userId) {
    console.warn('AvatarImage: fetchAvatarUrl called with empty userId')
    return ''
  }

  // Check cache first
  const cached = avatarCache.get(userId)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.url
  }

  // Check if there's already a pending request for this user
  const pending = pendingRequests.get(userId)
  if (pending) {
    return pending
  }

  // Create new request
  const request = (async () => {
    try {
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
      const url = await unifiedProfileService.getAvatarUrl(userId)
      avatarCache.set(userId, { url, timestamp: Date.now() })
      return url
    } catch (error) {
      console.error('AvatarImage: Error fetching avatar:', error)
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
      return unifiedProfileService.getDefaultAvatarUrl(userId)
    } finally {
      pendingRequests.delete(userId)
    }
  })()

  pendingRequests.set(userId, request)
  return request
}

interface AvatarImageProps {
  userId: string
  alt?: string
  className?: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'full'
  /** Pre-fetched avatar URL from batch enrichment (skips fetch if provided) */
  preloadedUrl?: string
  /** Show presence indicator on avatar */
  showPresence?: boolean
  /** Only show presence for online/away users, hide for offline */
  hideOfflinePresence?: boolean
}

const sizeClasses = {
  xs: 'h-6 w-6',
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-12 w-12',
  xl: 'h-16 w-16',
  full: 'h-full w-full', // Use parent's dimensions
}

/**
 * Avatar image component that automatically loads custom avatar settings
 * Uses caching to prevent redundant fetches across the app
 * Does not render until the correct avatar URL is known to avoid flashing
 * Pass preloadedUrl to skip fetch and use batch-prefetched URL
 */
// Map avatar sizes to presence indicator sizes
const presenceSizes: Record<string, 'sm' | 'md' | 'lg'> = {
  xs: 'sm',
  sm: 'sm',
  md: 'sm',
  lg: 'md',
  xl: 'md',
  full: 'lg',
}

export const UserAvatar = memo(function UserAvatar({
  userId,
  alt = 'User avatar',
  className = '',
  size = 'md',
  preloadedUrl,
  showPresence = false,
  hideOfflinePresence = true,
}: AvatarImageProps) {
  // Start with preloaded URL, cached URL, or null (loading state)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => {
    // Use preloaded URL if provided
    if (preloadedUrl) return preloadedUrl
    // Guard against empty userId
    if (!userId) return null
    const cached = avatarCache.get(userId)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.url
    }
    return null
  })

  useEffect(() => {
    // If preloaded URL is provided, use it and skip fetch
    if (preloadedUrl) {
      setAvatarUrl(preloadedUrl)
      return
    }

    if (!userId) return

    let mounted = true

    fetchAvatarUrl(userId).then((url) => {
      // Only set if mounted and we got a valid URL
      if (mounted && url) {
        setAvatarUrl(url)
      }
    }).catch(err => console.error('Failed to fetch avatar URL:', err))

    return () => {
      mounted = false
    }
  }, [userId, preloadedUrl])

  const sizeClass = sizeClasses[size] || sizeClasses.md

  // Don't render until we have the correct URL
  if (!avatarUrl) {
    return <div className={`rounded-full ${sizeClass} ${className}`} />
  }

  const avatarElement = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarUrl}
      alt={alt}
      className={`rounded-full object-cover ${sizeClass} ${showPresence ? '' : className}`}
      crossOrigin="anonymous"
    />
  )

  // If not showing presence, just return the avatar
  if (!showPresence) {
    return avatarElement
  }

  // Wrap avatar with presence indicator
  return (
    <div className={`relative inline-block ${className}`}>
      {avatarElement}
      <PresenceIndicator
        userId={userId}
        size={presenceSizes[size] || 'sm'}
        hideOffline={hideOfflinePresence}
        className="absolute bottom-0 right-0 translate-x-0.5 translate-y-0.5"
      />
    </div>
  )
})

/**
 * Invalidate avatar cache for a specific user
 * Call this after avatar settings are updated
 */
export function invalidateAvatarImageCache(userId: string): void {
  avatarCache.delete(userId)
}

/**
 * Clear all avatar cache
 */
export function clearAvatarImageCache(): void {
  avatarCache.clear()
}
