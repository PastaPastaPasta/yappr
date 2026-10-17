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
 */
import { readScoped, scopedKey, writeScoped } from '@/lib/storage-scope'

const DEVICE_KEY = 'yappr_passkeys_here'
const NAMES_KEY = 'yappr_passkey_names'
const OFFER_KEY = 'yappr_passkey_offered'

const MAX_NAME_LENGTH = 40

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

/** The passkeys (base64url credential ids) added or used for `identityId` in this browser. */
export function passkeysHere(identityId: string): string[] {
  return stringList(readMap(DEVICE_KEY)[identityId])
}

export function rememberPasskeyHere(identityId: string, credentialId: string): void {
  const map = readMap(DEVICE_KEY)
  const ids = stringList(map[identityId])
  if (ids.includes(credentialId)) return
  writeScoped(DEVICE_KEY, JSON.stringify({ ...map, [identityId]: [...ids, credentialId] }))
}

export function forgetPasskeyHere(identityId: string, credentialId: string): void {
  const map = readMap(DEVICE_KEY)
  writeScoped(DEVICE_KEY, JSON.stringify({ ...map, [identityId]: stringList(map[identityId]).filter((id) => id !== credentialId) }))
}

/** The name the user gave a passkey in this browser, or null. */
export function passkeyName(credentialId: string): string | null {
  const name = readMap(NAMES_KEY)[credentialId]
  return typeof name === 'string' && name.trim() ? name : null
}

/** Names a passkey in this browser; an empty name clears it. */
export function setPasskeyName(credentialId: string, name: string): void {
  const map = readMap(NAMES_KEY)
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH)
  const next = { ...map }
  if (trimmed) next[credentialId] = trimmed
  else delete next[credentialId]
  writeScoped(NAMES_KEY, JSON.stringify(next))
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
 */
const PASSKEY_CRITICAL_KEY = scopedKey('yappr_passkey_critical_')
const passkeyCriticalMemory = new Set<string>()

export function markPasskeyCriticalKey(identityId: string): void {
  passkeyCriticalMemory.add(identityId)
  try {
    sessionStorage.setItem(PASSKEY_CRITICAL_KEY + identityId, '1')
  } catch {
    // Storage blocked: the in-memory mark covers this tab.
  }
}

export function isPasskeyCriticalKey(identityId: string): boolean {
  if (passkeyCriticalMemory.has(identityId)) return true
  try {
    return sessionStorage.getItem(PASSKEY_CRITICAL_KEY + identityId) === '1'
  } catch {
    return false
  }
}

export function clearPasskeyCriticalKey(identityId: string): void {
  passkeyCriticalMemory.delete(identityId)
  try {
    sessionStorage.removeItem(PASSKEY_CRITICAL_KEY + identityId)
  } catch {
    // Nothing stored where storage is blocked.
  }
}
