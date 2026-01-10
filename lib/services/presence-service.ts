/**
 * Presence Service - Manages user presence state and heartbeats
 *
 * Publishes periodic heartbeats to indicate online status and
 * tracks presence of other users in the network.
 *
 * Security: All presence messages are signed with the user's Dash identity key
 * and verified on receipt to prevent spoofing.
 */

import { pubsubService, PUBSUB_TOPICS, type PubSubMessage } from './pubsub-service'
import {
  signMessage,
  verifySignature,
  getPublicKeyFromPrivate,
  uint8ArrayToBase64,
  base64ToUint8Array,
} from '../message-encryption'
import { identityService } from './identity-service'

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

// Presence message format (signed)
interface PresenceHeartbeat {
  type: 'presence'
  version: 2  // Version 2 = signed messages
  userId: string
  status: 'online' | 'away' | 'dnd'
  timestamp: number
  publicKey: string  // Base64 encoded sender's public key
  signature: string  // Base64 encoded ECDSA signature
}

// Payload that gets signed (excludes the signature itself)
interface PresencePayload {
  type: 'presence'
  version: 2
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
  private currentPrivateKey: string | null = null  // WIF format
  private currentPublicKey: Uint8Array | null = null
  private currentStatus: MyPresenceStatus = 'online'
  private _isActive = false

  // Cache of verified public keys for users (userId -> publicKey bytes)
  private verifiedPublicKeys: Map<string, Uint8Array> = new Map()

  // Listeners for presence changes
  private listeners: Set<PresenceListener> = new Set()

