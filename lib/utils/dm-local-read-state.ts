import { YAPPR_DM_CONTRACT_ID } from '@/lib/constants'
import { readScoped, writeScoped } from '@/lib/storage-scope'
import type { DirectMessage } from '@/lib/types'

// The inbox reads the latest 100 messages per conversation. Keep a larger,
// bounded set of confirmed incoming IDs without relying on the device clock.
const MAX_READ_MESSAGE_IDS = 1000

function storageKey(userId: string, conversationId: string): string {
  return `yappr_dm_read:${YAPPR_DM_CONTRACT_ID}:${userId}:${conversationId}`
}

export function getLocallyReadMessageIds(userId: string, conversationId: string): Set<string> {
  try {
    const stored: unknown = JSON.parse(readScoped(storageKey(userId, conversationId)) || '[]')
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Browser-local read state is independent of the optional public read receipt. */
export function markMessagesReadLocally(
  userId: string,
  conversationId: string,
  messages: Pick<DirectMessage, 'id' | 'senderId'>[]
): void {
  const incoming = messages.filter(message => message.senderId !== userId && message.id && !message.id.startsWith('temp-'))
  if (incoming.length === 0) return

  const ids = getLocallyReadMessageIds(userId, conversationId)
  for (const message of incoming) ids.add(message.id)
  writeScoped(storageKey(userId, conversationId), JSON.stringify([...ids].slice(-MAX_READ_MESSAGE_IDS)))
}
