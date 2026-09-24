/**
 * Local copies of documents a moderator removed, kept so the removal can be
 * undone (Platform 4.2.0-beta.4, platform#4885).
 *
 * A moderator restore must hand Platform the document AS IT WAS: the removal
 * record holds only `documentHash`, a double SHA-256 of the document serialized
 * under its type at removal time, and consensus refuses anything that hashes
 * differently (41121). Nothing on chain keeps the bytes, so the moderator's
 * client serializes the document just before deleting it and keeps it here for
 * the restore window (a week, 41120 after it).
 *
 * localStorage, scoped per deployment like every other persisted key. A post
 * serializes to a few hundred bytes, and entries expire with the window, so
 * the footprint stays small; a moderator on another device simply sees no
 * restore action.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { base64ToBytes, bytesToBase64, bytesToHex } from '@/lib/bytes'
import { scopedKey } from '@/lib/storage-scope'

/** `SystemLimits::contract_document_restore_window_ms` at protocol 14: one week. */
export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const PREFIX = scopedKey('yappr:moderation-snapshot:')

interface StoredSnapshot {
  /** `Document.toBytes(contract, platformVersion)` of the document as fetched before the deletion. */
  bytes: string
  savedAt: number
}

const keyOf = (documentTypeName: string, documentId: string) => `${PREFIX}${documentTypeName}:${documentId}`

/** The hash a removal record commits to: double SHA-256 of the serialized document, as hex. */
export function removalHashOf(bytes: Uint8Array): string {
  return bytesToHex(sha256(sha256(bytes)))
}

/** Keep the serialized document until the restore window closes, dropping expired entries on the way. */
export function saveSnapshot(documentTypeName: string, documentId: string, bytes: Uint8Array, now = Date.now()): void {
  try {
    pruneSnapshots(now)
    const entry: StoredSnapshot = { bytes: bytesToBase64(bytes), savedAt: now }
    localStorage.setItem(keyOf(documentTypeName, documentId), JSON.stringify(entry))
  } catch {
    // Storage full or blocked: the removal still happens, it just cannot be undone from here.
  }
}

/** The serialized document, or null when none was kept (or it outlived the restore window). */
export function loadSnapshot(documentTypeName: string, documentId: string, now = Date.now()): Uint8Array | null {
  try {
    const raw = localStorage.getItem(keyOf(documentTypeName, documentId))
    if (!raw) return null
    const entry = JSON.parse(raw) as StoredSnapshot
    if (now - entry.savedAt > RESTORE_WINDOW_MS) return null
    return base64ToBytes(entry.bytes)
  } catch {
    return null
  }
}

export function dropSnapshot(documentTypeName: string, documentId: string): void {
  try {
    localStorage.removeItem(keyOf(documentTypeName, documentId))
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

function pruneSnapshots(now: number): void {
  const expired: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(PREFIX)) continue
    try {
      const entry = JSON.parse(localStorage.getItem(key) ?? '') as StoredSnapshot
      if (now - entry.savedAt > RESTORE_WINDOW_MS) expired.push(key)
    } catch {
      expired.push(key)
    }
  }
  for (const key of expired) localStorage.removeItem(key)
}
