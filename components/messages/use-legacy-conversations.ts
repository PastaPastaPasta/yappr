'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { directMessageService } from '@/lib/services'
import type { Conversation, DirectMessage } from '@/lib/types'

/**
 * The user's v3/v4 conversations, read-only under DM v5 (docs/DM_V5.md §10):
 * shown in the same timeline as the v5 thread with the same person. Loaded
 * once per visit; nothing new is ever written to the old contract.
 */
export function useLegacyConversations(identityId: string | undefined, enabled: boolean): Conversation[] {
  const [conversations, setConversations] = useState<Conversation[]>([])
  useEffect(() => {
    if (!enabled || !identityId) {
      setConversations([])
      return
    }
    let cancelled = false
    directMessageService
      .getConversations(identityId, { includeParticipantInfo: false })
      .then((list) => {
        if (!cancelled) setConversations(list)
      })
      .catch((error) => logger.warn('Could not load earlier conversations:', error))
    return () => {
      cancelled = true
    }
  }, [identityId, enabled])
  return conversations
}

/** The messages of one legacy conversation, loaded when it is opened. */
export function useLegacyMessages(conversation: Conversation | null, identityId: string | undefined): DirectMessage[] {
  const [messages, setMessages] = useState<DirectMessage[]>([])
  const id = conversation?.id
  const participantId = conversation?.participantId
  useEffect(() => {
    setMessages([])
    if (!id || !participantId || !identityId) return
    let cancelled = false
    directMessageService
      .getConversationMessages(id, identityId, participantId)
      .then((list) => {
        if (!cancelled) setMessages(list)
      })
      .catch((error) => logger.warn('Could not load earlier messages:', error))
    return () => {
      cancelled = true
    }
  }, [id, participantId, identityId])
  return messages
}
