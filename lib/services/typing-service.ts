/**
 * Typing Service - Manages typing indicators for DM conversations
 *
 * Publishes typing events to per-conversation topics and tracks
 * who is currently typing in each conversation.
 */

import { pubsubService, PUBSUB_TOPICS, type PubSubMessage } from './pubsub-service'

// Timing constants
const TYPING_DEBOUNCE = 1000 // 1 second debounce before sending typing
const TYPING_TIMEOUT = 5000 // 5 seconds to stop showing typing
const TYPING_REPEAT_INTERVAL = 3000 // Re-send typing every 3s while active

// Typing entry
interface TypingEntry {
  userId: string
  lastTyping: number // Unix ms
  timeout: NodeJS.Timeout
}

// Typing message format
interface TypingMessage {
  type: 'typing'
  version: 1
  userId: string
  conversationId: string
  isTyping: boolean
  timestamp: number
}

// Callback types
export type TypingCallback = (conversationId: string, typingUsers: string[]) => void

class TypingService {
  // Map<conversationId, Map<userId, TypingEntry>>
  private typingState: Map<string, Map<string, TypingEntry>> = new Map()

  // Subscribed conversations
  private subscribedConversations: Map<string, () => void> = new Map()

  // Current user info
  private currentUserId: string | null = null

  // Debounce/repeat timers for sending typing
  private typingDebounceTimers: Map<string, NodeJS.Timeout> = new Map()
  private typingRepeatTimers: Map<string, NodeJS.Timeout> = new Map()
  private lastTypingSent: Map<string, number> = new Map()

  // Listeners for typing changes
  private listeners: Map<string, Set<TypingCallback>> = new Map()

  /**
   * Initialize the typing service with the current user ID
   */
  initialize(userId: string): void {
    this.currentUserId = userId
  }

  /**
   * Join a conversation's typing topic
   */
  joinConversation(conversationId: string): void {
    if (this.subscribedConversations.has(conversationId)) {
      return
    }

    const topic = PUBSUB_TOPICS.TYPING_PREFIX + conversationId

    const unsubscribe = pubsubService.subscribe(topic, (message) => {
      this._handleTypingMessage(conversationId, message)
    })

    this.subscribedConversations.set(conversationId, unsubscribe)
    console.log('TypingService: Joined conversation:', conversationId.slice(0, 16) + '...')
  }

  /**
   * Leave a conversation's typing topic
   */
  leaveConversation(conversationId: string): void {
    const unsubscribe = this.subscribedConversations.get(conversationId)
    if (unsubscribe) {
      unsubscribe()
      this.subscribedConversations.delete(conversationId)
    }

    // Clear typing state for this conversation
    const typingMap = this.typingState.get(conversationId)
    if (typingMap) {
      typingMap.forEach(entry => clearTimeout(entry.timeout))
      this.typingState.delete(conversationId)
    }

    // Clear any pending typing timers
    const debounceTimer = this.typingDebounceTimers.get(conversationId)
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      this.typingDebounceTimers.delete(conversationId)
    }

    const repeatTimer = this.typingRepeatTimers.get(conversationId)
    if (repeatTimer) {
      clearInterval(repeatTimer)
      this.typingRepeatTimers.delete(conversationId)
    }

    this.lastTypingSent.delete(conversationId)

