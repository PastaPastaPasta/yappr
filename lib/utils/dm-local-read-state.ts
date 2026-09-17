import { YAPPR_DM_CONTRACT_ID } from '@/lib/constants'
import { readScoped, writeScoped } from '@/lib/storage-scope'
import type { DirectMessage } from '@/lib/types'

// The inbox reads the latest 100 messages per conversation. Keep a larger,
// bounded set of confirmed incoming IDs. Platform creation times rank eviction,
// so replaying older pages cannot evict recent reads; the device clock is unused.
const MAX_READ_MESSAGE_IDS = 1000

interface ReadMessage {
  id: string
  createdAt: number
}

function storageKey(userId: string, conversationId: string): string {
  return `yappr_dm_read:${YAPPR_DM_CONTRACT_ID}:${userId}:${conversationId}`
}

function getLocallyReadMessages(userId: string, conversationId: string): ReadMessage[] {
  try {
    const stored: unknown = JSON.parse(readScoped(storageKey(userId, conversationId)) || '[]')
    return Array.isArray(stored) ? stored.filter((entry): entry is ReadMessage =>
      entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && Number.isFinite(entry.createdAt)
    ) : []
  } catch {
    return []
  }
}

export function getLocallyReadMessageIds(userId: string, conversationId: string): Set<string> {
  return new Set(getLocallyReadMessages(userId, conversationId).map(message => message.id))
}

/** Browser-local read state is independent of the optional public read receipt. */
export function markMessagesReadLocally(
  userId: string,
  conversationId: string,
  messages: Pick<DirectMessage, 'id' | 'senderId' | 'createdAt'>[]
): void {
  const incoming = messages.filter(message => message.senderId !== userId && message.id && !message.id.startsWith('temp-'))
  if (incoming.length === 0) return

  const read = new Map(getLocallyReadMessages(userId, conversationId).map(message => [message.id, message]))
  for (const message of incoming) {
    const createdAt = message.createdAt.getTime()
    if (Number.isFinite(createdAt)) read.set(message.id, { id: message.id, createdAt })
  }
  const recent = [...read.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_READ_MESSAGE_IDS)
  writeScoped(storageKey(userId, conversationId), JSON.stringify(recent))
}
