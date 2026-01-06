'use client'

import { useState, useEffect, useCallback } from 'react'
import { getDefaultAvatarUrl, DiceBearStyle } from '@/lib/avatar-utils'
import type { AvatarSettings } from '@/lib/services/avatar-service'

// Module-level cache for avatar URLs
const avatarCache = new Map<string, { url: string; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

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
 * Fetches custom avatar settings if available, falls back to default
 */
export function useAvatar(userId: string): UseAvatarResult {
  const [avatarUrl, setAvatarUrl] = useState(() => {
    // Guard against empty userId to prevent seed= URLs
    if (!userId) return ''
    // Check cache first
    const cached = avatarCache.get(userId)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.url
    }
    return getDefaultAvatarUrl(userId)
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
      const { avatarService } = await import('@/lib/services/avatar-service')
      const url = await avatarService.getAvatarUrl(userId)

      // Cache the result
      avatarCache.set(userId, { url, timestamp: Date.now() })
      setAvatarUrl(url)
    } catch (error) {
      console.error('useAvatar: Error loading avatar:', error)
      // Keep using default on error
      const defaultUrl = getDefaultAvatarUrl(userId)
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
      const { avatarService } = await import('@/lib/services/avatar-service')
      const avatarSettings = await avatarService.getAvatarSettings(userId)
      setSettings(avatarSettings)
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
      const { avatarService } = await import('@/lib/services/avatar-service')
      const result = await avatarService.saveAvatarSettings(userId, style, seed)

      if (result.success) {
        // Clear cache and reload
        avatarCache.delete(userId)
        await loadSettings(true)
        return true
      } else {
        setError(result.error || 'Failed to save avatar')
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
