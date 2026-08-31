/**
 * IPFS Gateway Utilities
 *
 * Shared utilities for resolving ipfs:// protocol URLs to HTTP gateway URLs.
 * Used by avatar display, banner display, and link preview components.
 */

import { getContractTopology } from '../constants'
import { SESSION_STORAGE_KEY } from '../storage-scope'
import { getPinataGateway } from '../upload/providers/pinata/credential-storage'

/**
 * IPFS Gateway Configuration
 * These public gateways are used to resolve ipfs:// protocol URLs.
 * Gateways are tried in order until one succeeds.
 *
 * Two formats are supported:
 * - subdomain: https://CID.ipfs.dweb.link/path (better origin isolation)
 * - path: https://ipfs.io/ipfs/CID/path (traditional format)
 */
interface IpfsGateway {
  /** Base domain for the gateway */
  domain: string
  /** Gateway format: 'subdomain' or 'path' */
  format: 'subdomain' | 'path'
}

export const IPFS_GATEWAYS: IpfsGateway[] = [
  // Pinata first: uploads go through Pinata, so this is the only gateway
  // guaranteed to have fresh content (public gateways can take a while to
  // retrieve Pinata-pinned blocks). Serves ACAO: * with no CORP header.
  { domain: 'gateway.pinata.cloud', format: 'path' },
  // 4everland: independent backend from the IPFS Foundation gateways below
  { domain: 'ipfs.4everland.io', format: 'path' },
  // ipfs.io is the canonical IPFS Foundation gateway (aggressively
  // rate-limited by Cloudflare - bursts of image loads get 403s)
  { domain: 'ipfs.io', format: 'path' },
  // dweb.link subdomain gateway (same rainbow backend as ipfs.io)
  { domain: 'ipfs.dweb.link', format: 'subdomain' },
  // Note: cloudflare-ipfs.com deprecated Aug 2024
  // Note: nftstorage.link removed - now just 302-redirects to ipfs.io
  // Note: ipfs.w3s.link removed - now just 301-redirects to dweb.link
]

/**
 * Dedicated Pinata gateway domains for the currently logged-in identity only —
 * other identities' gateways must not receive requests for content this user
 * views. A dedicated gateway serves the account's own pinned content
 * immediately, long before public gateways can resolve a fresh CID; for
 * foreign content it 404s quickly, so it is cheap to try first.
 */
function getDedicatedGatewayDomains(): string[] {
  if (typeof window === 'undefined') return []

  try {
    const savedSession = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!savedSession) return []
    const identityId = (JSON.parse(savedSession) as { user?: { identityId?: unknown } }).user?.identityId
    if (typeof identityId !== 'string' || !identityId) return []

    const gateway = getPinataGateway(identityId)
    return gateway && /^[a-z0-9.-]+$/i.test(gateway) ? [gateway] : []
  } catch {
    // Storage unavailable or malformed session — fall back to public gateways.
    return []
  }
}

/**
 * Check if a URL uses the ipfs:// protocol.
 */
export function isIpfsProtocol(url: string): boolean {
  return url.toLowerCase().startsWith('ipfs://')
}

/**
 * Extract CID from an ipfs:// URL.
 * Handles formats like:
 * - ipfs://CID
 * - ipfs://CID/path/to/file
 */
export function extractCidFromIpfsUrl(url: string): { cid: string; path: string } | null {
  if (!isIpfsProtocol(url)) return null

  // Remove ipfs:// prefix
  const remainder = url.slice(7)
  if (!remainder) return null

  // Split into CID and optional path
  const slashIndex = remainder.indexOf('/')
  if (slashIndex === -1) {
    return { cid: remainder, path: '' }
  }

  return {
    cid: remainder.slice(0, slashIndex),
    path: remainder.slice(slashIndex),
  }
}

/**
 * Check if a CID is version 0 (starts with "Qm").
 * CIDv0 uses base58btc which is case-sensitive, making it incompatible
 * with subdomain gateways (DNS is case-insensitive).
 */
function isCidV0(cid: string): boolean {
  return cid.startsWith('Qm')
}

/**
 * Convert an HTTP(S) gateway URL back to its canonical ipfs:// form.
 * Handles both gateway shapes, from any host:
 * - path: https://<host>/ipfs/<CID>[/path]
 * - subdomain: https://<CID>.ipfs.<domain>[/path]
 *
 * @returns ipfs://CID[/path], or null if the URL is not a recognizable gateway URL
 */
export function gatewayUrlToIpfsUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null

    // Path gateway: /ipfs/<CID>[/path] on any host
    const pathMatch = parsed.pathname.match(/^\/ipfs\/([^/]+)(\/.*)?$/)
    if (pathMatch) {
      return `ipfs://${pathMatch[1]}${pathMatch[2] || ''}`
    }

    // Subdomain gateway: <CID>.ipfs.<domain>
    const hostMatch = parsed.hostname.match(/^([^.]+)\.ipfs\./i)
    if (hostMatch) {
      const path = parsed.pathname === '/' ? '' : parsed.pathname
      return `ipfs://${hostMatch[1]}${path}`
    }

    return null
  } catch {
    return null
  }
}

