'use client'

import { useState, useEffect, memo } from 'react'
import { isIpfsProtocol } from '@/lib/utils/ipfs-gateway'
import { IpfsImage } from './ipfs-image'

// Module-level cache for banner URLs to prevent redundant fetches
// Stores the raw URL (ipfs:// or https://)
const bannerCache = new Map<string, { url: string | null; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const pendingRequests = new Map<string, Promise<string | null>>()

async function fetchBannerUrl(userId: string): Promise<string | null> {
  if (!userId) return null

  // Check cache first
  const cached = bannerCache.get(userId)
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
      const profile = await unifiedProfileService.getProfile(userId)

      // Store raw URL (ipfs:// or https://) - conversion happens at display time
      const bannerUri = profile?.bannerUri || null

      bannerCache.set(userId, { url: bannerUri, timestamp: Date.now() })
      return bannerUri
    } catch (error) {
      console.error('BannerImage: Error fetching banner:', error)
      bannerCache.set(userId, { url: null, timestamp: Date.now() })
      return null
    } finally {
      pendingRequests.delete(userId)
    }
  })()

  pendingRequests.set(userId, request)
  return request
}

interface BannerImageProps {
  userId: string
  className?: string
  /** Show gradient fallback if no banner (default: true) */
  fallbackGradient?: boolean
  /** Pre-fetched banner URL (skips fetch if provided, null means no banner) */
  preloadedUrl?: string | null
}

/**
 * Banner image component that automatically loads custom banner from profile.
 * Falls back to gradient when no banner is set.
 */
export const BannerImage = memo(function BannerImage({
  userId,
  className = '',
  fallbackGradient = true,
  preloadedUrl,
}: BannerImageProps) {
  // Start with preloaded URL, cached URL, or null (loading state)
  // Store raw URL (ipfs:// or https://) - conversion happens at display time
  const [bannerUrl, setBannerUrl] = useState<string | null>(() => {
    // Use preloaded URL if explicitly provided (including null)
    if (preloadedUrl !== undefined) {
      return preloadedUrl || null
    }
    if (!userId) return null
    const cached = bannerCache.get(userId)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.url
    }
    return null
  })
  const [isLoading, setIsLoading] = useState(() => {
    if (preloadedUrl !== undefined) return false
    if (!userId) return false
    const cached = bannerCache.get(userId)
    return !(cached && Date.now() - cached.timestamp < CACHE_TTL)
  })
  const [imageLoaded, setImageLoaded] = useState(false)

  useEffect(() => {
    // If preloaded URL is explicitly provided, use it and skip fetch
    if (preloadedUrl !== undefined) {
      setBannerUrl(preloadedUrl || null)
      setIsLoading(false)
      return
    }

    if (!userId) {
      setIsLoading(false)
      return
    }

    let mounted = true

    fetchBannerUrl(userId).then((url) => {
      if (mounted) {
        setBannerUrl(url)
        setIsLoading(false)
      }
    }).catch(err => {
      console.error('Failed to fetch banner URL:', err)
      if (mounted) {
        setIsLoading(false)
      }
    })

    return () => {
      mounted = false
    }
  }, [userId, preloadedUrl])

  // Reset image loaded state when URL changes
  useEffect(() => {
    setImageLoaded(false)
  }, [bannerUrl])

  // Show loading state (fetching profile)
  if (isLoading) {
    return (
      <div className={`bg-gray-200 dark:bg-gray-800 animate-pulse ${className}`} />
    )
  }

  // Show banner image if available
  if (bannerUrl) {
    // Use IpfsImage for IPFS URLs (handles gateway fallback)
    if (isIpfsProtocol(bannerUrl)) {
      return (
        <div className={`relative ${className}`}>
          {!imageLoaded && (
            <div className="absolute inset-0 bg-gray-200 dark:bg-gray-800 animate-pulse" />
          )}
          <IpfsImage
            src={bannerUrl}
            alt="Profile banner"
            className={`w-full h-full object-cover ${imageLoaded ? '' : 'invisible'}`}
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageLoaded(true)} // Still show something even on error
            fallback={fallbackGradient ? <div className="absolute inset-0 bg-gradient-yappr" /> : undefined}
          />
        </div>
      )
    }

    // Regular URL - use normal img tag
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={bannerUrl}
        alt="Profile banner"
        className={`object-cover ${className}`}
      />
    )
  }

  // Show gradient fallback
  if (fallbackGradient) {
    return (
      <div className={`bg-gradient-yappr ${className}`} />
    )
  }

  // No banner and no fallback
  return null
})

/**
 * Invalidate banner cache for a specific user.
 * Call this after banner is updated.
 */
export function invalidateBannerCache(userId: string): void {
  bannerCache.delete(userId)
}

/**
 * Clear all banner cache.
 */
export function clearBannerCache(): void {
  bannerCache.clear()
}
