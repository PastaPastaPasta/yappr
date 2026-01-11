#!/usr/bin/env node
/**
 * Yappr Relay Server
 *
 * A libp2p relay node that enables browser-to-browser communication
 * for the Yappr presence system via Gossipsub.
 *
 * Run behind Cloudflare reverse proxy:
 *   - Internal: ws://localhost:8080
 *   - External: wss://relay.yourdomain.com
 */

import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@libp2p/gossipsub'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { fetch } from '@libp2p/fetch'
import { kadDHT } from '@libp2p/kad-dht'
import { bootstrap } from '@libp2p/bootstrap'
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import fs from 'fs'
import path from 'path'

// Yappr relay bootstrap nodes (WSS - works through CF Tunnel)
// New relays connect to these to join the DHT network
// Override with BOOTSTRAP_RELAYS env var (comma-separated multiaddrs)
// Set BOOTSTRAP_RELAYS="" for the first/seed relay
const YAPPR_RELAY_BOOTSTRAP = process.env.BOOTSTRAP_RELAYS !== undefined
  ? process.env.BOOTSTRAP_RELAYS.split(',').filter(s => s.trim())
  : [
    '/dns4/yappr-relay.thepasta.org/tcp/443/wss/p2p/12D3KooWNMPUNGUmb6gDW8TCs61kZjBBAt75CXc5UzdAEQ3yaowF',
  ]

/**
 * Generate a deterministic CID for yappr relay network discovery
 * All yappr relays provide this CID to advertise themselves in the DHT
 */
async function getRelayNetworkCID() {
  const bytes = new TextEncoder().encode('yappr-relay-network-v1')
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash) // 0x55 = raw codec
}

// Configuration
const CONFIG = {
  // Port for WebSocket connections (browsers + relays connect here via CF proxy)
  wsPort: process.env.WS_PORT || 8080,

  // External address to announce (behind Cloudflare)
  // Set EXTERNAL_DOMAIN to your Cloudflare domain
  externalDomain: process.env.EXTERNAL_DOMAIN || null,

  // Path to store the persistent key
  keyPath: process.env.KEY_PATH || './relay-key.bin',

  // Yappr pubsub topics to subscribe to (enables message relay)
  topics: [
    'yappr/presence/v1/global',
    // Add typing topics as wildcard isn't supported -
    // clients will need to connect to each other for DM typing
  ],
}

/**
 * Load or generate a persistent private key (libp2p v3 API)
 */
async function loadOrCreatePrivateKey() {
  const keyPath = path.resolve(CONFIG.keyPath)

  if (fs.existsSync(keyPath)) {
    console.log('Loading existing peer identity...')
    const keyData = fs.readFileSync(keyPath)
    return privateKeyFromRaw(keyData)
  }

  console.log('Generating new peer identity...')
  const privateKey = await generateKeyPair('Ed25519')
  fs.writeFileSync(keyPath, Buffer.from(privateKey.raw))
  fs.chmodSync(keyPath, 0o600) // Secure permissions

  return privateKey
}

/**
 * Start the relay server
 */
