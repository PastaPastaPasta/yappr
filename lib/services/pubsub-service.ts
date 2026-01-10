/**
 * PubSub Service - Core Helia/libp2p singleton for real-time messaging
 *
 * Provides pubsub functionality using libp2p Gossipsub protocol.
 * Used for presence indicators, typing indicators, and future real-time features.
 *
 * Uses createHelia() with custom libp2p services to avoid version conflicts.
 */

// Message handler type
export type MessageHandler = (message: PubSubMessage) => void

// Parsed pubsub message
export interface PubSubMessage {
  topic: string
  data: unknown
  from: string
  timestamp: number
}

// Service configuration
export interface PubSubConfig {
  identityId: string
  // Note: In future, we could use the private key for custom signing
  // For now, libp2p handles signing with its own keypair
}

// Topic constants
export const PUBSUB_TOPICS = {
  PRESENCE_GLOBAL: 'yappr/presence/v1/global',
  TYPING_PREFIX: 'yappr/typing/v1/',
  NOTIFICATIONS_PREFIX: 'yappr/notifications/v1/',
} as const

class PubSubService {
  private helia: any = null
  private initPromise: Promise<void> | null = null
  private config: PubSubConfig | null = null
  private _isInitialized = false
  private _isInitializing = false

  // Topic subscriptions and handlers
  private messageHandlers: Map<string, Set<MessageHandler>> = new Map()
  private subscribedTopics: Set<string> = new Set()

  // Rate limiting
  private messageTimestamps: Map<string, number[]> = new Map()
  private readonly MAX_MESSAGES_PER_MINUTE = 60

  /**
   * Initialize the pubsub service with Helia
   */
  async initialize(config: PubSubConfig): Promise<void> {
    // Guard against SSR
    if (typeof window === 'undefined') {
      throw new Error('PubSubService can only be initialized in browser environment')
    }

    // If already initialized with same config, return
    if (this._isInitialized && this.config?.identityId === config.identityId) {
      return
    }

    // If currently initializing, wait for it
    if (this._isInitializing && this.initPromise) {
      await this.initPromise
      return
    }

    // If config changed, cleanup first
    if (this._isInitialized && this.config?.identityId !== config.identityId) {
      await this.cleanup()
    }

    this.config = config
    this._isInitializing = true

    this.initPromise = this._performInitialization()

    try {
      await this.initPromise
    } finally {
      this._isInitializing = false
    }
  }

