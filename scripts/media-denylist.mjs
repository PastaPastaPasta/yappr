#!/usr/bin/env node
/**
 * Adds an entry to the media takedown denylist (lib/media/media-denylist.json).
 * Runbook: docs/MEDIA_TAKEDOWN.md.
 *
 *   node scripts/media-denylist.mjs add <ipfs-cid | ipfs://… | gateway URL | https URL> --ref <ticket>
 *   node scripts/media-denylist.mjs check <same forms>
 *
 * An IPFS reference is listed by CID, in both its v0 and v1 forms where they
 * exist, so either spelling is caught. Any other https URL is listed only by
 * the sha256 of its canonical form, so the public repository never names it.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LIST_PATH = fileURLToPath(new URL('../lib/media/media-denylist.json', import.meta.url))

// Same patterns as lib/media/remote-media.ts.
const IPFS_PROTOCOL = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)([^?#]*)/i
const SUBDOMAIN_GATEWAY = /^https?:\/\/([^./?#]+)\.ipfs\.[^/?#]+([^?#]*)/i
const PATH_GATEWAY = /^https?:\/\/[^/?#]+\/ipfs\/([^/?#]+)([^?#]*)/i
const IPNS = /^ipns:|^https?:\/\/(?:[^/?#]+\/ipns\/|[^./?#]+\.ipns\.)/i
const OTHER_SUBDOMAIN_CID = /^[0-9a-z]{40,}$/i
// Same as in lib/media/remote-media.ts.
const CONTROL = /[\u0000-\u001f\u007f]/
const PLAIN_HTTP_AUTHORITY = /^https?:\/\/([a-z0-9.-]+)(?::\d+)?(?:[/?#]|$)/i
const CANONICAL_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const IPV4_SHAPED = /(?:^|\.)(?:0x[0-9a-f]*|\d+)\.?$/i
const hasPlainAuthority = (url) => {
  const host = PLAIN_HTTP_AUTHORITY.exec(url)?.[1]
  return host !== undefined && (!IPV4_SHAPED.test(host) || CANONICAL_IPV4.test(host))
}

const CANONICAL_CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/i
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** Same as isCanonicalCid in lib/media/remote-media.ts: base32's unused last bits must be zero. */
function isCanonicalCid(cid) {
  if (!CANONICAL_CID.test(cid) || cid.startsWith('Qm')) return CANONICAL_CID.test(cid)
  const unusedBits = ((cid.length - 1) * 5) % 8
  const last = BASE32_ALPHABET.indexOf(cid[cid.length - 1].toLowerCase())
  return unusedBits < 5 && (last & ((1 << unusedBits) - 1)) === 0
}
/** Same as ESCAPING_PATH in lib/media/remote-media.ts: a path that could leave its CID. */
const ESCAPING_PATH = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%2f|%5c|\\/i

/**
 * Same rule as ipfsCidOf in lib/media/remote-media.ts (a test holds them
 * together), plus a bare CID. Only the two spellings Yappr writes count; the
 * apps already refuse every other spelling of a CID.
 */
export function ipfsCidOf(input) {
  const trimmed = input.trim()
  if (CANONICAL_CID.test(trimmed)) return isCanonicalCid(trimmed) ? trimmed : null
  // Same as PLAIN_HTTP_AUTHORITY in lib/media/remote-media.ts: any other http(s) shape, and IPNS names, are refused by the apps outright.
  if (CONTROL.test(trimmed) || (/^https?:/i.test(trimmed) && !hasPlainAuthority(trimmed)) || IPNS.test(trimmed)) return null
  const cidIn = (match) => (isCanonicalCid(match[1]) && !ESCAPING_PATH.test(match[2]) ? match[1] : null)
  const subdomain = SUBDOMAIN_GATEWAY.exec(trimmed)
  if (subdomain && (CANONICAL_CID.test(subdomain[1]) || OTHER_SUBDOMAIN_CID.test(subdomain[1]))) return cidIn(subdomain)
  const pathRef = IPFS_PROTOCOL.exec(trimmed) ?? PATH_GATEWAY.exec(trimmed)
  return pathRef ? cidIn(pathRef) : null
}

// Same as in lib/media/remote-media.ts (a test holds them together).
/**
 * An http(s) URL as the server ends up routing it: percent-decoded,
 * backslashes as slashes, any `user:pass@` dropped from the authority,
 * repeated slashes collapsed, `.` and `..` segments resolved; query and
 * fragment dropped. Anything else is
 * returned unchanged.
 */
