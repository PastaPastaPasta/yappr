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
 * - A passkey added here whose entry was sent but not yet confirmed, until it
 *   settles (public facts only).
 */
import { readScoped, removeScoped, scopedKeysWithPrefix, writeScoped } from '@/lib/storage-scope'

/**
 * One storage value per fact (per marker, per name, per identity's unsettled
 * passkey), never a shared map: tabs writing at once can never drop each
 * other's records with a read-modify-write.
 */
const HERE_PREFIX = 'yappr_passkey_here:'
const NAME_PREFIX = 'yappr_passkey_name:'
const OFFER_KEY = 'yappr_passkey_offered'
const UNSETTLED_PREFIX = 'yappr_passkey_unsettled:'

export const MAX_PASSKEY_NAME_LENGTH = 40

function herePrefix(identityId: string): string {
  return `${HERE_PREFIX}${identityId}:`
}

function unsettledKey(identityId: string): string {
  return `${UNSETTLED_PREFIX}${identityId}`
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

/**
 * The markers ({@link passkeyMarker}) of the passkeys added or used for
 * `identityId` in this browser. What this browser stored is trusted here:
 * its storage is part of what "This device" rests on (docs/PASSKEY_VAULT.md).
 */
export function passkeysHere(identityId: string): string[] {
  const prefix = herePrefix(identityId)
  return scopedKeysWithPrefix(prefix).map((key) => key.slice(prefix.length))
}

export function rememberPasskeyHere(identityId: string, marker: string): void {
  writeScoped(herePrefix(identityId) + marker, '1')
}

/** Forgets every marker of the passkey `credentialId` (base64url). */
export function forgetPasskeyHere(identityId: string, credentialId: string): void {
  for (const marker of passkeysHere(identityId)) {
    if (marker.startsWith(`${credentialId}.`)) removeScoped(herePrefix(identityId) + marker)
  }
}

/**
 * The name the user gave a passkey in this browser, or null. Keyed by its
 * marker, not its public credential id, so a copy recreated under that id
 * with another recipient key never inherits the real passkey's name.
 */
export function passkeyName(marker: string): string | null {
  const name = readScoped(NAME_PREFIX + marker)
  return name?.trim() ? name : null
}

/** Names a passkey (by its marker) in this browser; an empty name clears it. */
export function setPasskeyName(marker: string, name: string): void {
  const trimmed = name.trim().slice(0, MAX_PASSKEY_NAME_LENGTH)
  if (trimmed) writeScoped(NAME_PREFIX + marker, trimmed)
  else removeScoped(NAME_PREFIX + marker)
}

/** Whether this browser has already been offered a passkey after a sign-in (it is offered once, ever). */
export function passkeyOfferMade(): boolean {
  return readScoped(OFFER_KEY) === '1'
}

export function markPasskeyOfferMade(): void {
  writeScoped(OFFER_KEY, '1')
}

/** The receipt of the write that sends an unsettled passkey's entry: the nonce as a decimal string, the signed transition in base64. */
export interface UnsettledReceipt {
  contractId: string
  documentType: string
  ownerId: string
  documentId: string
  nonce: string
  transition: string
}

/**
 * A passkey added in this browser whose entry was sent but not confirmed. It
 * outlives a reload until it settles: until then a new passkey must exclude
 * it, or the provider could replace it while its entry may still land. Public
 * facts only, never the PRF output or a key.
 */
export interface UnsettledPasskey {
  /** The vault contract its entry was written to. */
  vault: string
  /** base64url */
  credentialId: string
  /** The recipient key its entry is sealed to (hex). */
  recipientKey: string
  /** Every write sent for it: any of them may land (the vault keeps one entry per passkey). */
  receipts: UnsettledReceipt[]
}

function receiptOf(value: unknown): UnsettledReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { contractId, documentType, ownerId, documentId, nonce, transition } = value as Record<string, unknown>
  return typeof contractId === 'string' && typeof documentType === 'string' && typeof ownerId === 'string'
    && typeof documentId === 'string' && typeof nonce === 'string' && /^\d+$/.test(nonce) && typeof transition === 'string'
    ? { contractId, documentType, ownerId, documentId, nonce, transition }
    : undefined
}

/** The unsettled passkey added here for `identityId`, or null. */
export function unsettledPasskey(identityId: string): UnsettledPasskey | null {
  const raw = readScoped(unsettledKey(identityId))
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const { vault, credentialId, recipientKey, receipts } = value as Record<string, unknown>
  if (typeof vault !== 'string' || typeof credentialId !== 'string' || typeof recipientKey !== 'string' || !Array.isArray(receipts)) return null
  // A receipt that does not parse is kept out, and with it the claim that every write was settled.
  const parsed = receipts.map(receiptOf)
  if (parsed.some((receipt) => receipt === undefined)) return null
  return { vault, credentialId, recipientKey, receipts: parsed.filter((receipt): receipt is UnsettledReceipt => receipt !== undefined) }
}

/** Keeps it; false when this browser could not store it. */
export function rememberUnsettledPasskey(identityId: string, passkey: UnsettledPasskey): boolean {
  return writeScoped(unsettledKey(identityId), JSON.stringify(passkey))
}

/** Forgets the unsettled passkey for `identityId` if it is `credentialId` (base64url): it settled. */
export function forgetUnsettledPasskey(identityId: string, credentialId: string): void {
  const stored = unsettledPasskey(identityId)
  if (stored && stored.credentialId !== credentialId) return
  removeScoped(unsettledKey(identityId))
}
