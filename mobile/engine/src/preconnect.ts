import { DEVNET_NAME, DEVNET_QUORUM_URL, getConfiguredNetwork, type AppNetwork } from '@/lib/constants'

/**
 * The quorum service the SDK's trusted context reads first thing in
 * `connect()` (lib/services/evo-sdk-service.ts builds it the same way): the
 * configured URL on a devnet, else wasm-sdk's default for the network.
 */
export function quorumServiceOrigin(network: AppNetwork = getConfiguredNetwork()): string {
  if (network === 'devnet') return new URL(DEVNET_QUORUM_URL || `https://quorums.${DEVNET_NAME}.networks.dash.org`).origin
  return `https://quorums.${network}.networks.dash.org`
}

/**
 * Open the quorum service's connection (DNS, TCP, TLS) while the WASM still
 * compiles, so the SDK's first request does not pay for it at boot.
 * `crossorigin` matches the SDK's credential-less CORS fetch, which would
 * not reuse a credentialed connection.
 */
export function preconnectQuorumService(): void {
  const link = document.createElement('link')
  link.rel = 'preconnect'
  link.href = quorumServiceOrigin()
  link.crossOrigin = 'anonymous'
  document.head.appendChild(link)
}
