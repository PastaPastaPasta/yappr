/**
 * The two encodings of every field Platform 4.2.0-beta.4 turned into a typed
 * array (docs/SOCIAL_V9.md, "Typed-array encoding migration").
 *
 * Old cuts (social v2–v8, profile v1, blog v1–v3, storefront v1–v3) store a
 * string or packed bytes; the beta.4 cuts store a list, and each refuses the
 * other's encoding. Testnet and production keep the old cuts, so every READER
 * here accepts both shapes, and every WRITER is told which one to produce by
 * the caller's topology predicate. Pure: no SDK, no topology import.
 */
import bs58 from 'bs58'
import type { SocialLink } from '@/types/user'
import { normalizeBytes } from '@/lib/bytes'

const IDENTIFIER_BYTES = 32

// ---- helpers ----------------------------------------------------------------

/** A list as a typed array hands it back, or null when `value` is not a list. */
function asList(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

/** Trimmed, non-empty, first occurrence kept: the shape `uniqueItems` accepts. */
export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (value && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

function parseJsonList(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** An identifier element as base58, whichever of string, bytes or Identifier it arrived as. */
function identifierOf(element: unknown): string | null {
  // A JSON read hands identifier elements back as base58 strings.
  if (typeof element === 'string') return element
  if (element && typeof (element as { toBase58?: unknown }).toBase58 === 'function') {
    return (element as { toBase58: () => string }).toBase58()
  }
  const bytes = normalizeBytes(element)
  return bytes && bytes.length === IDENTIFIER_BYTES ? bs58.encode(bytes) : null
}

// ---- social blockFollow.followedBlockers --------------------------------------

/**
 * The identities a user inherits blocks from. v9: a list of identifiers.
 * v2–v8: one byte array of 32-byte ids laid end to end (a trailing partial
 * chunk is dropped).
 */
export function decodeBlockFollowIds(value: unknown): string[] {
  const list = asList(value)
  if (list) {
    // A list of numbers is a byte array handed back as number[], not a list of ids.
    if (list.length === 0 || typeof list[0] !== 'number') {
      return list.map(identifierOf).filter((id): id is string => id !== null)
    }
  }
  const bytes = normalizeBytes(value)
  if (!bytes) return []
  const ids: string[] = []
  for (let i = 0; i + IDENTIFIER_BYTES <= bytes.length; i += IDENTIFIER_BYTES) {
    ids.push(bs58.encode(bytes.slice(i, i + IDENTIFIER_BYTES)))
  }
  return ids
}

/** The stored `followedBlockers`: a list of 32-byte ids (typed) or the packed bytes (legacy). */
export function encodeBlockFollowIds(ids: readonly string[], typed: boolean): Uint8Array | Uint8Array[] {
  const decoded = ids.map((id) => bs58.decode(id))
  if (typed) return decoded
  const packed = new Uint8Array(decoded.length * IDENTIFIER_BYTES)
  decoded.forEach((id, index) => packed.set(id, index * IDENTIFIER_BYTES))
  return packed
}

// ---- profile paymentUris / socialLinks ----------------------------------------

/** Profile payment URIs: a list (profile v2) or a JSON string of a list (v1). */
export function decodePaymentUriList(value: unknown): string[] {
  const list = asList(value) ?? (typeof value === 'string' ? parseJsonList(value) : [])
  return list.filter((uri): uri is string => typeof uri === 'string')
}

export function encodePaymentUriList(uris: readonly string[], typed: boolean): string[] | string {
  const clean = uniqueStrings(uris)
  return typed ? clean : JSON.stringify(clean)
}

/**
 * One social link as profile v2 stores it: `"<platform>:<handle>"`. The
 * platform is the text before the FIRST colon; everything after it is the
 * handle, which may itself contain colons (a URL, a Matrix id).
 */
export function socialLinkToString(link: SocialLink): string {
  return `${link.platform}:${link.handle}`
}

export function socialLinkFromString(value: string): SocialLink | null {
  const colon = value.indexOf(':')
  if (colon <= 0 || colon === value.length - 1) return null
  return { platform: value.slice(0, colon), handle: value.slice(colon + 1) }
}

/** Social links: a list of "platform:handle" (v2) or a JSON string of `{platform, handle}` objects (v1). */
export function decodeSocialLinkList(value: unknown): SocialLink[] {
  const list = asList(value)
  if (list) {
    return list
      .map((element) => (typeof element === 'string' ? socialLinkFromString(element) : null))
      .filter((link): link is SocialLink => link !== null)
  }
  if (typeof value !== 'string') return []
  return parseJsonList(value).filter((link): link is SocialLink =>
    !!link && typeof (link as SocialLink).platform === 'string' && typeof (link as SocialLink).handle === 'string')
}

export function encodeSocialLinkList(links: readonly SocialLink[], typed: boolean): string[] | string {
  if (!typed) return JSON.stringify(links)
  return uniqueStrings(links.map(socialLinkToString))
}

// ---- blog labels ----------------------------------------------------------------

/** Blog/post labels: a list (blog v4) or a comma-separated string (v1–v3); trimmed and deduped. */
export function decodeLabelList(value: unknown): string[] {
  const list = asList(value)
  if (list) return uniqueStrings(list.filter((label): label is string => typeof label === 'string'))
  if (typeof value !== 'string') return []
  return uniqueStrings(value.split(','))
}

/** Labels as the cut stores them, or undefined when there are none (the field is then omitted). */
export function encodeLabelList(labels: readonly string[], typed: boolean): string[] | string | undefined {
  const clean = uniqueStrings(labels)
  if (clean.length === 0) return undefined
  return typed ? clean : clean.join(',')
}

// ---- storefront storeItem.tags / imageUrls --------------------------------------

/** A storefront string list: a list (storefront v4) or a JSON string of a list (v1–v3). */
export function decodeStringList(value: unknown): string[] {
  const list = asList(value) ?? (typeof value === 'string' ? parseJsonList(value) : [])
  return list.filter((element): element is string => typeof element === 'string')
}

export function encodeStringList(values: readonly string[], typed: boolean): string[] | string | undefined {
  const clean = uniqueStrings(values)
  if (clean.length === 0) return undefined
  return typed ? clean : JSON.stringify(clean)
}
