/**
 * The rule every image, video and link-preview renderer follows, on web and
 * on mobile (re-exported through mobile/app/src/lib-allowlist.ts):
 *
 * - media on the takedown denylist (./media-denylist.json, by IPFS CID or by
 *   the sha256 of an https URL) is never loaded;
 * - IPFS content is loaded from the IPFS gateways;
 * - any other https image is loaded through the wsrv.nl image proxy, so the
 *   viewer's IP address never reaches the host a post, profile or store
 *   names. wsrv.nl fetches anonymously and re-encodes, which also drops
 *   whatever metadata the original carried;
 * - anything else (plain http, other schemes) is not loaded at all.
 *
 * Pure: regexes instead of `URL` (Hermes's `URL` is incomplete), no browser
 * globals, no env. Keep it that way; the mobile app imports it.
 */

import denylist from './media-denylist.json'

export const IMAGE_PROXY_ORIGIN = 'https://wsrv.nl'

/**
 * Widths asked of the proxy, in device pixels. `we` (without enlargement)
 * keeps smaller originals at their own size.
 */
const PROXY_WIDTHS = {
  avatar: 256,
  thumbnail: 640,
  full: 1600,
} as const

export type ProxyImageSize = keyof typeof PROXY_WIDTHS

/**
 * The wsrv.nl URL for an https image: resized to `size`, every frame kept
 * (`n=-1`, so GIFs stay animated) and served as WebP. No cache-busting
 * parameters: one URL per image keeps wsrv's cache and the browser's warm.
 */
export function proxiedImageUrl(url: string, size: ProxyImageSize = 'full'): string {
  return `${IMAGE_PROXY_ORIGIN}/?url=${encodeURIComponent(url)}&w=${PROXY_WIDTHS[size]}&we&n=-1&output=webp`
}