  private async _performInitialization(): Promise<void> {
    try {
      console.log('PubSubService: Initializing libp2p with Gossipsub...')

      // Dynamic imports to avoid SSR issues
      // Use libp2p directly instead of Helia to avoid Node.js dependencies
      const { createLibp2p } = await import('libp2p')
      const { gossipsub } = await import('@libp2p/gossipsub')
      const { webSockets } = await import('@libp2p/websockets')
      const { webRTC } = await import('@libp2p/webrtc')
      const { circuitRelayTransport } = await import('@libp2p/circuit-relay-v2')
      const { identify } = await import('@libp2p/identify')
      const { noise } = await import('@chainsafe/libp2p-noise')
      const { yamux } = await import('@chainsafe/libp2p-yamux')
      const { bootstrap } = await import('@libp2p/bootstrap')

      // Yappr relay multiaddr and peer ID
      const { peerIdFromString } = await import('@libp2p/peer-id')
      const { multiaddr } = await import('@multiformats/multiaddr')

      const YAPPR_RELAY_PEER_ID = '12D3KooWNMPUNGUmb6gDW8TCs61kZjBBAt75CXc5UzdAEQ3yaowF'
      const YAPPR_RELAY_ADDR = `/dns4/yappr-relay.thepasta.org/tcp/443/wss/p2p/${YAPPR_RELAY_PEER_ID}`

      // Bootstrap nodes - Yappr relay + public IPFS nodes
      const bootstrapNodes = [
        // Yappr relay server (required for presence/typing)
        YAPPR_RELAY_ADDR,
        // Public IPFS bootstrap nodes
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
      ]

      // Create minimal libp2p node with just what we need for pubsub
      this.helia = await createLibp2p({
        transports: [
          webSockets(),
          webRTC(),
          circuitRelayTransport(),
        ],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        peerDiscovery: [
          bootstrap({ list: bootstrapNodes }),
        ],
        services: {
          identify: identify(),
          pubsub: gossipsub({
            emitSelf: false,
            allowPublishToZeroTopicPeers: true,
            runOnLimitedConnection: true,  // Allow gossipsub on relay/limited connections
          }),
        },
      } as any)

      // Get the pubsub service from libp2p
      const pubsub = this.helia.services.pubsub

      // Set up message handler
      pubsub.addEventListener('message', (event: any) => {
        this._handleMessage(event.detail)
      })

      // Log connection events
      this.helia.addEventListener('peer:connect', (event: any) => {
        const peerId = event.detail.toString()
        console.log('PubSubService: Peer connected:', peerId.slice(0, 16) + '...')
        // Log the connections to this peer
        const connections = this.helia.getConnections(event.detail)
        connections.forEach((c: any) => {
          console.log('PubSubService: Connection details:', {
            remoteAddr: c.remoteAddr.toString(),
            direction: c.direction,
            status: c.status,
            streamCount: c.streams?.length || 0,
          })
          // Log stream protocols
          if (c.streams && c.streams.length > 0) {
            console.log('PubSubService: Stream protocols:', c.streams.map((s: any) => s.protocol))
          }
        })
        // After connecting, log pubsub peers
        setTimeout(() => {
          const pubsubPeers = pubsub.getPeers()
          console.log('PubSubService: Pubsub peers after connection:', pubsubPeers.map((p: any) => p.toString().slice(0, 16)))
          console.log('PubSubService: Topic subscribers:', pubsub.getSubscribers(PUBSUB_TOPICS.PRESENCE_GLOBAL).map((p: any) => p.toString().slice(0, 16)))
        }, 2000)
      })

      this.helia.addEventListener('peer:disconnect', (event: any) => {
        console.log('PubSubService: Peer disconnected:', event.detail.toString().slice(0, 16) + '...')
      })

      // Log pubsub peer events
      pubsub.addEventListener('subscription-change', (event: any) => {
        const { peerId, subscriptions } = event.detail
        console.log('PubSubService: Subscription change from', peerId.toString().slice(0, 16) + '...')
        subscriptions.forEach((sub: any) => {
          console.log(`  ${sub.subscribe ? 'SUBSCRIBE' : 'UNSUBSCRIBE'}: ${sub.topic}`)
        })
      })

      // Log when we get any pubsub peer
      pubsub.addEventListener('gossipsub:message', (event: any) => {
        console.log('PubSubService: Gossipsub message received:', event.detail?.topic)
      })

      this._isInitialized = true
      console.log('PubSubService: Initialized successfully')
      console.log('PubSubService: Peer ID:', this.helia.peerId.toString())

      // Log bootstrap addresses being used
      console.log('PubSubService: Bootstrap nodes:', bootstrapNodes)

      // Listen for connection errors
      this.helia.addEventListener('connection:error', (event: any) => {
        console.error('PubSubService: Connection error:', event.detail)
      })

      // Try to manually dial the relay to ensure connection
      setTimeout(async () => {
        try {
          console.log('PubSubService: Attempting to dial relay...')
          const ma = multiaddr(YAPPR_RELAY_ADDR)
          const conn = await this.helia.dial(ma)
          console.log('PubSubService: Successfully dialed relay:', conn.remoteAddr.toString())
        } catch (err) {
          console.error('PubSubService: Failed to dial relay:', err)
        }
      }, 3000)

    } catch (error) {
      console.error('PubSubService: Failed to initialize:', error)
      this.initPromise = null
      this._isInitialized = false
      throw error
    }
  }

  /**
   * Handle incoming pubsub message
   */
  private _handleMessage(message: any): void {
    try {
      const topic = message.topic
      const handlers = this.messageHandlers.get(topic)

      if (!handlers || handlers.size === 0) {
        return
      }

      // Parse message data
      const textDecoder = new TextDecoder()
      const dataStr = textDecoder.decode(message.data)
      const data = JSON.parse(dataStr)

      // Rate limit check
      const senderId = message.from?.toString() || 'unknown'
      if (!this._checkRateLimit(senderId)) {
        console.warn('PubSubService: Rate limit exceeded for peer:', senderId.slice(0, 16) + '...')
        return
      }

      // Create parsed message
      const parsedMessage: PubSubMessage = {
        topic,
        data,
        from: senderId,
        timestamp: Date.now(),
      }

      // Validate message structure
      if (!this._validateMessage(parsedMessage)) {
        console.warn('PubSubService: Invalid message structure')
        return
      }

      // Call all handlers for this topic
      handlers.forEach(handler => {
        try {
          handler(parsedMessage)
        } catch (err) {
          console.error('PubSubService: Handler error:', err)
        }
      })

    } catch (error) {
      console.error('PubSubService: Error processing message:', error)
    }
  }

