/**
 * Presence Service - Manages user presence state and heartbeats
 *
 * Publishes periodic heartbeats to indicate online status and
 * tracks presence of other users in the network.
 */

import { pubsubService, PUBSUB_TOPICS, type PubSubMessage } from './pubsub-service'

// Timing constants
const HEARTBEAT_INTERVAL = 30000 // 30 seconds
const ONLINE_THRESHOLD = 90000 // 90 seconds (3 missed heartbeats = offline)
const RECENTLY_ACTIVE_THRESHOLD = 300000 // 5 minutes
const CLEANUP_INTERVAL = 60000 // Clean stale entries every minute

// Presence status types
export type PresenceStatus = 'online' | 'away' | 'dnd' | 'offline'
export type MyPresenceStatus = 'online' | 'away' | 'dnd' | 'invisible'

// Presence entry stored in the map
export interface PresenceEntry {
  userId: string
  status: 'online' | 'away' | 'dnd'
  lastSeen: number // Unix ms
  peerId?: string
}

// Public presence info returned to consumers
export interface PresenceInfo {
  status: PresenceStatus
  lastSeen: number | null
  isOnline: boolean
  isRecentlyActive: boolean
}

// Presence message format
interface PresenceHeartbeat {
  type: 'presence'
  version: 1
  userId: string
  status: 'online' | 'away' | 'dnd'
  timestamp: number
}

// Callback types
export type PresenceCallback = (userId: string, info: PresenceInfo) => void
type PresenceListener = {
  userIds: Set<string>
  callback: PresenceCallback
}

class PresenceService {
  private presenceMap: Map<string, PresenceEntry> = new Map()
  private heartbeatInterval: NodeJS.Timeout | null = null
  private cleanupInterval: NodeJS.Timeout | null = null
  private unsubscribe: (() => void) | null = null

  private currentUserId: string | null = null
  private currentStatus: MyPresenceStatus = 'online'
  private _isActive = false

  // Listeners for presence changes
  private listeners: Set<PresenceListener> = new Set()

