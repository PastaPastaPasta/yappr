/**
 * A DPNS name registration in progress, kept in this browser.
 *
 * Registering a name is two paid writes: a `preorder` that commits to the
 * name through a salted hash, then the `domain` that reveals the salt. The
 * domain is accepted only with a salt whose preorder exists, so the salt is
 * what makes a paid preorder usable later. Each step's signed transition is
 * kept here before it is broadcast, keyed by owner and name:
 *
 * - a retry after a lost answer settles that very transition
 *   (`stateTransitionService.settleCreate`) instead of paying a new preorder;
 * - a preorder that landed is reused, with its salt, for the domain;
 * - the record goes once the name is registered (or its vote joined), or a
 *   step is proved never recorded and nothing else of it can still land.
 *
 * The salt must stay secret until the domain is sent (a preorder does not
 * name its owner, so whoever holds the salt could use it). It sits in the
 * same localStorage as the signing key this browser already keeps.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { base64ToBytes, bytesToBase64, concatBytes } from '@/lib/bytes'
import { readScoped, removeScoped, scopedKeysWithPrefix, writeScoped } from '@/lib/storage-scope'
import type { CreateReceipt } from '@/lib/services/state-transition-service'

const PREFIX = 'yappr:dpns-registration:'

export interface DpnsRegistrationRecord {
  ownerId: string
  /** The label as registered (DPNS keeps its case). */
  label: string
  /** The homograph-safe label the preorder hash commits to (alice -> a11ce). */
  normalizedLabel: string
  salt: Uint8Array
  /** The signed preorder, once it was about to be sent. */
  preorder?: CreateReceipt
  /** Platform confirmed the preorder, or a proof showed it landed. */
  preorderLanded?: boolean
  /** The signed domain, once it was about to be sent. */
  domain?: CreateReceipt
  /** The domain states a contest fund: it is stored in its vote, not by id, so only the vote settles it. */
  domainContested?: boolean
}

interface StoredReceipt {
  contractId: string
  documentType: string
  ownerId: string
  documentId: string
  nonce: string
  transition: string
}

interface StoredRecord {
  v: 1
  ownerId: string
  label: string
  normalizedLabel: string
  salt: string
  preorder?: StoredReceipt
  preorderLanded?: boolean
  domain?: StoredReceipt
  domainContested?: boolean
}

const keyOf = (ownerId: string, normalizedLabel: string) => `${PREFIX}${ownerId}:${normalizedLabel}`

const storeReceipt = (receipt: CreateReceipt): StoredReceipt => ({
  contractId: receipt.contractId,
  documentType: receipt.documentType,
  ownerId: receipt.ownerId,
  documentId: receipt.documentId,
  nonce: receipt.nonce.toString(),
  transition: bytesToBase64(receipt.transition),
})

const readReceipt = (stored: StoredReceipt): CreateReceipt => ({
  contractId: stored.contractId,
  documentType: stored.documentType,
  ownerId: stored.ownerId,
  documentId: stored.documentId,
  nonce: BigInt(stored.nonce),
  transition: base64ToBytes(stored.transition),
})

/** A fresh 32-byte preorder salt. */
export function newPreorderSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

/**
 * What a preorder commits to: double SHA-256 of the salt followed by
 * `<normalizedLabel>.dash` (rs-sdk `register_dpns_name`; Drive's DPNS trigger
 * recomputes it from the domain's `preorderSalt` and refuses the domain when
 * no preorder carries it).
 */
export function saltedDomainHash(salt: Uint8Array, normalizedLabel: string): Uint8Array {
  return sha256(sha256(concatBytes(salt, new TextEncoder().encode(`${normalizedLabel}.dash`))))
}

/** The registration of `normalizedLabel` this browser started for `ownerId`, or null. */
export function loadRegistration(ownerId: string, normalizedLabel: string): DpnsRegistrationRecord | null {
  const raw = readScoped(keyOf(ownerId, normalizedLabel))
  if (!raw) return null
  try {
    const stored = JSON.parse(raw) as StoredRecord
    if (stored.v !== 1 || stored.ownerId !== ownerId || stored.normalizedLabel !== normalizedLabel) return null
    const salt = base64ToBytes(stored.salt)
    if (salt.length !== 32) return null
    return {
      ownerId,
      label: stored.label,
      normalizedLabel,
      salt,
      ...(stored.preorder ? { preorder: readReceipt(stored.preorder) } : {}),
      ...(stored.preorderLanded ? { preorderLanded: true } : {}),
      ...(stored.domain ? { domain: readReceipt(stored.domain) } : {}),
      ...(stored.domainContested ? { domainContested: true } : {}),
    }
  } catch {
    return null
  }
}

/** Store `record`; false when storage would not keep it (nothing may be sent then). */
export function saveRegistration(record: DpnsRegistrationRecord): boolean {
  const stored: StoredRecord = {
    v: 1,
    ownerId: record.ownerId,
    label: record.label,
    normalizedLabel: record.normalizedLabel,
    salt: bytesToBase64(record.salt),
    ...(record.preorder ? { preorder: storeReceipt(record.preorder) } : {}),
    ...(record.preorderLanded ? { preorderLanded: true } : {}),
    ...(record.domain ? { domain: storeReceipt(record.domain) } : {}),
    ...(record.domainContested ? { domainContested: true } : {}),
  }
  return writeScoped(keyOf(record.ownerId, record.normalizedLabel), JSON.stringify(stored))
}

export function clearRegistration(ownerId: string, normalizedLabel: string): void {
  removeScoped(keyOf(ownerId, normalizedLabel))
}

/** Whether anything of `record` was ever about to be sent (a salt alone means nothing was paid). */
export const registrationStarted = (record: DpnsRegistrationRecord): boolean =>
  record.preorder !== undefined || record.preorderLanded === true || record.domain !== undefined

/** Every registration this browser started for `ownerId`, paid for in part, and has not finished. */
export function registrationsInProgress(ownerId: string): DpnsRegistrationRecord[] {
  const prefix = `${PREFIX}${ownerId}:`
  return scopedKeysWithPrefix(prefix)
    .map((key) => loadRegistration(ownerId, key.slice(prefix.length)))
    .filter((record): record is DpnsRegistrationRecord => record !== null && registrationStarted(record))
}