  /**
   * Check rate limit for a peer
   */
  private _checkRateLimit(peerId: string): boolean {
    const now = Date.now()
    const oneMinuteAgo = now - 60000

    let timestamps = this.messageTimestamps.get(peerId) || []

    // Remove old timestamps
    timestamps = timestamps.filter(t => t > oneMinuteAgo)

    if (timestamps.length >= this.MAX_MESSAGES_PER_MINUTE) {
      return false
    }

    timestamps.push(now)
    this.messageTimestamps.set(peerId, timestamps)

    return true
  }

  /**
   * Validate message structure
   */
  private _validateMessage(message: PubSubMessage): boolean {
    // Check required fields
    if (!message.data || typeof message.data !== 'object') {
      return false
    }

    const data = message.data as Record<string, unknown>

    // Check for required type field
    if (!data.type || typeof data.type !== 'string') {
      return false
    }

    // Check for version field
    if (data.version === undefined) {
      return false
    }

    // Check for timestamp (prevent replay attacks - reject messages older than 5 minutes)
    if (data.timestamp && typeof data.timestamp === 'number') {
      const now = Date.now()
      const fiveMinutes = 5 * 60 * 1000
      if (Math.abs(now - data.timestamp) > fiveMinutes) {
        console.warn('PubSubService: Message timestamp too old or in future')
        return false
      }
    }

    return true
  }

  /**
   * Subscribe to a topic with a message handler
   * Returns an unsubscribe function
   */
  subscribe(topic: string, handler: MessageHandler): () => void {
    if (!this._isInitialized || !this.helia) {
      console.warn('PubSubService: Cannot subscribe - not initialized')
      return () => {}
    }

    // Add handler to map
    if (!this.messageHandlers.has(topic)) {
      this.messageHandlers.set(topic, new Set())
    }
    this.messageHandlers.get(topic)!.add(handler)

    // Subscribe to topic if not already subscribed
    if (!this.subscribedTopics.has(topic)) {
      this.helia.services.pubsub.subscribe(topic)
      this.subscribedTopics.add(topic)
      console.log('PubSubService: Subscribed to topic:', topic)
    }

    // Return unsubscribe function
    return () => {
      const handlers = this.messageHandlers.get(topic)
      if (handlers) {
        handlers.delete(handler)

        // If no more handlers, unsubscribe from topic
        if (handlers.size === 0) {
          this.messageHandlers.delete(topic)
          if (this.helia && this.subscribedTopics.has(topic)) {
            this.helia.services.pubsub.unsubscribe(topic)
            this.subscribedTopics.delete(topic)
            console.log('PubSubService: Unsubscribed from topic:', topic)
          }
        }
      }
    }
  }

  /**
   * Publish a message to a topic
   */
  async publish(topic: string, message: object): Promise<void> {
    if (!this._isInitialized || !this.helia) {
      console.warn('PubSubService: Cannot publish - not initialized')
      return
    }

    try {
      const textEncoder = new TextEncoder()
      const data = textEncoder.encode(JSON.stringify(message))

      await this.helia.services.pubsub.publish(topic, data)

    } catch (error) {
      console.error('PubSubService: Failed to publish:', error)
      throw error
    }
  }

  /**
   * Get the number of peers subscribed to a topic
   */
  getTopicPeers(topic: string): number {
    if (!this._isInitialized || !this.helia) {
      return 0
    }

    try {
      const peers = this.helia.services.pubsub.getSubscribers(topic)
      return peers.length
    } catch {
      return 0
    }
  }

  /**
   * Get total connected peer count
   */
  getPeerCount(): number {
    if (!this._isInitialized || !this.helia) {
      return 0
    }

    return this.helia.getConnections().length
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this._isInitialized
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this._isInitialized && this.helia !== null
  }

  /**
   * Get the peer ID of this node
   */
  getPeerId(): string | null {
    if (!this.helia) {
      return null
    }
    return this.helia.peerId.toString()
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    console.log('PubSubService: Cleaning up...')

    // Unsubscribe from all topics
    if (this.helia) {
      Array.from(this.subscribedTopics).forEach(topic => {
        try {
          this.helia.services.pubsub.unsubscribe(topic)
        } catch (err) {
          console.error('PubSubService: Error unsubscribing from topic:', err)
        }
      })

      // Stop Helia (which stops libp2p)
      try {
        await this.helia.stop()
      } catch (err) {
        console.error('PubSubService: Error stopping Helia:', err)
      }
    }

    // Clear state
    this.helia = null
    this.initPromise = null
    this._isInitialized = false
    this._isInitializing = false
    this.config = null
    this.messageHandlers.clear()
    this.subscribedTopics.clear()
    this.messageTimestamps.clear()

    console.log('PubSubService: Cleanup complete')
  }
}

// Singleton instance
export const pubsubService = new PubSubService()
