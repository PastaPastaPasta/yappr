'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PresenceInfo, PresenceStatus } from '@/lib/services/presence-service'

/**
 * Hook to get and watch presence status for a specific user
 */
export interface UsePresenceResult {
  status: PresenceStatus | 'loading'
  lastSeen: Date | null
  isOnline: boolean
  isRecentlyActive: boolean
  isLoading: boolean
}

export function usePresence(userId: string | undefined): UsePresenceResult {
  const [presenceInfo, setPresenceInfo] = useState<PresenceInfo | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!userId) {
      setIsLoading(false)
      setPresenceInfo(null)
      return
    }

    let mounted = true

    const loadPresence = async () => {
      try {
        const { presenceService } = await import('@/lib/services/presence-service')

        if (!mounted) return

        // Get initial presence
        const info = presenceService.getPresence(userId)
        setPresenceInfo(info)
        setIsLoading(false)

        // Watch for updates
        unsubscribeRef.current = presenceService.watchUsers([userId], (watchedUserId, updatedInfo) => {
          if (watchedUserId === userId && mounted) {
            setPresenceInfo(updatedInfo)
          }
        })

      } catch (error) {
        console.error('usePresence: Error loading presence:', error)
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    loadPresence()

    return () => {
      mounted = false
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [userId])

  if (!userId || isLoading) {
    return {
      status: 'loading',
      lastSeen: null,
      isOnline: false,
      isRecentlyActive: false,
      isLoading: true,
    }
  }

  if (!presenceInfo) {
    return {
      status: 'offline',
      lastSeen: null,
      isOnline: false,
      isRecentlyActive: false,
      isLoading: false,
    }
  }

  return {
    status: presenceInfo.status,
    lastSeen: presenceInfo.lastSeen ? new Date(presenceInfo.lastSeen) : null,
    isOnline: presenceInfo.isOnline,
    isRecentlyActive: presenceInfo.isRecentlyActive,
    isLoading: false,
  }
}

/**
 * Hook to watch multiple users' presence at once
 * More efficient than multiple usePresence calls
 */
export function usePresenceBatch(userIds: string[]): Map<string, UsePresenceResult> {
  const [presenceMap, setPresenceMap] = useState<Map<string, PresenceInfo>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (userIds.length === 0) {
      setIsLoading(false)
      setPresenceMap(new Map())
      return
    }

    let mounted = true

    const loadPresence = async () => {
      try {
        const { presenceService } = await import('@/lib/services/presence-service')

        if (!mounted) return

        // Get initial presence for all users
        const initialMap = new Map<string, PresenceInfo>()
        userIds.forEach(userId => {
          initialMap.set(userId, presenceService.getPresence(userId))
        })
        setPresenceMap(initialMap)
        setIsLoading(false)

        // Watch for updates
        unsubscribeRef.current = presenceService.watchUsers(userIds, (userId, info) => {
          if (mounted) {
            setPresenceMap(prev => {
              const next = new Map(prev)
              next.set(userId, info)
              return next
            })
          }
        })

      } catch (error) {
        console.error('usePresenceBatch: Error loading presence:', error)
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    loadPresence()

    return () => {
      mounted = false
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [userIds.join(',')])

  const result = new Map<string, UsePresenceResult>()

  userIds.forEach(userId => {
    const info = presenceMap.get(userId)

    if (isLoading || !info) {
      result.set(userId, {
        status: isLoading ? 'loading' : 'offline',
        lastSeen: null,
        isOnline: false,
        isRecentlyActive: false,
        isLoading,
      })
    } else {
      result.set(userId, {
        status: info.status,
        lastSeen: info.lastSeen ? new Date(info.lastSeen) : null,
        isOnline: info.isOnline,
        isRecentlyActive: info.isRecentlyActive,
        isLoading: false,
      })
    }
  })

  return result
}
