'use client'

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { useAuth } from './auth-context'
import type { PresenceInfo, MyPresenceStatus } from '@/lib/services/presence-service'

// Settings stored in localStorage
interface PresenceSettings {
  enabled: boolean
  showOnlineStatus: boolean
  showLastSeen: boolean
  showInFeeds: boolean
  showTypingIndicators: boolean
}

const DEFAULT_SETTINGS: PresenceSettings = {
  enabled: true,
  showOnlineStatus: true,
  showLastSeen: true,
  showInFeeds: true,
  showTypingIndicators: true,
}

interface PresenceContextType {
  // Connection state
  isConnected: boolean
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'error'
  peerCount: number

  // My presence
  myPresenceStatus: MyPresenceStatus
  setMyPresenceStatus: (status: MyPresenceStatus) => Promise<void>

  // Get presence for other users
  getPresence: (userId: string) => PresenceInfo

  // Settings
  settings: PresenceSettings
  updateSettings: (settings: Partial<PresenceSettings>) => void

  // Typing
  sendTyping: (conversationId: string) => void
  sendStoppedTyping: (conversationId: string) => void
  getTypingUsers: (conversationId: string) => string[]
  joinConversation: (conversationId: string) => void
  leaveConversation: (conversationId: string) => void
}

const PresenceContext = createContext<PresenceContextType | undefined>(undefined)

const SETTINGS_KEY = 'yappr_presence_settings'

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()

  // Connection state
  const [isConnected, setIsConnected] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [peerCount, setPeerCount] = useState(0)

  // My presence status
  const [myPresenceStatus, setMyPresenceStatusState] = useState<MyPresenceStatus>('online')

  // Settings
  const [settings, setSettings] = useState<PresenceSettings>(DEFAULT_SETTINGS)

  // Services loaded flag
  const servicesRef = useRef<{
    pubsubService: typeof import('@/lib/services/pubsub-service').pubsubService
    presenceService: typeof import('@/lib/services/presence-service').presenceService
    typingService: typeof import('@/lib/services/typing-service').typingService
  } | null>(null)

  // Peer count polling interval
  const peerCountIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Load settings from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        setSettings({ ...DEFAULT_SETTINGS, ...parsed })
      }
    } catch (e) {
      console.error('PresenceContext: Failed to load settings:', e)
    }
  }, [])

  // Initialize presence when user logs in
  useEffect(() => {
    if (!user?.identityId) {
      // User logged out - cleanup
      if (servicesRef.current) {
        servicesRef.current.presenceService.cleanup()
        servicesRef.current.typingService.cleanup()
        servicesRef.current.pubsubService.cleanup()
        servicesRef.current = null
      }
      setIsConnected(false)
      setConnectionStatus('idle')
      setPeerCount(0)
      return
    }

    if (!settings.enabled) {
      // Clean up services when presence is disabled
      if (servicesRef.current) {
        servicesRef.current.presenceService.cleanup()
        servicesRef.current.typingService.cleanup()
        servicesRef.current.pubsubService.cleanup()
        servicesRef.current = null
      }
      setConnectionStatus('idle')
      setIsConnected(false)
      setPeerCount(0)
      return
    }

    let mounted = true

    const initializePresence = async () => {
      setConnectionStatus('connecting')

      try {
        // Dynamically import services to avoid SSR issues
        const [
          { pubsubService },
          { presenceService },
          { typingService },
        ] = await Promise.all([
          import('@/lib/services/pubsub-service'),
          import('@/lib/services/presence-service'),
          import('@/lib/services/typing-service'),
        ])

        if (!mounted) return

        servicesRef.current = { pubsubService, presenceService, typingService }

        // Initialize pubsub
        await pubsubService.initialize({
          identityId: user.identityId,
        })

        if (!mounted) {
          // Clean up pubsub if we're aborting after init
          await pubsubService.cleanup()
          return
        }

        // Initialize typing service
        typingService.initialize(user.identityId)

        // Start presence (subscribes to topics)
        await presenceService.startPresence(user.identityId, myPresenceStatus)

        if (!mounted) {
          // Clean up everything if we're aborting after presence start
          presenceService.cleanup()
          typingService.cleanup()
          await pubsubService.cleanup()
          return
        }

        setIsConnected(true)
        setConnectionStatus('connected')

        // Start polling peer count
        peerCountIntervalRef.current = setInterval(() => {
          if (pubsubService.isReady()) {
            setPeerCount(pubsubService.getPeerCount())
          }
        }, 5000)

        console.log('PresenceContext: Initialized successfully')

        // Expose services on window for debugging
        if (typeof window !== 'undefined') {
          (window as any).__yapprDebug = {
            pubsubService,
            presenceService,
            typingService,
          }
          console.log('PresenceContext: Debug services available at window.__yapprDebug')
        }

      } catch (error) {
        console.error('PresenceContext: Failed to initialize:', error)
        if (mounted) {
          setConnectionStatus('error')
          setIsConnected(false)
        }
      }
    }

    initializePresence()

    return () => {
      mounted = false
      if (peerCountIntervalRef.current) {
        clearInterval(peerCountIntervalRef.current)
        peerCountIntervalRef.current = null
      }
    }
  }, [user?.identityId, settings.enabled])

  // Update presence status
  const setMyPresenceStatus = useCallback(async (status: MyPresenceStatus) => {
    setMyPresenceStatusState(status)

    if (servicesRef.current?.presenceService) {
      await servicesRef.current.presenceService.setStatus(status)
    }
  }, [])

  // Get presence for a user
  const getPresence = useCallback((userId: string): PresenceInfo => {
    if (!servicesRef.current?.presenceService) {
      return {
        status: 'offline',
        lastSeen: null,
        isOnline: false,
        isRecentlyActive: false,
      }
    }

    return servicesRef.current.presenceService.getPresence(userId)
  }, [])

  // Update settings
  const updateSettings = useCallback((newSettings: Partial<PresenceSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated))
      return updated
    })
  }, [])

  // Typing functions
  const sendTyping = useCallback((conversationId: string) => {
    if (!settings.showTypingIndicators) return
    servicesRef.current?.typingService.sendTyping(conversationId)
  }, [settings.showTypingIndicators])

  const sendStoppedTyping = useCallback((conversationId: string) => {
    servicesRef.current?.typingService.sendStoppedTyping(conversationId)
  }, [])

  const getTypingUsers = useCallback((conversationId: string): string[] => {
    if (!servicesRef.current?.typingService) return []
    return servicesRef.current.typingService.getTypingUsers(conversationId)
  }, [])

  const joinConversation = useCallback((conversationId: string) => {
    servicesRef.current?.typingService.joinConversation(conversationId)
  }, [])

  const leaveConversation = useCallback((conversationId: string) => {
    servicesRef.current?.typingService.leaveConversation(conversationId)
  }, [])

  return (
    <PresenceContext.Provider value={{
      isConnected,
      connectionStatus,
      peerCount,
      myPresenceStatus,
      setMyPresenceStatus,
      getPresence,
      settings,
      updateSettings,
      sendTyping,
      sendStoppedTyping,
      getTypingUsers,
      joinConversation,
      leaveConversation,
    }}>
      {children}
    </PresenceContext.Provider>
  )
}

export function usePresenceContext() {
  const context = useContext(PresenceContext)
  if (context === undefined) {
    throw new Error('usePresenceContext must be used within a PresenceProvider')
  }
  return context
}

// Export settings type for use in settings page
export type { PresenceSettings }