  /**
   * Start publishing presence for the current user
   */
  async startPresence(userId: string, status: MyPresenceStatus = 'online'): Promise<void> {
    if (this._isActive && this.currentUserId === userId) {
      // Already active for this user, just update status
      this.currentStatus = status
      return
    }

    // Stop any existing presence first
    if (this._isActive) {
      this.stopPresence()
    }

    this.currentUserId = userId
    this.currentStatus = status

    // Check if pubsub is ready before subscribing
    if (!pubsubService.isReady()) {
      console.warn('PresenceService: PubSub not ready, cannot start presence')
      this.currentUserId = null
      throw new Error('PubSub service not ready')
    }

    // Subscribe to presence topic
    this.unsubscribe = pubsubService.subscribe(
      PUBSUB_TOPICS.PRESENCE_GLOBAL,
      this._handlePresenceMessage.bind(this)
    )

    // Only mark as active after successful subscription
    this._isActive = true

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this._cleanupStaleEntries()
    }, CLEANUP_INTERVAL)

    // Only publish heartbeats if not invisible
    if (status !== 'invisible') {
      // Send initial heartbeat
      await this._publishHeartbeat()

      // Start heartbeat interval
      this.heartbeatInterval = setInterval(() => {
        this._publishHeartbeat()
      }, HEARTBEAT_INTERVAL)
    }

    console.log('PresenceService: Started for user:', userId.slice(0, 16) + '...')
  }

  /**
   * Stop publishing presence
   */
  stopPresence(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }

    this._isActive = false
    this.currentUserId = null

    console.log('PresenceService: Stopped')
  }

  /**
   * Update the current user's presence status
   */
  async setStatus(status: MyPresenceStatus): Promise<void> {
    const previousStatus = this.currentStatus
    this.currentStatus = status

    if (status === 'invisible') {
      // Stop heartbeats if going invisible
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval)
        this.heartbeatInterval = null
      }
    } else if (previousStatus === 'invisible' && this._isActive) {
      // Restart heartbeats if coming out of invisible
      await this._publishHeartbeat()
      this.heartbeatInterval = setInterval(() => {
        this._publishHeartbeat()
      }, HEARTBEAT_INTERVAL)
    } else if (this._isActive) {
      // Just publish the new status
      await this._publishHeartbeat()
    }
  }

  /**
   * Get presence status for a user
   */
  getPresence(userId: string): PresenceInfo {
    const entry = this.presenceMap.get(userId)

    if (!entry) {
      return {
        status: 'offline',
        lastSeen: null,
        isOnline: false,
        isRecentlyActive: false,
      }
    }

    const now = Date.now()
    const timeSinceLastSeen = now - entry.lastSeen

    const isOnline = timeSinceLastSeen < ONLINE_THRESHOLD
    const isRecentlyActive = timeSinceLastSeen < RECENTLY_ACTIVE_THRESHOLD

    let status: PresenceStatus
    if (!isOnline) {
      status = 'offline'
    } else {
      status = entry.status
    }

    return {
      status,
      lastSeen: entry.lastSeen,
      isOnline,
      isRecentlyActive,
    }
  }

  /**
   * Check if a user is online
   */
  isOnline(userId: string): boolean {
    return this.getPresence(userId).isOnline
  }

  /**
   * Check if a user was recently active
   */
  isRecentlyActive(userId: string): boolean {
    return this.getPresence(userId).isRecentlyActive
  }

  /**
   * Get all online user IDs
   */
  getOnlineUsers(): string[] {
    const now = Date.now()
    const onlineUsers: string[] = []

    this.presenceMap.forEach((entry, userId) => {
      if (now - entry.lastSeen < ONLINE_THRESHOLD) {
        onlineUsers.push(userId)
      }
    })

    return onlineUsers
  }

  /**
   * Watch presence for specific users
   * Returns an unsubscribe function
   */
  watchUsers(userIds: string[], callback: PresenceCallback): () => void {
    const listener: PresenceListener = {
      userIds: new Set(userIds),
      callback,
    }

    this.listeners.add(listener)

    // Immediately call callback with current state for each user
    userIds.forEach(userId => {
      callback(userId, this.getPresence(userId))
    })

    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Add a user to watch list for an existing listener
   */
  addToWatch(listener: PresenceListener, userId: string): void {
    listener.userIds.add(userId)
    // Immediately provide current state
    listener.callback(userId, this.getPresence(userId))
  }

  /**
   * Get current status
   */
  getCurrentStatus(): MyPresenceStatus {
    return this.currentStatus
  }

  /**
   * Check if presence is active
   */
  isActive(): boolean {
    return this._isActive
  }

  /**
   * Publish a heartbeat message
   */
  private async _publishHeartbeat(): Promise<void> {
    if (!this.currentUserId || this.currentStatus === 'invisible') {
      return
    }

    // At this point, currentStatus is not 'invisible'
    const status = this.currentStatus as 'online' | 'away' | 'dnd'

    const message: PresenceHeartbeat = {
      type: 'presence',
      version: 1,
      userId: this.currentUserId,
      status,
      timestamp: Date.now(),
    }

    try {
      await pubsubService.publish(PUBSUB_TOPICS.PRESENCE_GLOBAL, message)
    } catch (error) {
      console.error('PresenceService: Failed to publish heartbeat:', error)
    }
  }

  /**
   * Handle incoming presence message
   */
  private _handlePresenceMessage(message: PubSubMessage): void {
    const data = message.data as PresenceHeartbeat

    // Validate message type
    if (data.type !== 'presence' || data.version !== 1) {
      return
    }

    // Don't track our own presence
    if (data.userId === this.currentUserId) {
      return
    }

    // Validate userId
    if (!data.userId || typeof data.userId !== 'string') {
      return
    }

    // Validate status
    if (!['online', 'away', 'dnd'].includes(data.status)) {
      return
    }

    // Update presence map
    const previousEntry = this.presenceMap.get(data.userId)
    const newEntry: PresenceEntry = {
      userId: data.userId,
      status: data.status,
      lastSeen: data.timestamp || Date.now(),
      peerId: message.from,
    }

    this.presenceMap.set(data.userId, newEntry)

    // Notify listeners if this user is being watched
    const presenceInfo = this.getPresence(data.userId)
    this.listeners.forEach(listener => {
      if (listener.userIds.has(data.userId)) {
        listener.callback(data.userId, presenceInfo)
      }
    })

    // Log if status changed
    if (!previousEntry || previousEntry.status !== data.status) {
      console.log('PresenceService: User', data.userId.slice(0, 16) + '...', 'is', data.status)
    }
  }

  /**
   * Clean up stale presence entries
   */
  private _cleanupStaleEntries(): void {
    const now = Date.now()
    const staleThreshold = now - RECENTLY_ACTIVE_THRESHOLD * 2 // Keep entries for 10 minutes

    const staleUsers: string[] = []

    this.presenceMap.forEach((entry, userId) => {
      if (now - entry.lastSeen > staleThreshold) {
        staleUsers.push(userId)
      }
    })

    staleUsers.forEach(userId => {
      this.presenceMap.delete(userId)
    })

    if (staleUsers.length > 0) {
      console.log('PresenceService: Cleaned up', staleUsers.length, 'stale entries')
    }
  }

  /**
   * Get the number of tracked users
   */
  getTrackedUserCount(): number {
    return this.presenceMap.size
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.stopPresence()
    this.presenceMap.clear()
    this.listeners.clear()
  }
}

// Singleton instance
export const presenceService = new PresenceService()