/** `ipfs://CID…`, a subdomain gateway `https://CID.ipfs.host…`, a path gateway `https://host/ipfs/CID…`. */
const IPFS_REFERENCES = [
  /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)([^?#]*)/i,
  // The host's CID is the root: on a subdomain gateway `/ipfs/X/…` is a path inside it.
  /^https?:\/\/([^./?#]+)\.ipfs\.[^/?#]+([^?#]*)/i,
  /^https?:\/\/[^/?#]+\/ipfs\/([^/?#]+)([^?#]*)/i,
]

/**
 * The two CID spellings Yappr writes and the denylist holds: CIDv0 (`Qm…`,
 * base58btc, case-sensitive) and CIDv1 in base32 (`b…`, case-insensitive).
 */
const CANONICAL_CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/i
/** Any other multibase spelling (`z…`, `f…`, `k…`) of a CID: long and alphanumeric. */
const OTHER_CID = /^[0-9a-z]{40,}$/i

/**
 * A path that could leave its CID once a browser or gateway normalizes it:
 * a `.` or `..` segment (literal or percent-encoded), or an encoded or
 * backslash separator. `ipfs://A/../B` would load B while A is checked.
 */
const ESCAPING_PATH = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%2f|%5c|\\/i

/** An http(s) URL whose authority carries `user[:pass]@`. */
const USERINFO = /^https?:\/\/[^/?#\\]*@/i

type IpfsReference = { cid: string; path: string } | 'refused'

/**
 * What an IPFS-shaped URL names: a CID in a spelling the denylist can match
 * and its path (query and fragment dropped); `'refused'` for a CID written
 * any other way or a path that could escape the CID (so neither can slip past
 * the denylist); null when the URL isn't an IPFS reference
 * (`https://docs.ipfs.tech/` is a website).
 */
function ipfsReferenceOf(url: string): IpfsReference | null {
  const trimmed = url.trim()
  // Userinfo (`a@b`) makes the authority ambiguous to a pattern: refuse it
  // outright. Yappr never writes credentials into a media URL.
  if (USERINFO.test(trimmed)) return 'refused'
  for (const pattern of IPFS_REFERENCES) {
    const match = pattern.exec(trimmed)
    if (!match) continue
    if (CANONICAL_CID.test(match[1])) return ESCAPING_PATH.test(match[2]) ? 'refused' : { cid: match[1], path: match[2] }
    if (/^ipfs:/i.test(trimmed) || OTHER_CID.test(match[1]) || match[1].includes('%')) return 'refused'
  }
  // Where the request really goes, once the browser and the gateway have
  // decoded it and resolved `.`/`..` (`https://ipfs.io/x/../ipfs/CID`,
  // `/%69pfs/CID`, `/ipfs/%62afy…`): if that is IPFS content, refuse it.
  // Yappr never writes such URLs, so only a way around the denylist would.
  const destination = effectiveDestination(trimmed)
  return destination !== trimmed && ipfsReferenceOf(destination) !== null ? 'refused' : null
}

/**
 * An http(s) URL as the server ends up routing it: percent-decoded,
 * backslashes as slashes, any `user:pass@` dropped from the authority, `.`
 * and `..` segments resolved; query and fragment dropped. Anything else is
 * returned unchanged.
 */
function effectiveDestination(url: string): string {
  const match = /^(https?:\/\/)([^?#]*)/i.exec(url)
  if (!match) return url
  const [authority, ...segments] = percentDecoded(match[2]).replace(/\\/g, '/').split('/')
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  const path: string[] = []
  for (const segment of segments) {
    if (segment === '..') path.pop()
    else if (segment !== '.') path.push(segment)
  }
  return `${match[1]}${[host, ...path].join('/')}`
}

function percentDecoded(url: string): string {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

/** The CID an IPFS reference names, in a spelling the denylist can match; null otherwise. */
export function ipfsCidOf(url: string): string | null {
  const reference = ipfsReferenceOf(url)
  return reference && reference !== 'refused' ? reference.cid : null
}

/** CIDv1 in base32 is case-insensitive, and subdomain gateways lowercase it anyway. */
function canonicalCid(cid: string): string {
  return cid.startsWith('Qm') ? cid : cid.toLowerCase()
}

/**
 * The form of an https URL whose sha256 the denylist stores: trimmed, scheme
 * and host lowercased, fragment dropped. Null when the URL is not https.
 * scripts/media-denylist.mjs must produce the same form (a test holds them
 * together).
 */
export function canonicalHttpsUrl(url: string): string | null {
  const match = /^https:\/\/([^/?#]+)([^#]*)/i.exec(url.trim())
  return match ? `https://${match[1].toLowerCase()}${match[2]}` : null
}

/** The shape scripts/media-denylist.mjs writes; `added` and `ref` are for the audit trail. */
interface MediaDenylist {
  cids: { cid: string; added: string; ref: string }[]
  urlSha256: { sha256: string; added: string; ref: string }[]
}

const entries: MediaDenylist = denylist
const deniedCids = new Set(entries.cids.map((entry) => canonicalCid(entry.cid)))
const deniedUrlHashes = new Set(entries.urlSha256.map((entry) => entry.sha256.toLowerCase()))

/**
 * Whether a URL is on the takedown denylist, by its CID or by its sha256. An
 * IPFS reference the list can't vouch for (another CID spelling, a path that
 * could escape its CID) counts as denied: Yappr never writes one, so only a
 * way around the list would.
 */
export function isDeniedMedia(url: string): boolean {
  const reference = ipfsReferenceOf(url)
  if (reference === 'refused') return true
  if (reference) return deniedCids.has(canonicalCid(reference.cid))
  if (deniedUrlHashes.size === 0) return false
  const canonical = canonicalHttpsUrl(url)
  return canonical !== null && deniedUrlHashes.has(sha256Hex(canonical))
}

export type ImageSource =
  /** IPFS content: the caller picks gateways for `ipfsUrl`. */
  | { kind: 'ipfs'; ipfsUrl: string }
  /** Any other https image, through the proxy. */
  | { kind: 'proxied'; url: string }
  /** Inline (`data:image/`, `blob:`) or same-origin (`/…`) images, loaded as they are. */
  | { kind: 'local'; url: string }
  /** On the takedown denylist. */
  | { kind: 'denied' }
  /** Nothing loadable: empty, plain http or any other scheme. */
  | { kind: 'none' }

/** `/x` but not `//host` or `/\\host`, which browsers send to another host. */
const LOCAL_IMAGE = /^(data:image\/|blob:|\/(?![/\\]))/i
/** Browsers drop tabs and newlines from URLs, so `/\t/host` is `//host`: refuse control characters outright. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

/** How an image URL may be loaded; see the module comment. */
export function imageSourceFor(url: string | null | undefined, size: ProxyImageSize = 'full'): ImageSource {
  const trimmed = url?.trim()
  if (!trimmed || CONTROL_CHARACTER.test(trimmed)) return { kind: 'none' }
  if (LOCAL_IMAGE.test(trimmed)) return { kind: 'local', url: trimmed }
  if (isDeniedMedia(trimmed)) return { kind: 'denied' }
  const reference = ipfsReferenceOf(trimmed)
  if (reference && reference !== 'refused') {
    return { kind: 'ipfs', ipfsUrl: `ipfs://${reference.cid}${reference.path}` }
  }
  if (/^https:\/\//i.test(trimmed)) return { kind: 'proxied', url: proxiedImageUrl(trimmed, size) }
  return { kind: 'none' }
}

// --- sha256 (FIPS 180-4), synchronous and dependency-free ------------------
// WebCrypto is async and absent on Hermes, and renderers decide synchronously.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** Lowercase hex sha256 of a string's UTF-8 bytes. */
export function sha256Hex(text: string): string {
  const message = new TextEncoder().encode(text)
  const bitLength = message.length * 8
  const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64)
  padded.set(message)
  padded[message.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] += a
    h[1] += b
    h[2] += c
    h[3] += d
    h[4] += e
    h[5] += f
    h[6] += g
    h[7] += hh
  }
  return Array.from(h, (word) => word.toString(16).padStart(8, '0')).join('')
}
