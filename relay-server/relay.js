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
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import fs from 'fs'
import path from 'path'

// Configuration
const CONFIG = {
  // Port for WebSocket connections (browsers connect here via CF proxy)
  wsPort: process.env.WS_PORT || 8080,

  // Optional TCP port for server-to-server connections
  tcpPort: process.env.TCP_PORT || 9000,

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
 * Load or generate a persistent peer ID
 */
async function loadOrCreatePeerId() {
  const keyPath = path.resolve(CONFIG.keyPath)

  if (fs.existsSync(keyPath)) {
    console.log('Loading existing peer identity...')
    const keyData = fs.readFileSync(keyPath)
    const privateKey = privateKeyFromRaw(keyData)
    return peerIdFromPrivateKey(privateKey)
  }

  console.log('Generating new peer identity...')
  const privateKey = await generateKeyPair('Ed25519')
  fs.writeFileSync(keyPath, Buffer.from(privateKey.raw))
  fs.chmodSync(keyPath, 0o600) // Secure permissions

  return peerIdFromPrivateKey(privateKey)
}

/**
 * Start the relay server
 */
async function startRelay() {
  console.log('Starting Yappr Relay Server...\n')

  // Load persistent identity
  const peerId = await loadOrCreatePeerId()
  console.log('Peer ID:', peerId.toString())
  console.log('')

  // Build announce addresses (external addresses browsers should connect to)
  const announceAddrs = []
  if (CONFIG.externalDomain) {
    announceAddrs.push(`/dns4/${CONFIG.externalDomain}/tcp/443/wss`)
  }

  // Create libp2p node
  const node = await createLibp2p({
    peerId,
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${CONFIG.wsPort}/ws`,   // WebSocket for browsers
        `/ip4/0.0.0.0/tcp/${CONFIG.tcpPort}`,     // TCP for other relays
      ],
      announce: announceAddrs.length > 0 ? announceAddrs : undefined,
    },
    transports: [
      tcp(),
      webSockets(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      relay: circuitRelayServer({
        reservations: {
          maxReservations: 1000,
          reservationTtl: 300000, // 5 minutes
        },
      }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
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

  // Log peer events
  node.addEventListener('peer:connect', (event) => {
    console.log('Peer connected:', event.detail.toString())
  })

  node.addEventListener('peer:disconnect', (event) => {
    console.log('Peer disconnected:', event.detail.toString())
  })

  // Log pubsub messages (for debugging)
  node.services.pubsub.addEventListener('message', (event) => {
    const topic = event.detail.topic
    const from = event.detail.from?.toString().slice(0, 16) + '...'
    console.log(`Message on ${topic} from ${from}`)
  })

  // Log subscription changes
  node.services.pubsub.addEventListener('subscription-change', (event) => {
    const { peerId, subscriptions } = event.detail
    console.log(`Subscription change from ${peerId.toString().slice(0, 20)}:`)
    subscriptions.forEach(sub => {
      console.log(`  ${sub.subscribe ? 'SUBSCRIBE' : 'UNSUBSCRIBE'}: ${sub.topic}`)
    })
  })

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

    console.log(`[Stats] Connections: ${connections.length}, PubsubPeers: ${pubsubPeers.length}, Topics: ${JSON.stringify(topicPeers)}`)
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
