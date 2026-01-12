'use client'

import { useState, useEffect, useCallback } from 'react'
import type { DiceBearStyle } from '@/lib/services/unified-profile-service'

// Module-level cache for avatar URLs
const avatarCache = new Map<string, { url: string; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export interface AvatarSettings {
  style: DiceBearStyle
  seed: string
  avatarUrl: string
}

export interface UseAvatarResult {
  avatarUrl: string
  loading: boolean
  refresh: () => void
}

export interface UseAvatarSettingsResult {
  settings: AvatarSettings | null
  loading: boolean
  saving: boolean
  error: string | null
  save: (style: DiceBearStyle, seed: string) => Promise<boolean>
  refresh: () => void
}

/**
 * Hook to get avatar URL for a user
 * Fetches from unified profile service, falls back to default
 */
export function useAvatar(userId: string): UseAvatarResult {
  const [avatarUrl, setAvatarUrl] = useState(() => {
    if (!userId) return ''
    // Check cache first
    const cached = avatarCache.get(userId)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.url
    }
    // Return empty initially, will be populated after load
    return ''
  })
  const [loading, setLoading] = useState(true)

  const loadAvatar = useCallback(async (forceRefresh = false) => {
    if (!userId) {
      setLoading(false)
      return
    }

    // Check cache unless forcing refresh
    if (!forceRefresh) {
      const cached = avatarCache.get(userId)
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        setAvatarUrl(cached.url)
        setLoading(false)
        return
      }
    }

    setLoading(true)

    try {
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
      const url = await unifiedProfileService.getAvatarUrl(userId)

      // Cache the result
      avatarCache.set(userId, { url, timestamp: Date.now() })
      setAvatarUrl(url)
    } catch (error) {
      console.error('useAvatar: Error loading avatar:', error)
      // Use default on error
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
      const defaultUrl = unifiedProfileService.getDefaultAvatarUrl(userId)
      setAvatarUrl(defaultUrl)
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    loadAvatar()
  }, [loadAvatar])

  const refresh = useCallback(() => {
    avatarCache.delete(userId)
    loadAvatar(true)
  }, [userId, loadAvatar])

  return { avatarUrl, loading, refresh }
}

/**
 * Hook to manage avatar settings (for customization UI)
 * Note: In the unified profile, avatar is stored in the profile document itself.
 * This hook provides settings management for the avatar customization UI.
 */
export function useAvatarSettings(userId: string): UseAvatarSettingsResult {
  const [settings, setSettings] = useState<AvatarSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSettings = useCallback(async (forceRefresh = false) => {
    if (!userId) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const { unifiedProfileService, DEFAULT_AVATAR_STYLE } = await import('@/lib/services/unified-profile-service')

      // Get profile to extract avatar settings
      const profile = await unifiedProfileService.getProfile(userId)

      if (profile && profile.avatar) {
        // Parse the avatar field to extract settings
        // Could be JSON {"style":"bottts","seed":"xyz"} or a URI
        try {
          if (profile.avatar.startsWith('{')) {
            const parsed = JSON.parse(profile.avatar)
            setSettings({
              style: parsed.style || DEFAULT_AVATAR_STYLE,
              seed: parsed.seed || userId,
              avatarUrl: unifiedProfileService.getAvatarUrlFromConfig({
                style: parsed.style || DEFAULT_AVATAR_STYLE,
                seed: parsed.seed || userId,
              }),
            })
          } else {
            // Direct URI - extract seed from DiceBear URL if possible
            const seedMatch = profile.avatar.match(/seed=([^&]+)/)
            const styleMatch = profile.avatar.match(/\/7\.x\/([^/]+)\//)
            setSettings({
              style: (styleMatch?.[1] as DiceBearStyle) || DEFAULT_AVATAR_STYLE,
              seed: seedMatch ? decodeURIComponent(seedMatch[1]) : userId,
              avatarUrl: profile.avatar,
            })
          }
        } catch {
          // Fallback to default settings
          setSettings({
            style: DEFAULT_AVATAR_STYLE,
            seed: userId,
            avatarUrl: unifiedProfileService.getDefaultAvatarUrl(userId),
          })
        }
      } else {
        // No avatar set, use defaults
        setSettings({
          style: DEFAULT_AVATAR_STYLE,
          seed: userId,
          avatarUrl: unifiedProfileService.getDefaultAvatarUrl(userId),
        })
      }
    } catch (err) {
      console.error('useAvatarSettings: Error loading settings:', err)
      setError('Failed to load avatar settings')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const save = useCallback(async (style: DiceBearStyle, seed: string): Promise<boolean> => {
    if (!userId) return false

    setSaving(true)
    setError(null)

    try {
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

      // Encode avatar as JSON string
      const avatarData = unifiedProfileService.encodeAvatarData(seed, style)

      // Update the profile with new avatar
      const result = await unifiedProfileService.updateProfile(userId, {
        avatar: avatarData,
      })

      if (result) {
        // Clear cache and reload
        avatarCache.delete(userId)
        await loadSettings(true)
        return true
      } else {
        setError('Failed to save avatar')
        return false
      }
    } catch (err) {
      console.error('useAvatarSettings: Error saving:', err)
      setError('Failed to save avatar settings')
      return false
    } finally {
      setSaving(false)
    }
  }, [userId, loadSettings])

  const refresh = useCallback(() => {
    loadSettings(true)
  }, [loadSettings])

  return { settings, loading, saving, error, save, refresh }
}

/**
 * Invalidate cached avatar for a user
 * Call this after avatar settings are updated elsewhere
 */
export function invalidateAvatarCache(userId: string): void {
  avatarCache.delete(userId)
}

/**
 * Clear all cached avatars
 */
export function clearAvatarCache(): void {
  avatarCache.clear()
}
