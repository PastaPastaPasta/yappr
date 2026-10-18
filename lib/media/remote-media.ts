/**
 * The rule every image, video and link-preview renderer follows, on web and
 * on mobile (re-exported through mobile/app/src/lib-allowlist.ts):
 *
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
const IPFS_PROTOCOL = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)([^?#]*)/i
const SUBDOMAIN_GATEWAY = /^https?:\/\/([^./?#]+)\.ipfs\.[^/?#]+([^?#]*)/i
const PATH_GATEWAY = /^https?:\/\/[^/?#]+\/ipfs\/([^/?#]+)([^?#]*)/i
/** IPNS names are mutable; only immutable IPFS references are supported. */
const IPNS = /^ipns:|^https?:\/\/(?:[^/?#]+\/ipns\/|[^./?#]+\.ipns\.)/i

/**
 * The two CID spellings Yappr writes: CIDv0 (`Qm…`,
 * base58btc, case-sensitive) and CIDv1 in base32 (`b…`, case-insensitive).
 */
const CANONICAL_CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/i

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Big-endian bytes of a base58btc string (no BigInt: plain byte arithmetic, fine on Hermes). */
function base58Bytes(text: string): number[] {
  const bytes: number[] = []
  for (const char of text) {
    let carry = BASE58_ALPHABET.indexOf(char)
    for (let i = bytes.length - 1; i >= 0; i--) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.unshift(carry & 0xff)
      carry >>= 8
    }
  }
  return bytes
}

/** The bytes of an unpadded lowercase base32 string. */
function base32Bytes(text: string): number[] {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    buffer = ((buffer << 5) | BASE32_ALPHABET.indexOf(char)) & 0xffff
    bits += 5
    if (bits >= 8) {
      bytes.push((buffer >> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return bytes
}

/**
 * A CID in one of the two spellings Yappr writes, encoded canonically and
 * decoding to what it claims, so no other string can name the same content:
 * - `Qm…` must decode to a CIDv0, a 34-byte sha2-256 multihash;
 * - `b…` must leave base32's unused trailing bits zero (decoders ignore them,
 *   so `…a` and `…b` could name the same bytes) and decode to a CIDv1:
 *   version 1, a codec and a multihash whose digest fills the rest exactly.
 *   (A base32 string of CIDv0 bytes, `bciq…`, is refused: gateways accept it
 *   for the same content as `Qm…`.)
 */
function isCanonicalCid(cid: string): boolean {
  if (!CANONICAL_CID.test(cid)) return false
  if (cid.startsWith('Qm')) {
    const bytes = base58Bytes(cid)
    return bytes.length === 34 && bytes[0] === 0x12 && bytes[1] === 0x20
  }
  const lower = cid.toLowerCase()
  const unusedBits = ((lower.length - 1) * 5) % 8
  const last = BASE32_ALPHABET.indexOf(lower[lower.length - 1])
  if (unusedBits >= 5 || (last & ((1 << unusedBits) - 1)) !== 0) return false
  const bytes = base32Bytes(lower.slice(1))
  let pos = 0
  const varint = (): number => {
    let value = 0
    for (let shift = 0; shift < 63 && pos < bytes.length; shift += 7) {
      const byte = bytes[pos++]
      value += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) return value
    }
    return -1
  }
  if (varint() !== 1 || varint() < 0 || varint() < 0) return false
  const digestLength = varint()
  return digestLength > 0 && pos + digestLength === bytes.length
}
/**
 * A subdomain gateway's label in another DNS-safe multibase (`k…` base36,
 * `f…` base16): long and alphanumeric. Shorter labels (`docs.ipfs.tech`)
 * are ordinary websites.
 */
const OTHER_SUBDOMAIN_CID = /^[0-9a-z]{40,}$/i

/**
 * A path that could leave its CID once a browser or gateway normalizes it:
 * a `.` or `..` segment (literal or percent-encoded), or an encoded or
 * backslash separator. `ipfs://A/../B` would load B while A is checked.
 */
const ESCAPING_PATH = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%2f|%5c|\\/i

/**
 * The only http(s) shape whose host a pattern reads exactly as a browser
 * will: `scheme://`, a plain ASCII hostname, an optional port, then `/`, `?`,
 * `#` or the end. Anything else (userinfo, escapes, non-ASCII that hostname
 * processing maps to ASCII, backslashes or extra slashes before the host…)
 * could route somewhere a pattern doesn't see, and Yappr never writes it.
 */
/**
 * Characters no usable URL holds: controls, which browsers drop or reject,
 * and unpaired surrogates, which can't be encoded (encodeURIComponent throws).
 * In `u` mode a properly paired surrogate is one code point and doesn't match.
 */
const CONTROL = /[\u0000-\u001f\u007f]|[\uD800-\uDFFF]/u
const PLAIN_HTTP_AUTHORITY = /^https?:\/\/([a-z0-9.-]+)(?::\d+)?(?:[/?#]|$)/i
/**
 * A dotted-decimal IPv4 host as browsers print it. Other spellings of an IPv4
 * address (`16843009`, `0x1.1.1.1`, `01.1.1.1`) name the same server but
 * are ambiguous, so a host whose last label is numeric must use this form.
 */
const CANONICAL_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const IPV4_SHAPED = /(?:^|\.)(?:0x[0-9a-f]*|\d+)\.?$/i

/** Whether an http(s) URL has the one host shape this module reads exactly as a browser does. */
function hasPlainAuthority(url: string): boolean {
  const host = PLAIN_HTTP_AUTHORITY.exec(url)?.[1]
  return host !== undefined && (!IPV4_SHAPED.test(host) || CANONICAL_IPV4.test(host))
}


type IpfsReference = { cid: string; path: string } | 'refused'

/**
 * What an IPFS-shaped URL names: a canonical CID and its path (query and
 * fragment dropped); `'refused'` for another CID spelling or a path that could
 * escape the CID; null for non-IPFS URLs (`https://docs.ipfs.tech/` is a website).
 */
/**
 * Bounds on the work one untrusted URL may cost: its length (contract media
 * fields hold 512 characters; blog content is the only longer source), and
 * how many layers of escaping are peeled to find where it really goes. A real
 * URL needs one or two; past the bound it fails closed.
 */
const MAX_URL_LENGTH = 2048
const MAX_NORMALIZATION_ROUNDS = 3

function ipfsReferenceOf(url: string, round = 0): IpfsReference | null {
  const trimmed = url.trim()
  // Browsers drop tabs and newlines anywhere in a URL (`i\tpfs` is `ipfs`), and
  // Yappr never writes control characters: refuse them before classifying.
  if (trimmed.length > MAX_URL_LENGTH || CONTROL.test(trimmed) || (/^https?:/i.test(trimmed) && !hasPlainAuthority(trimmed)) || IPNS.test(trimmed)) return 'refused'
  // The host's CID is the root: on a subdomain gateway `/ipfs/X/…` is a path inside it.
  const subdomain = SUBDOMAIN_GATEWAY.exec(trimmed)
  if (subdomain && (CANONICAL_CID.test(subdomain[1]) || OTHER_SUBDOMAIN_CID.test(subdomain[1]))) {
    return referenceTo(subdomain[1], subdomain[2])
  }
  // After `ipfs://` and a path gateway's `/ipfs/` only a CID can follow, so
  // anything but the two spellings Yappr writes (base64url `u…`, `z…`,
  // percent-escapes…) is refused rather than guessed at.
  const pathRef = IPFS_PROTOCOL.exec(trimmed) ?? PATH_GATEWAY.exec(trimmed)
  if (pathRef) return referenceTo(pathRef[1], pathRef[2])
  // Where the request really goes, once the browser and the gateway have
  // decoded it and resolved `.`/`..` (`https://ipfs.io/x/../ipfs/CID`,
  // `/%69pfs/CID`, `/ipfs/%62afy…`): if that is IPFS content, refuse it.
  // Keep gateway routing unambiguous by requiring the explicit IPFS forms.
  const destination = effectiveDestination(trimmed)
  if (destination === trimmed) return null
  if (round >= MAX_NORMALIZATION_ROUNDS) return 'refused'
  return ipfsReferenceOf(destination, round + 1) !== null ? 'refused' : null
}

function referenceTo(cid: string, path: string): IpfsReference {
  return isCanonicalCid(cid) && !ESCAPING_PATH.test(path) ? { cid, path } : 'refused'
}

/**
 * An http(s) URL as the server ends up routing it: percent-decoded,
 * backslashes as slashes, any `user:pass@` dropped from the authority,
 * repeated slashes collapsed, `.` and `..` segments resolved; query and
 * fragment dropped. Anything else is
 * returned unchanged.
 */
function effectiveDestination(url: string): string {
  const match = /^(https?:\/\/)([^?#]*)/i.exec(url)
  if (!match) return url
  // Decoded, then split again, since a decoded `%2F` is a separator too.
  const [authority, ...segments] = match[2].replace(/\\/g, '/').split('/').map(percentDecoded).join('/').replace(/\\/g, '/').split('/')
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  const path: string[] = []
  // Repeated slashes collapse too, as gateways clean the path (Go's path.Clean).
  segments.forEach((segment, index) => {
    if (segment === '..') path.pop()
    else if (segment !== '.' && (segment !== '' || index === segments.length - 1)) path.push(segment)
  })
  return `${match[1]}${[host, ...path].join('/')}`
}

/**
 * Every `%XX` as the byte it names, as a server's unescaping does (Go's
 * included), whether or not the bytes are valid UTF-8: one malformed
 * sequence can't keep the escapes around it (`%2F`) encoded. Bytes above
 * 0x7F come out as Latin-1 characters, which no URL pattern here matches.
 */
function percentDecoded(url: string): string {
  return url.replace(/%([0-9a-f]{2})/gi, (escape, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/** The canonical CID an IPFS reference names; null otherwise. */
export function ipfsCidOf(url: string): string | null {
  const reference = ipfsReferenceOf(url)
  return reference && reference !== 'refused' ? reference.cid : null
}

/**
 * An https URL spelled the way a browser requests it: host lowercased
 * without a trailing dot, the default port dropped, an empty path as `/`,
 * `.`/`..` segments resolved (also `%2e` and backslash forms), path and
 * query percent-encoded as a browser sends them (`café` as `caf%C3%A9`, a
 * space as `%20`), fragment dropped. `?a=1` and `?a=2` still differ. Null
 * when the URL isn't https in a plain `scheme://host` shape (those are
 * refused anyway).
 */
export function canonicalHttpsUrl(url: string): string | null {
  // Browsers drop tabs and newlines anywhere in a URL.
  const match = /^https:\/\/([a-z0-9.-]+)(?::(\d+))?([/?][^#]*)?(?:#[\s\S]*)?$/i.exec(url.trim().replace(/[\t\n\r]/g, ''))
  if (!match) return null
  const host = match[1].toLowerCase().replace(/\.$/, '')
  const port = match[2] !== undefined && Number(match[2]) !== 443 ? `:${Number(match[2])}` : ''
  const rest = match[3] ?? ''
  const queryAt = rest.indexOf('?')
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt)
  const query = queryAt === -1 ? '' : rest.slice(queryAt)
  try {
    return `https://${host}${port}${resolvedPath(percentEncoded(path, PATH_ENCODE))}${percentEncoded(query, QUERY_ENCODE)}`
  } catch {
    // A lone surrogate can't be encoded; such a URL can't be requested either.
    return null
  }
}

/** Characters browsers percent-encode in a path and a query, besides controls, spaces and non-ASCII (WHATWG URL). */
const PATH_ENCODE = '"<>`{}'
const QUERY_ENCODE = '"<>\''

/** `text` with the characters a browser would escape percent-encoded as UTF-8, and every escape's hex uppercased. */
function percentEncoded(text: string, set: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x7f) out += encodeURIComponent(char)
    else if (code <= 0x20 || set.includes(char)) out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`
    else out += char
  }
  return out.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase())
}

/** A URL path with `.` and `..` segments resolved, as browsers do (WHATWG URL). */
function resolvedPath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').slice(1)
  const out: string[] = []
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    const lower = segment.toLowerCase()
    if (lower === '..' || lower === '.%2e' || lower === '%2e.' || lower === '%2e%2e') {
      out.pop()
      if (last) out.push('')
    } else if (lower === '.' || lower === '%2e') {
      if (last) out.push('')
    } else {
      out.push(segment)
    }
  })
  return `/${out.join('/')}`
}

/**
 * Whether a media URL can be interpreted unambiguously. Keep these structural
 * checks separate from scheme rules: external links may allow http, images do not.
 */
export function isSafeMediaUrl(url: string): boolean {
  if (ipfsReferenceOf(url) === 'refused') return false
  return !/^\s*https:/i.test(url) || canonicalHttpsUrl(url) !== null
}

export type ImageSource =
  /** IPFS content: the caller picks gateways for `ipfsUrl`. */
  | { kind: 'ipfs'; ipfsUrl: string }
  /** Any other https image, through the proxy. */
  | { kind: 'proxied'; url: string }
  /** Inline (`data:image/`, `blob:`) or same-origin (`/…`) images, loaded as they are. */
  | { kind: 'local'; url: string }
  /** Nothing loadable: empty, plain http or any other scheme. */
  | { kind: 'none' }

/** `/x` but not `//host` or `/\\host`, which browsers send to another host. */
const LOCAL_IMAGE = /^(data:image\/|blob:|\/(?![/\\]))/i

/** How an image URL may be loaded; see the module comment. */
export function imageSourceFor(url: string | null | undefined, size: ProxyImageSize = 'full'): ImageSource {
  const trimmed = url?.trim()
  // Browsers drop tabs and newlines, so `/\t/host` would be `//host`.
  if (!trimmed || CONTROL.test(trimmed)) return { kind: 'none' }
  if (LOCAL_IMAGE.test(trimmed)) return { kind: 'local', url: trimmed }
  if (!isSafeMediaUrl(trimmed)) return { kind: 'none' }
  const reference = ipfsReferenceOf(trimmed)
  if (reference && reference !== 'refused') {
    return { kind: 'ipfs', ipfsUrl: `ipfs://${reference.cid}${reference.path}` }
  }
  if (/^https:\/\//i.test(trimmed)) return { kind: 'proxied', url: proxiedImageUrl(trimmed, size) }
  return { kind: 'none' }
}
