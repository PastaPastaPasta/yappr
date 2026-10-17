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
import { readScoped, writeScoped } from '@/lib/storage-scope'

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