    console.log('TypingService: Left conversation:', conversationId.slice(0, 16) + '...')
  }

  /**
   * Signal that the current user is typing
   * Call this on each keystroke - it handles debouncing
   */
  sendTyping(conversationId: string): void {
    if (!this.currentUserId) {
      return
    }

    // Join conversation if not already joined
    if (!this.subscribedConversations.has(conversationId)) {
      this.joinConversation(conversationId)
    }

    const now = Date.now()
    const lastSent = this.lastTypingSent.get(conversationId) || 0

    // Clear existing debounce timer
    const existingDebounce = this.typingDebounceTimers.get(conversationId)
    if (existingDebounce) {
      clearTimeout(existingDebounce)
    }

    // If we haven't sent recently, send immediately
    if (now - lastSent > TYPING_REPEAT_INTERVAL) {
      this._publishTyping(conversationId, true)
      this._startRepeatTimer(conversationId)
    } else {
      // Otherwise debounce
      const timer = setTimeout(() => {
        this._publishTyping(conversationId, true)
        this._startRepeatTimer(conversationId)
      }, TYPING_DEBOUNCE)

      this.typingDebounceTimers.set(conversationId, timer)
    }
  }

  /**
   * Signal that the current user stopped typing
   * Call this when input is cleared or message is sent
   */
  sendStoppedTyping(conversationId: string): void {
    if (!this.currentUserId) {
      return
    }

    // Clear timers
    const debounceTimer = this.typingDebounceTimers.get(conversationId)
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      this.typingDebounceTimers.delete(conversationId)
    }

    const repeatTimer = this.typingRepeatTimers.get(conversationId)
    if (repeatTimer) {
      clearInterval(repeatTimer)
      this.typingRepeatTimers.delete(conversationId)
    }

    // Only send stop if we've sent a typing indicator
    const lastSent = this.lastTypingSent.get(conversationId)
    if (lastSent) {
      this._publishTyping(conversationId, false)
      this.lastTypingSent.delete(conversationId)
    }
  }

  /**
   * Check if anyone is typing in a conversation
   */
  isAnyoneTyping(conversationId: string): boolean {
    return this.getTypingUsers(conversationId).length > 0
  }

  /**
   * Get list of users currently typing in a conversation
   */
  getTypingUsers(conversationId: string): string[] {
    const typingMap = this.typingState.get(conversationId)
    if (!typingMap) {
      return []
    }

    const now = Date.now()
    const typingUsers: string[] = []

    typingMap.forEach((entry, userId) => {
      // Don't include ourselves
      if (userId === this.currentUserId) {
        return
      }

      // Check if still within timeout
      if (now - entry.lastTyping < TYPING_TIMEOUT) {
        typingUsers.push(userId)
      }
    })

    return typingUsers
  }

  /**
   * Subscribe to typing changes for a conversation
   * Returns an unsubscribe function
   */
  onTypingChange(conversationId: string, callback: TypingCallback): () => void {
    if (!this.listeners.has(conversationId)) {
      this.listeners.set(conversationId, new Set())
    }

    this.listeners.get(conversationId)!.add(callback)

    // Join conversation if not already
    if (!this.subscribedConversations.has(conversationId)) {
      this.joinConversation(conversationId)
    }

    // Immediately call with current state
    callback(conversationId, this.getTypingUsers(conversationId))

    return () => {
      const listeners = this.listeners.get(conversationId)
      if (listeners) {
        listeners.delete(callback)
        if (listeners.size === 0) {
          this.listeners.delete(conversationId)
        }
      }
    }
  }

  /**
   * Publish a typing event
   */
  private async _publishTyping(conversationId: string, isTyping: boolean): Promise<void> {
    if (!this.currentUserId) {
      return
    }

    const topic = PUBSUB_TOPICS.TYPING_PREFIX + conversationId

    const message: TypingMessage = {
      type: 'typing',
      version: 1,
      userId: this.currentUserId,
      conversationId,
      isTyping,
      timestamp: Date.now(),
    }

    try {
      await pubsubService.publish(topic, message)
      if (isTyping) {
        this.lastTypingSent.set(conversationId, Date.now())
      }
    } catch (error) {
      console.error('TypingService: Failed to publish typing:', error)
    }
  }

  /**
   * Start the repeat timer for continuous typing
   */
  private _startRepeatTimer(conversationId: string): void {
    // Clear any existing timer
    const existing = this.typingRepeatTimers.get(conversationId)
    if (existing) {
      clearInterval(existing)
    }

    // Set up repeat timer
    const timer = setInterval(() => {
      this._publishTyping(conversationId, true)
    }, TYPING_REPEAT_INTERVAL)

    this.typingRepeatTimers.set(conversationId, timer)
  }

  /**
   * Handle incoming typing message
   */
  private _handleTypingMessage(conversationId: string, message: PubSubMessage): void {
    const data = message.data as TypingMessage

    // Validate message
    if (data.type !== 'typing' || data.version !== 1) {
      return
    }

    if (data.conversationId !== conversationId) {
      return
    }

    // Ignore our own messages
    if (data.userId === this.currentUserId) {
      return
    }

    // Get or create typing map for this conversation
    if (!this.typingState.has(conversationId)) {
      this.typingState.set(conversationId, new Map())
    }

    const typingMap = this.typingState.get(conversationId)!

    if (data.isTyping) {
      // Clear existing timeout if any
      const existing = typingMap.get(data.userId)
      if (existing) {
        clearTimeout(existing.timeout)
      }

      // Set timeout to auto-remove after TYPING_TIMEOUT
      const timeout = setTimeout(() => {
        typingMap.delete(data.userId)
        this._notifyListeners(conversationId)
      }, TYPING_TIMEOUT)

      // Update entry
      typingMap.set(data.userId, {
        userId: data.userId,
        lastTyping: data.timestamp || Date.now(),
        timeout,
      })

    } else {
      // User stopped typing
      const existing = typingMap.get(data.userId)
      if (existing) {
        clearTimeout(existing.timeout)
        typingMap.delete(data.userId)
      }
    }

    // Notify listeners
    this._notifyListeners(conversationId)
  }

  /**
   * Notify listeners of typing change
   */
  private _notifyListeners(conversationId: string): void {
    const listeners = this.listeners.get(conversationId)
    if (!listeners) {
      return
    }

    const typingUsers = this.getTypingUsers(conversationId)

    listeners.forEach(callback => {
      try {
        callback(conversationId, typingUsers)
      } catch (err) {
        console.error('TypingService: Listener error:', err)
      }
    })
  }

  /**
   * Clean up all resources
   */
  cleanup(): void {
    // Leave all conversations
    Array.from(this.subscribedConversations.keys()).forEach(conversationId => {
      this.leaveConversation(conversationId)
    })

    // Clear all state
    this.typingState.clear()
    this.listeners.clear()
    this.currentUserId = null
  }
}

// Singleton instance
export const typingService = new TypingService()