export function effectiveDestination(url) {
  const match = /^(https?:\/\/)([^?#]*)/i.exec(url)
  if (!match) return url
  // Segment by segment, so one malformed escape can't keep the others
  // encoded; then split again, since a decoded `%2F` is a separator too.
  const [authority, ...segments] = match[2].replace(/\\/g, '/').split('/').map(percentDecoded).join('/').replace(/\\/g, '/').split('/')
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  const path = []
  // Repeated slashes collapse too, as gateways clean the path (Go's path.Clean).
  segments.forEach((segment, index) => {
    if (segment === '..') path.pop()
    else if (segment !== '.' && (segment !== '' || index === segments.length - 1)) path.push(segment)
  })
  return `${match[1]}${[host, ...path].join('/')}`
}

function percentDecoded(url) {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

/**
 * The form of an https URL whose sha256 the denylist stores, spelled the way
 * a browser requests it, so equivalent spellings hash alike: host lowercased
 * without a trailing dot, the default port dropped, an empty path as `/`,
 * `.`/`..` segments resolved (also `%2e` and backslash forms), path and
 * query percent-encoded as a browser sends them (`café` as `caf%C3%A9`, a
 * space as `%20`), fragment dropped. `?a=1` and `?a=2` still differ. Null
 * when the URL isn't https in a plain `scheme://host` shape (those are
 * refused anyway). lib/media/remote-media.ts carries the same function (a
 * test holds them together).
 */
export function canonicalHttpsUrl(url) {
  // Browsers drop tabs and newlines anywhere in a URL.
  const match = /^https:\/\/([a-z0-9.-]+)(?::(\d+))?([/?][^#]*)?(?:#.*)?$/i.exec(url.trim().replace(/[\t\n\r]/g, ''))
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
function percentEncoded(text, set) {
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
function resolvedPath(path) {
  const segments = path.replace(/\\/g, '/').split('/').slice(1)
  const out = []
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

export function urlSha256(url) {
  const canonical = canonicalHttpsUrl(url)
  if (!canonical) throw new Error(`Not an https URL: ${url}`)
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base58Decode(text) {
  let value = 0n
  for (const char of text) {
    const digit = BASE58.indexOf(char)
    if (digit < 0) throw new Error(`Not base58: ${text}`)
    value = value * 58n + BigInt(digit)
  }
  const bytes = []
  while (value > 0n) {
    bytes.unshift(Number(value % 256n))
    value /= 256n
  }
  for (const char of text) {
    if (char !== '1') break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

function base58Encode(bytes) {
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  let text = ''
  while (value > 0n) {
    text = BASE58[Number(value % 58n)] + text
    value /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    text = `1${text}`
  }
  return text
}

function base32Encode(bytes) {
  let bits = 0
  let buffer = 0
  let text = ''
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      text += BASE32[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) text += BASE32[(buffer << (5 - bits)) & 31]
  return text
}

function base32Decode(text) {
  let bits = 0
  let buffer = 0
  const bytes = []
  for (const char of text) {
    const digit = BASE32.indexOf(char)
    if (digit < 0) throw new Error(`Not base32: ${text}`)
    buffer = (buffer << 5) | digit
    bits += 5
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(bytes)
}

/** A sha2-256 multihash: what a CIDv0 is, and what a dag-pb CIDv1 wraps. */
const isSha256Multihash = (bytes) => bytes.length === 34 && bytes[0] === 0x12 && bytes[1] === 0x20

/**
 * Every spelling of a CID worth listing: as given, plus its v0/v1 twin for
 * dag-pb content (the same bytes behind `Qm…` and `bafy…`).
 */
export function cidForms(cid) {
  if (cid.startsWith('Qm')) {
    const multihash = base58Decode(cid)
    if (!isSha256Multihash(multihash)) throw new Error(`Not a CIDv0: ${cid}`)
    return [cid, `b${base32Encode(Uint8Array.from([0x01, 0x70, ...multihash]))}`]
  }
  const v1 = cid.toLowerCase()
  if (!v1.startsWith('b')) throw new Error(`Only base32 CIDv1 (b…) is supported: ${cid}`)
  const bytes = base32Decode(v1.slice(1))
  if (bytes[0] !== 0x01) throw new Error(`Not a CIDv1: ${cid}`)
  const multihash = bytes.subarray(2)
  return bytes[1] === 0x70 && isSha256Multihash(multihash) ? [v1, base58Encode(multihash)] : [v1]
}

function load() {
  return JSON.parse(readFileSync(LIST_PATH, 'utf8'))
}

function save(list) {
  writeFileSync(LIST_PATH, `${JSON.stringify(list, null, 2)}\n`)
}

function main(argv) {
  const [command, target, ...rest] = argv
  const refIndex = rest.indexOf('--ref')
  const ref = refIndex >= 0 ? rest[refIndex + 1] : undefined
  if (!['add', 'check'].includes(command) || !target) {
    console.error('Usage: node scripts/media-denylist.mjs <add|check> <cid | ipfs URL | https URL> [--ref <ticket>]')
    process.exit(2)
  }

  const list = load()
  // A gateway URL in an odd spelling (`/ipfs//CID`, `/x/../ipfs/CID`) is listed by the CID it reaches.
  const cid = ipfsCidOf(target) ?? (/^https?:/i.test(target) ? ipfsCidOf(effectiveDestination(target.trim())) : null)
  const cids = cid ? cidForms(cid) : []
  const hash = cid ? null : urlSha256(target)
  const listed = cid
    ? cids.filter((form) => list.cids.some((entry) => entry.cid === form))
    : list.urlSha256.filter((entry) => entry.sha256 === hash).map((entry) => entry.sha256)

  if (command === 'check') {
    console.log(listed.length > 0 ? `Listed: ${listed.join(', ')}` : 'Not listed')
    return
  }

  if (!ref) {
    console.error('add needs --ref <ticket or report id> for the audit trail (never a description of the content)')
    process.exit(2)
  }
  const added = new Date().toISOString().slice(0, 10)
  if (cid) {
    for (const form of cids) {
      if (!listed.includes(form)) list.cids.push({ cid: form, added, ref })
    }
  } else if (listed.length === 0) {
    list.urlSha256.push({ sha256: hash, added, ref })
  }
  save(list)
  console.log(cid ? `Listed CID ${cids.join(' and ')}` : `Listed URL sha256 ${hash}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
}