  /**
   * Start publishing presence for the current user
   * @param userId - The user's Dash identity ID
   * @param privateKey - The user's private key in WIF format (for signing)
   * @param status - Initial presence status
   */
  async startPresence(
    userId: string,
    privateKey: string,
    status: MyPresenceStatus = 'online'
  ): Promise<void> {
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
    this.currentPrivateKey = privateKey
    this.currentPublicKey = getPublicKeyFromPrivate(privateKey)
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
    this.currentPrivateKey = null
    this.currentPublicKey = null

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
   * Publish a signed heartbeat message
   */
  private async _publishHeartbeat(): Promise<void> {
    if (!this.currentUserId || !this.currentPrivateKey || this.currentStatus === 'invisible') {
      return
    }

    // At this point, currentStatus is not 'invisible'
    const status = this.currentStatus as 'online' | 'away' | 'dnd'

    // Create the payload to sign
    const payload: PresencePayload = {
      type: 'presence',
      version: 2,
      userId: this.currentUserId,
      status,
      timestamp: Date.now(),
    }

    // Sign the payload
    const payloadString = JSON.stringify(payload)
    const signature = await signMessage(payloadString, this.currentPrivateKey)

    // Create the full message with signature and public key
    const message: PresenceHeartbeat = {
      ...payload,
      publicKey: uint8ArrayToBase64(this.currentPublicKey!),
      signature,
    }

    try {
      await pubsubService.publish(PUBSUB_TOPICS.PRESENCE_GLOBAL, message)
    } catch (error) {
      console.error('PresenceService: Failed to publish heartbeat:', error)
    }
  }

  /**
   * Handle incoming presence message with signature verification
   */
  private _handlePresenceMessage(message: PubSubMessage): void {
    const data = message.data as PresenceHeartbeat

    // Validate message type and version (version 2 = signed)
    if (data.type !== 'presence' || data.version !== 2) {
      return
    }

    // Don't track our own presence
    if (data.userId === this.currentUserId) {
      return
    }

    // Validate required fields
    if (!data.userId || typeof data.userId !== 'string') {
      return
    }
    if (!['online', 'away', 'dnd'].includes(data.status)) {
      return
    }
    if (!data.signature || !data.publicKey) {
      console.warn('PresenceService: Rejecting unsigned message from', data.userId.slice(0, 16))
      return
    }

    // Verify signature and process message asynchronously
    this._verifyAndProcessMessage(data, message.from)
  }

  /**
   * Verify signature and process a presence message
   */
  private async _verifyAndProcessMessage(data: PresenceHeartbeat, fromPeerId?: string): Promise<void> {
    const publicKeyBytes = base64ToUint8Array(data.publicKey)
    const payload: PresencePayload = {
      type: data.type,
      version: data.version,
      userId: data.userId,
      status: data.status,
      timestamp: data.timestamp,
    }
    const payloadString = JSON.stringify(payload)

    // Verify the signature
    const isSignatureValid = await verifySignature(payloadString, data.signature, publicKeyBytes)
    if (!isSignatureValid) {
      console.warn('PresenceService: Invalid signature for message from', data.userId.slice(0, 16))
      return
    }

    // Verify the public key belongs to this userId
    const isKeyValid = await this._verifyPublicKeyOwnership(data.userId, publicKeyBytes)
    if (!isKeyValid) {
      console.warn('PresenceService: Public key mismatch for', data.userId.slice(0, 16))
      return
    }

    // Update presence map (signature and key ownership verified)
    const previousEntry = this.presenceMap.get(data.userId)
    const newEntry: PresenceEntry = {
      userId: data.userId,
      status: data.status,
      lastSeen: data.timestamp || Date.now(),
      peerId: fromPeerId,
    }

    this.presenceMap.set(data.userId, newEntry)

    // Notify listeners if this user is being watched
    const presenceInfo = this.getPresence(data.userId)
    this.listeners.forEach(listener => {
      if (listener.userIds.has(data.userId)) {
        listener.callback(data.userId, presenceInfo)
      }
    })

    // Log status changes
    if (!previousEntry || previousEntry.status !== data.status) {
      console.log('PresenceService:', data.userId.slice(0, 16) + '...', 'is', data.status)
    }
  }

  /**
   * Verify that a public key belongs to a userId by checking against the identity
   * Uses caching to avoid repeated identity lookups
   */
  private async _verifyPublicKeyOwnership(userId: string, publicKey: Uint8Array): Promise<boolean> {
    // Check cache first
    const cachedKey = this.verifiedPublicKeys.get(userId)
    if (cachedKey) {
      return this._publicKeysMatch(cachedKey, publicKey)
    }

    try {
      // Fetch identity and check public keys
      const identity = await identityService.getIdentity(userId)
      if (!identity || !identity.publicKeys) {
        return false
      }

      // Check if the provided public key matches any of the identity's ECDSA keys
      for (const key of identity.publicKeys) {
        // Only check ECDSA keys (type 0)
        if (key.type !== 0) continue

        const identityPubKey = this._extractPublicKeyBytes(key)
        if (identityPubKey && this._publicKeysMatch(identityPubKey, publicKey)) {
          // Cache the verified key
          this.verifiedPublicKeys.set(userId, publicKey)
          return true
        }
      }

      return false
    } catch (error) {
      console.error('PresenceService: Error verifying public key ownership:', error)
      return false
    }
  }

  /**
   * Extract public key bytes from an identity key object
   */
  private _extractPublicKeyBytes(key: any): Uint8Array | null {
    if (!key.data) return null

    // Handle different data formats
    if (key.data instanceof Uint8Array) {
      return key.data
    }
    if (Array.isArray(key.data)) {
      return new Uint8Array(key.data)
    }
    if (typeof key.data === 'object' && key.data.type === 'Buffer') {
      return new Uint8Array(key.data.data)
    }
    // Handle base64 string (common format from Dash Platform API)
    if (typeof key.data === 'string') {
      return base64ToUint8Array(key.data)
    }
    return null
  }

  /**
   * Compare two public keys for equality
   */
  private _publicKeysMatch(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
    return true
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
    this.verifiedPublicKeys.clear()
  }
}

// Singleton instance
export const presenceService = new PresenceService()
