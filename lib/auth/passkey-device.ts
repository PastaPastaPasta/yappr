/**
 * What this browser remembers about passkeys: nothing secret, and nothing
 * that ever goes on chain.
 *
 * - Which passkeys were added or used here ("This device" in Settings, and
 *   whether to offer one after a sign-in).
 * - The names the user gave passkeys. The chain keeps no label, device or
 *   provider for a passkey (it would be public forever), so names live in the
 *   browser that set them.
 * - Whether the one-time "sign in faster with a passkey" offer has been made
 *   on this device.
 * - For this tab, whether its CRITICAL key came from a passkey (see below).
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { readScoped, scopedKey, writeScoped } from '@/lib/storage-scope'
import { bytesToHex } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { parsePrivateKey } from '@/lib/crypto/wif'

const DEVICE_KEY = 'yappr_passkeys_here'
const NAMES_KEY = 'yappr_passkey_names'
const OFFER_KEY = 'yappr_passkey_offered'

export const MAX_PASSKEY_NAME_LENGTH = 40

function readMap(key: string): Record<string, unknown> {
  const raw = readScoped(key)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * A passkey as this browser knows it: its credential id (base64url) and the
 * recipient key its entry is sealed to (hex). Credential ids are public, and
 * anyone holding a key of the identity can delete an entry and write another
 * under the same credential id with their own recipient key; the recipient
 * key, recorded where this browser proved it (making the passkey, or opening
 * its entry), tells the real one from such a copy.
 */
export function passkeyMarker(credentialId: string, recipientKeyHex: string): string {
  return `${credentialId}.${recipientKeyHex}`
}

/** The markers ({@link passkeyMarker}) of the passkeys added or used for `identityId` in this browser. */
export function passkeysHere(identityId: string): string[] {
  return stringList(readMap(DEVICE_KEY)[identityId])
}

export function rememberPasskeyHere(identityId: string, marker: string): void {
  const map = readMap(DEVICE_KEY)
  const markers = stringList(map[identityId])
  if (markers.includes(marker)) return
  writeScoped(DEVICE_KEY, JSON.stringify({ ...map, [identityId]: [...markers, marker] }))
}

/** Forgets every marker of the passkey `credentialId` (base64url). */
export function forgetPasskeyHere(identityId: string, credentialId: string): void {
  const map = readMap(DEVICE_KEY)
  writeScoped(DEVICE_KEY, JSON.stringify({ ...map, [identityId]: stringList(map[identityId]).filter((marker) => !marker.startsWith(`${credentialId}.`)) }))
}

/**
 * The name the user gave a passkey in this browser, or null. Keyed by its
 * marker, not its public credential id, so a copy recreated under that id
 * with another recipient key never inherits the real passkey's name.
 */
export function passkeyName(marker: string): string | null {
  const name = readMap(NAMES_KEY)[marker]
  return typeof name === 'string' && name.trim() ? name : null
}

/** Names a passkey (by its marker) in this browser; an empty name clears it. */
export function setPasskeyName(marker: string, name: string): void {
  const map = readMap(NAMES_KEY)
  const trimmed = name.trim().slice(0, MAX_PASSKEY_NAME_LENGTH)
  if (trimmed) map[marker] = trimmed
  else delete map[marker]
  writeScoped(NAMES_KEY, JSON.stringify(map))
}

/** Whether this browser has already been offered a passkey after a sign-in (it is offered once, ever). */
export function passkeyOfferMade(): boolean {
  return readScoped(OFFER_KEY) === '1'
}

export function markPasskeyOfferMade(): void {
  writeScoped(OFFER_KEY, '1')
}

/**
 * This tab signed in with a moderator's CRITICAL key from a passkey. Such a
 * key moderates, but never signs token transitions (the starter claim, YAPP
 * transfers): those ask for the key itself (owner decision V2). Kept for the
 * tab only, like the key.
 *
 * Marks name exact keys (a fingerprint of the public key). The auth
 * controller's commit adds one right before it stores a passkey's CRITICAL
 * key, and drops the others only once that store succeeded, so a stored
 * passkey key is never unmarked, even when a write fails half way.
 */
const PASSKEY_CRITICAL_KEY = scopedKey('yappr_passkey_critical_')
const passkeyCriticalMemory = new Map<string, string[]>()
/** Stands in for a key whose fingerprint cannot be taken (it cannot sign either): marked, failing safe. */
const UNREADABLE = '*'

function fingerprintOf(wif: string): string | null {
  try {
    return bytesToHex(sha256(getPublicKey(parsePrivateKey(wif).privateKey)))
  } catch {
    return null
  }
}

function readMarks(identityId: string): string[] {
  const remembered = passkeyCriticalMemory.get(identityId)
  if (remembered) return remembered
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PASSKEY_CRITICAL_KEY + identityId) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((mark): mark is string => typeof mark === 'string') : []
  } catch {
    return []
  }
}

function writeMarks(identityId: string, marks: string[]): void {
  passkeyCriticalMemory.set(identityId, marks)
  try {
    if (marks.length > 0) sessionStorage.setItem(PASSKEY_CRITICAL_KEY + identityId, JSON.stringify(marks))
    else sessionStorage.removeItem(PASSKEY_CRITICAL_KEY + identityId)
  } catch {
    // Storage blocked: the in-memory marks cover this tab.
  }
}

/** Adds a mark for `wif`, a passkey's CRITICAL key (right before it is stored). */
export function markPasskeyCriticalKey(identityId: string, wif: string): void {
  const fingerprint = fingerprintOf(wif) ?? UNREADABLE
  const marks = readMarks(identityId)
  if (!marks.includes(fingerprint)) writeMarks(identityId, [...marks, fingerprint])
}

/** Once a key is stored: keeps only the mark for `wif` (a passkey's CRITICAL key), or none for another key. */
export function keepOnlyPasskeyCriticalKey(identityId: string, wif: string | null): void {
  writeMarks(identityId, wif === null ? [] : [fingerprintOf(wif) ?? UNREADABLE])
}

/** Whether the stored key `wif` came from a passkey as a CRITICAL key. */
export function isPasskeyCriticalKey(identityId: string, wif: string): boolean {
  const fingerprint = fingerprintOf(wif)
  return readMarks(identityId).some((mark) => mark === UNREADABLE || mark === fingerprint)
}

/** Forgets every mark for `identityId` (a sign-out, or another key stored). */
export function clearPasskeyCriticalKey(identityId: string): void {
  writeMarks(identityId, [])
}
