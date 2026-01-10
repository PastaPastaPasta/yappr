'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Hook to watch typing indicators in a conversation
 */
export interface UseTypingResult {
  typingUsers: string[]
  isTyping: boolean
  typingCount: number
}

export function useTyping(conversationId: string | undefined): UseTypingResult {
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const serviceRef = useRef<typeof import('@/lib/services/typing-service').typingService | null>(null)

  useEffect(() => {
    if (!conversationId) {
      setTypingUsers([])
      return
    }

    let mounted = true

    const loadTyping = async () => {
      try {
        const { typingService } = await import('@/lib/services/typing-service')

        if (!mounted) return

        serviceRef.current = typingService

        // Subscribe to typing changes
        unsubscribeRef.current = typingService.onTypingChange(conversationId, (convId, users) => {
          if (convId === conversationId && mounted) {
            setTypingUsers(users)
          }
        })

      } catch (error) {
        console.error('useTyping: Error loading typing service:', error)
      }
    }

    loadTyping()

    return () => {
      mounted = false
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [conversationId])

  return {
    typingUsers,
    isTyping: typingUsers.length > 0,
    typingCount: typingUsers.length,
  }
}

/**
 * Hook to send typing indicators in a conversation
 */
export interface UseSendTypingResult {
  sendTyping: () => void
  sendStoppedTyping: () => void
}

export function useSendTyping(conversationId: string | undefined): UseSendTypingResult {
  const serviceRef = useRef<typeof import('@/lib/services/typing-service').typingService | null>(null)
  const conversationIdRef = useRef(conversationId)

  // Keep conversationId ref updated
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  // Load service
  useEffect(() => {
    const loadService = async () => {
      const { typingService } = await import('@/lib/services/typing-service')
      serviceRef.current = typingService
    }
    loadService()
  }, [])

  const sendTyping = useCallback(() => {
    if (!conversationIdRef.current || !serviceRef.current) return
    serviceRef.current.sendTyping(conversationIdRef.current)
  }, [])

  const sendStoppedTyping = useCallback(() => {
    if (!conversationIdRef.current || !serviceRef.current) return
    serviceRef.current.sendStoppedTyping(conversationIdRef.current)
  }, [])

  return {
    sendTyping,
    sendStoppedTyping,
  }
}

/**
 * Combined hook for both watching and sending typing indicators
 */
export interface UseConversationTypingResult extends UseTypingResult, UseSendTypingResult {
  joinConversation: () => void
  leaveConversation: () => void
}

export function useConversationTyping(conversationId: string | undefined): UseConversationTypingResult {
  const typingResult = useTyping(conversationId)
  const sendTypingResult = useSendTyping(conversationId)
  const serviceRef = useRef<typeof import('@/lib/services/typing-service').typingService | null>(null)

  useEffect(() => {
    const loadService = async () => {
      const { typingService } = await import('@/lib/services/typing-service')
      serviceRef.current = typingService
    }
    loadService()
  }, [])

  const joinConversation = useCallback(() => {
    if (!conversationId || !serviceRef.current) return
    serviceRef.current.joinConversation(conversationId)
  }, [conversationId])

  const leaveConversation = useCallback(() => {
    if (!conversationId || !serviceRef.current) return
    serviceRef.current.leaveConversation(conversationId)
  }, [conversationId])

  return {
    ...typingResult,
    ...sendTypingResult,
    joinConversation,
    leaveConversation,
  }
}
