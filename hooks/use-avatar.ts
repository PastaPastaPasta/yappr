'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import type { DiceBearStyle } from '@/lib/services/unified-profile-service'

export interface AvatarSettings {
  style: DiceBearStyle
  seed: string
  avatarUrl: string
}

export interface UseAvatarSettingsResult {
  settings: AvatarSettings | null
  /** Whether the current avatar is a custom image (IPFS/URL) vs generated */
  isCustomImage: boolean
  /** The custom image URL if avatar is a custom image */
  customImageUrl: string | null
  loading: boolean
  saving: boolean
  error: string | null
  /** Save a generated DiceBear avatar */
  save: (style: DiceBearStyle, seed: string) => Promise<boolean>
  /** Save a custom image URL (ipfs:// or https://) */
  saveCustomUrl: (url: string) => Promise<boolean>
  refresh: () => void
}

/**
 * Hook to manage avatar settings (for customization UI)
 * Note: In the unified profile, avatar is stored in the profile document itself.
 * This hook provides settings management for the avatar customization UI.
 */
export function useAvatarSettings(userId: string): UseAvatarSettingsResult {
  const [settings, setSettings] = useState<AvatarSettings | null>(null)
  const [isCustomImage, setIsCustomImage] = useState(false)
  const [customImageUrl, setCustomImageUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Bumped per load so a slow response for a previous user cannot overwrite a newer one.
  const requestRef = useRef(0)

  const loadSettings = useCallback(async () => {
    const request = ++requestRef.current
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
      if (request !== requestRef.current) return

      if (profile?.avatar) {
        // Parse the avatar field to extract settings
        // Could be JSON {"style":"bottts","seed":"xyz"} or a URI (ipfs://, https://, data:)
        try {
          // Check if it's a custom image URL (ipfs://, https://, http://)
          const isCustom = profile.avatar.startsWith('ipfs://') ||
                          profile.avatar.startsWith('https://') ||
                          profile.avatar.startsWith('http://')

          if (isCustom) {
            // Custom image URL - not a generated avatar
            setIsCustomImage(true)
            setCustomImageUrl(profile.avatar)
            // Still set default settings in case user switches back to generated
            setSettings({
              style: DEFAULT_AVATAR_STYLE,
              seed: userId,
              avatarUrl: unifiedProfileService.getDefaultAvatarUrl(userId),
            })
          } else if (profile.avatar.startsWith('{')) {
            // JSON format for DiceBear settings
            const parsed = JSON.parse(profile.avatar)
            setIsCustomImage(false)
            setCustomImageUrl(null)
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
            setIsCustomImage(false)
            setCustomImageUrl(null)
            setSettings({
              style: (styleMatch?.[1] as DiceBearStyle) || DEFAULT_AVATAR_STYLE,
              seed: seedMatch ? decodeURIComponent(seedMatch[1]) : userId,
              avatarUrl: profile.avatar,
            })
          }
        } catch {
          // Fallback to default settings
          setIsCustomImage(false)
          setCustomImageUrl(null)
          setSettings({
            style: DEFAULT_AVATAR_STYLE,
            seed: userId,
            avatarUrl: unifiedProfileService.getDefaultAvatarUrl(userId),
          })
        }
      } else {
        // No avatar set, use defaults
        setIsCustomImage(false)
        setCustomImageUrl(null)
        setSettings({
          style: DEFAULT_AVATAR_STYLE,
          seed: userId,
          avatarUrl: unifiedProfileService.getDefaultAvatarUrl(userId),
        })
      }
    } catch (err) {
      if (request !== requestRef.current) return
      logger.error('useAvatarSettings: Error loading settings:', err)
      setError('Failed to load avatar settings')
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    loadSettings().catch((error) => logger.error('useAvatarSettings: load failed:', error))
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
        await loadSettings()
        return true
      } else {
        setError('Failed to save avatar')
        return false
      }
    } catch (err) {
      logger.error('useAvatarSettings: Error saving:', err)
      setError('Failed to save avatar settings')
      return false
    } finally {
      setSaving(false)
    }
  }, [userId, loadSettings])

  const saveCustomUrl = useCallback(async (url: string): Promise<boolean> => {
    if (!userId) return false

    setSaving(true)
    setError(null)

    try {
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

      // Save the URL directly (ipfs:// or https://)
      const result = await unifiedProfileService.updateProfile(userId, {
        avatar: url,
      })

      if (result) {
        await loadSettings()
        return true
      } else {
        setError('Failed to save avatar')
        return false
      }
    } catch (err) {
      logger.error('useAvatarSettings: Error saving custom URL:', err)
      setError('Failed to save avatar')
      return false
    } finally {
      setSaving(false)
    }
  }, [userId, loadSettings])

  const refresh = useCallback(() => {
    loadSettings().catch((error) => logger.error('useAvatarSettings: refresh failed:', error))
  }, [loadSettings])

  return { settings, isCustomImage, customImageUrl, loading, saving, error, save, saveCustomUrl, refresh }
}