async function startRelay() {
  console.log('Starting Yappr Relay Server...\n')

  // Load persistent identity (libp2p v3 uses privateKey)
  const privateKey = await loadOrCreatePrivateKey()
  const peerId = peerIdFromPrivateKey(privateKey)
  console.log('Peer ID:', peerId.toString())
  console.log('')

  // Build announce addresses (external addresses for discovery)
  const announceAddrs = []
  if (CONFIG.externalDomain) {
    // WSS for browsers and relay-to-relay (via Cloudflare Tunnel)
    announceAddrs.push(`/dns4/${CONFIG.externalDomain}/tcp/443/wss`)
  }

  // Create libp2p node
  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${CONFIG.wsPort}/ws`,   // WebSocket for browsers + relay-to-relay
      ],
      announce: announceAddrs.length > 0 ? announceAddrs : undefined,
    },
    transports: [
      tcp(),
      webSockets(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: YAPPR_RELAY_BOOTSTRAP.length > 0 ? [
      bootstrap({ list: YAPPR_RELAY_BOOTSTRAP }),
    ] : [],
    services: {
      identify: identify(),
      ping: ping(),
      fetch: fetch(),
      relay: circuitRelayServer({
        reservations: {
          maxReservations: 1000,
          reservationTtl: 300000, // 5 minutes
        },
      }),
      dht: kadDHT({
        clientMode: false,  // Server mode - full DHT participation
      }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        floodPublish: true,  // Forward messages to ALL connected peers
        runOnLimitedConnection: true,  // Allow on relay connections
        // More lenient settings for relay
        heartbeatInterval: 1000,
        doPX: true, // Enable peer exchange
      }),
    },
    connectionManager: {
      maxConnections: 1000,
      minConnections: 0,
    },
  })

  // Subscribe to Yappr topics
  for (const topic of CONFIG.topics) {
    node.services.pubsub.subscribe(topic)
    console.log('Subscribed to topic:', topic)
  }

  // ========== Presence Cache for Fetch Queries ==========
  const PRESENCE_CACHE_TTL = 5 * 60 * 1000  // 5 minutes
  const presenceCache = new Map()  // userId → { status, lastSeen, publicKey }

  // Register fetch handler for /presence/{id1},{id2},...
  node.services.fetch.registerLookupFunction('/presence/', async (key) => {
    // key = "/presence/ABC123" or "/presence/ABC123,DEF456,GHI789"
    const idsStr = key.replace('/presence/', '')
    const userIds = idsStr.split(',').map(id => id.trim()).filter(id => id)

    if (userIds.length === 0) {
      return null
    }

    const now = Date.now()
    const result = {}

    for (const userId of userIds) {
      const entry = presenceCache.get(userId)
      if (entry && (now - entry.lastSeen) < PRESENCE_CACHE_TTL) {
        result[userId] = {
          status: entry.status,
          lastSeen: entry.lastSeen,
        }
      } else {
        result[userId] = null
      }
    }

    console.log(`Fetch: /presence/ query for ${userIds.length} users, found ${Object.values(result).filter(v => v !== null).length}`)
    return new TextEncoder().encode(JSON.stringify(result))
  })

  console.log('Fetch: Registered /presence/ handler')

  // Log peer events
  node.addEventListener('peer:connect', (event) => {
    console.log('Peer connected:', event.detail.toString())
  })

  node.addEventListener('peer:disconnect', (event) => {
    console.log('Peer disconnected:', event.detail.toString())
  })

  // Handle pubsub messages - cache presence for fetch queries
  node.services.pubsub.addEventListener('message', (event) => {
    const topic = event.detail.topic
    const from = event.detail.from?.toString().slice(0, 16) + '...'
    console.log(`Message on ${topic} from ${from}`)

    // Cache presence messages
    if (topic === 'yappr/presence/v1/global') {
      try {
        const data = JSON.parse(new TextDecoder().decode(event.detail.data))
        if (data.type === 'presence' && data.userId) {
          presenceCache.set(data.userId, {
            status: data.status || 'online',
            lastSeen: data.timestamp || Date.now(),
            publicKey: data.publicKey || null,
          })
        }
      } catch (err) {
        // Ignore parse errors
      }
    }
  })

  // Log subscription changes
  node.services.pubsub.addEventListener('subscription-change', (event) => {
    const { peerId, subscriptions } = event.detail
    console.log(`Subscription change from ${peerId.toString().slice(0, 20)}:`)
    subscriptions.forEach(sub => {
      console.log(`  ${sub.subscribe ? 'SUBSCRIBE' : 'UNSUBSCRIBE'}: ${sub.topic}`)
    })
  })

  // ========== DHT Relay Discovery ==========
  const relayNetworkCID = await getRelayNetworkCID()
  console.log('\n--- DHT Relay Discovery ---')
  console.log('Relay Network CID:', relayNetworkCID.toString())
  console.log('Bootstrap relays:', YAPPR_RELAY_BOOTSTRAP.length)
  console.log('DHT works over WebSocket - no public TCP port required')
  console.log('---------------------------')

  // Track discovered relays
  const knownRelays = new Set()

  // Provide our CID to advertise as a yappr relay
  async function advertiseAsRelay() {
    try {
      console.log('DHT: Attempting to advertise...')
      await node.contentRouting.provide(relayNetworkCID, { signal: AbortSignal.timeout(30000) })
      console.log('DHT: Advertised as yappr relay')
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        console.log('DHT: Advertise timed out (normal if behind NAT)')
      } else {
        console.error('DHT: Failed to advertise:', err.message)
      }
    }
  }

  // Discover and connect to other yappr relays
  async function discoverRelays() {
    console.log('DHT: Searching for other yappr relays...')
    try {
      for await (const provider of node.contentRouting.findProviders(relayNetworkCID, { signal: AbortSignal.timeout(30000) })) {
        const providerId = provider.id.toString()
        if (providerId === peerId.toString()) continue // Skip self
        if (knownRelays.has(providerId)) continue // Already known

        knownRelays.add(providerId)
        console.log('DHT: Discovered relay:', providerId.slice(0, 20) + '...')

        // Try to connect
        try {
          await node.dial(provider.id)
          console.log('DHT: Connected to relay:', providerId.slice(0, 20) + '...')
        } catch (dialErr) {
          console.log('DHT: Could not connect to relay:', providerId.slice(0, 20), '-', dialErr.message)
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('DHT: Discovery error:', err.message)
      }
    }
    console.log('DHT: Discovery complete. Known relays:', knownRelays.size)
  }

  // Start DHT operations after a delay (let bootstrap connections establish)
  setTimeout(async () => {
    console.log('DHT: Starting DHT operations...')
    await advertiseAsRelay()
    await discoverRelays()

    // Periodically refresh advertisement and discover new relays
    setInterval(advertiseAsRelay, 4 * 60 * 60 * 1000) // Every 4 hours
    setInterval(discoverRelays, 30 * 60 * 1000) // Every 30 minutes
  }, 5000) // Wait 5s for bootstrap connections

  // Print listening addresses
  console.log('\nRelay listening on:')
  node.getMultiaddrs().forEach(ma => {
    console.log(' ', ma.toString())
  })

  // Print the address to use in the app
  const wsAddrs = node.getMultiaddrs().filter(ma => ma.toString().includes('/ws'))
  if (wsAddrs.length > 0) {
    console.log('\n--- Add this to your app ---')
    console.log('For local testing:')
    console.log(`  /ip4/127.0.0.1/tcp/${CONFIG.wsPort}/ws/p2p/${peerId.toString()}`)
    console.log('\nFor production (behind Cloudflare):')
    console.log(`  /dns4/YOUR_DOMAIN/tcp/443/wss/p2p/${peerId.toString()}`)
    console.log('----------------------------\n')
  }

  // Stats logging
  setInterval(() => {
    const connections = node.getConnections()
    const topics = node.services.pubsub.getTopics()
    const pubsubPeers = node.services.pubsub.getPeers()

    let topicPeers = {}
    for (const topic of topics) {
      const subscribers = node.services.pubsub.getSubscribers(topic)
      topicPeers[topic] = subscribers.length
      if (subscribers.length > 0) {
        console.log(`  Subscribers to ${topic}:`, subscribers.map(p => p.toString().slice(0, 20)))
      }
    }

    console.log(`[Stats] Connections: ${connections.length}, PubsubPeers: ${pubsubPeers.length}, PresenceCache: ${presenceCache.size}, Topics: ${JSON.stringify(topicPeers)}`)
    if (pubsubPeers.length > 0) {
      console.log('  Pubsub peers:', pubsubPeers.map(p => p.toString().slice(0, 20)))
    }
  }, 30000)

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...')
    await node.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log('Relay server is running. Press Ctrl+C to stop.\n')
}

// Start the server
startRelay().catch(err => {
  console.error('Failed to start relay:', err)
  process.exit(1)
})