/**
 * Normalize a stored media URL to its canonical form for rendering.
 * IPFS content (whether stored as ipfs:// or as a gateway HTTPS URL) becomes
 * ipfs://CID so display components can apply multi-gateway failover.
 * Non-IPFS URLs pass through untouched.
 */
export function normalizeMediaUrl(url: string): string {
  if (isIpfsProtocol(url)) return url
  return gatewayUrlToIpfsUrl(url) ?? url
}

/**
 * Form of an IPFS media URL suitable for the active contract's mediaUrl field.
 * The v3 contract accepts ipfs:// natively; the immutable v2 contract requires
 * ^https?:// so IPFS content is stored as a primary-gateway URL there
 * (normalizeMediaUrl restores the ipfs:// form on read).
 */
export function mediaUrlForContract(url: string): string {
  if (!isIpfsProtocol(url)) return url
  return getContractTopology() === 'v3' ? url : ipfsToGatewayUrl(url)
}

/**
 * Build the gateway URL for a CID, or null when the gateway can't serve it
 * (CIDv0 is case-sensitive base58btc — incompatible with DNS subdomains).
 */
function gatewayUrlFor(gateway: IpfsGateway, cid: string, path: string): string | null {
  if (gateway.format === 'subdomain') {
    // Subdomain format: https://CID.ipfs.dweb.link/path
    return isCidV0(cid) ? null : `https://${cid}.${gateway.domain}${path}`
  }
  // Path format: https://ipfs.io/ipfs/CID/path
  return `https://${gateway.domain}/ipfs/${cid}${path}`
}

/**
 * Convert an ipfs:// URL to an HTTP gateway URL.
 * Uses the first compatible public gateway from the configured list
 * (deliberately excludes per-user dedicated gateways — this form is also
 * written into contract documents and must be stable across users).
 *
 * @param ipfsUrl - The ipfs:// URL to convert
 * @returns HTTP gateway URL, or the original URL if not a valid ipfs:// URL
 */
export function ipfsToGatewayUrl(ipfsUrl: string): string {
  const parsed = extractCidFromIpfsUrl(ipfsUrl)
  if (!parsed) return ipfsUrl

  for (const gateway of IPFS_GATEWAYS) {
    const url = gatewayUrlFor(gateway, parsed.cid, parsed.path)
    if (url) return url
  }

  // Fallback: use last gateway in path format
  const lastGateway = IPFS_GATEWAYS[IPFS_GATEWAYS.length - 1]
  return `https://${lastGateway.domain}/ipfs/${parsed.cid}${parsed.path}`
}

/**
 * Get all possible gateway URLs for an ipfs:// URL, the logged-in user's
 * dedicated gateway (if any) first.
 * Used for fallback when primary gateway fails (e.g., content not propagated yet).
 *
 * @param ipfsUrl - The ipfs:// URL to convert
 * @returns Array of HTTP gateway URLs to try in order
 */
export function getAllGatewayUrls(ipfsUrl: string): string[] {
  const parsed = extractCidFromIpfsUrl(ipfsUrl)
  if (!parsed) return [ipfsUrl]

  const gateways: IpfsGateway[] = [
    ...getDedicatedGatewayDomains().map((domain) => ({ domain, format: 'path' as const })),
    ...IPFS_GATEWAYS,
  ]

  const urls = gateways
    .map((gateway) => gatewayUrlFor(gateway, parsed.cid, parsed.path))
    .filter((url): url is string => url !== null)

  return urls.length > 0 ? urls : [ipfsUrl]
}

/**
 * Check if a URL points to IPFS content (either protocol or gateway URL).
 *
 * Matches:
 * - Protocol: ipfs:// URLs
 * - Subdomain gateways: hostname contains ".ipfs." (e.g., bafybeib.ipfs.dweb.link)
 * - Direct gateways: ipfs.io domain (e.g., gateway.ipfs.io, ipfs.io)
 * - Path gateways: path starts with /ipfs/ (e.g., https://gateway.pinata.cloud/ipfs/Qm...)
 */
export function isIpfsUrl(url: string): boolean {
  // Check for ipfs:// protocol first (before URL parsing which doesn't support it)
  if (isIpfsProtocol(url)) {
    return true
  }

  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()

    // Check for subdomain gateway pattern: *.ipfs.* (e.g., cid.ipfs.dweb.link)
    if (hostname.includes('.ipfs.')) {
      return true
    }

    // Check for ipfs.io domain specifically (e.g., ipfs.io, gateway.ipfs.io)
    if (hostname === 'ipfs.io' || hostname.endsWith('.ipfs.io')) {
      return true
    }

    // Check for path gateway pattern: /ipfs/ in the path
    if (pathname.startsWith('/ipfs/')) {
      return true
    }

    return false
  } catch {
    return false
  }
}
