/**
 * IPFS Gateway Utilities
 *
 * Shared utilities for resolving ipfs:// protocol URLs to HTTP gateway URLs.
 * Used by avatar display, banner display, and link preview components.
 */

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
  // ipfs.io is the canonical IPFS Foundation gateway
  { domain: 'ipfs.io', format: 'path' },
  // dweb.link subdomain gateway (IPFS Foundation)
  { domain: 'ipfs.dweb.link', format: 'subdomain' },
  // nftstorage.link (NFT.storage gateway)
  { domain: 'nftstorage.link', format: 'path' },
  // Note: w3s.link not functional
  // Note: cloudflare-ipfs.com deprecated Aug 2024
  // Note: gateway.pinata.cloud has CORS restrictions
]

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
function extractCidFromIpfsUrl(url: string): { cid: string; path: string } | null {
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
 * Convert an ipfs:// URL to an HTTP gateway URL.
 * Uses the first compatible gateway from the configured list.
 *
 * Note: CIDv0 (Qm...) is incompatible with subdomain gateways because
 * base58btc is case-sensitive but DNS is not. Falls back to path gateways.
 *
 * @param ipfsUrl - The ipfs:// URL to convert
 * @returns HTTP gateway URL, or the original URL if not a valid ipfs:// URL
 */
export function ipfsToGatewayUrl(ipfsUrl: string): string {
  const parsed = extractCidFromIpfsUrl(ipfsUrl)
  if (!parsed) return ipfsUrl

  // Try each gateway in order
  for (const gateway of IPFS_GATEWAYS) {
    if (gateway.format === 'subdomain') {
      // CIDv0 is case-sensitive (base58btc) - incompatible with DNS subdomains
      if (isCidV0(parsed.cid)) {
        continue // Skip this gateway, try next one
      }
      // Subdomain format: https://CID.ipfs.dweb.link/path
      return `https://${parsed.cid}.${gateway.domain}${parsed.path}`
    } else {
      // Path format: https://ipfs.io/ipfs/CID/path
      return `https://${gateway.domain}/ipfs/${parsed.cid}${parsed.path}`
    }
  }

  // Fallback: use last gateway in path format
  const lastGateway = IPFS_GATEWAYS[IPFS_GATEWAYS.length - 1]
  return `https://${lastGateway.domain}/ipfs/${parsed.cid}${parsed.path}`
}

/**
 * Get all possible gateway URLs for an ipfs:// URL.
 * Used for fallback when primary gateway fails (e.g., content not propagated yet).
 *
 * @param ipfsUrl - The ipfs:// URL to convert
 * @returns Array of HTTP gateway URLs to try in order
 */
export function getAllGatewayUrls(ipfsUrl: string): string[] {
  const parsed = extractCidFromIpfsUrl(ipfsUrl)
  if (!parsed) return [ipfsUrl]

  const urls: string[] = []

  for (const gateway of IPFS_GATEWAYS) {
    if (gateway.format === 'subdomain') {
      // CIDv0 is case-sensitive (base58btc) - incompatible with DNS subdomains
      if (isCidV0(parsed.cid)) {
        continue
      }
      urls.push(`https://${parsed.cid}.${gateway.domain}${parsed.path}`)
    } else {
      urls.push(`https://${gateway.domain}/ipfs/${parsed.cid}${parsed.path}`)
    }
  }

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
