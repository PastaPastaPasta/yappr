'use client'

import { useState, useEffect, memo } from 'react'
import { getDefaultAvatarUrl } from '@/lib/avatar-utils'

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
      const { avatarService } = await import('@/lib/services/avatar-service')
      const url = await avatarService.getAvatarUrl(userId)
      avatarCache.set(userId, { url, timestamp: Date.now() })
      return url
    } catch (error) {
      console.error('AvatarImage: Error fetching avatar:', error)
      return getDefaultAvatarUrl(userId)
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
 */
export const UserAvatar = memo(function UserAvatar({
  userId,
  alt = 'User avatar',
  className = '',
  size = 'md',
}: AvatarImageProps) {
  // Start with cached URL if available, otherwise null (loading state)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => {
    // Guard against empty userId
    if (!userId) return null
    const cached = avatarCache.get(userId)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.url
    }
    return null
  })

  useEffect(() => {
    if (!userId) return

    let mounted = true

    fetchAvatarUrl(userId).then((url) => {
      // Only set if mounted and we got a valid URL
      if (mounted && url) {
        setAvatarUrl(url)
      }
    })

    return () => {
      mounted = false
    }
  }, [userId])

  const sizeClass = sizeClasses[size] || sizeClasses.md

  // Don't render until we have the correct URL
  if (!avatarUrl) {
    return <div className={`rounded-full ${sizeClass} ${className}`} />
  }

  return (
    <img
      src={avatarUrl}
      alt={alt}
      className={`rounded-full object-cover ${sizeClass} ${className}`}
      crossOrigin="anonymous"
    />
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
