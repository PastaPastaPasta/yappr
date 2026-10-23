/**
 * Standing for election as a moderation team, from the app: the writes the
 * release CLI (scripts/file-release-charters.mjs) makes, one person at a time,
 * signed in this browser with the same shared builders
 * (lib/moderation-charters/transitions.mjs) and checked by the same rules
 * (lib/moderation-charters/rules.mjs):
 *
 * - a leader files `reason`s, a `submittedCharter` (the proposal), and once
 *   the election is open an `electedCharter` (the application, with the 0.5
 *   DASH contest deposit) naming members chosen from the join requests;
 * - a member files a `joinRequest` whose message only the leader can read;
 * - after seating the leader adds and takes off members.
 *
 * Keys. Every charters document is an ordinary document write, signed with
 * an unbound CRITICAL or HIGH authentication key: the session's own raw key
 * when it has one, otherwise asked for (a wallet session holds none that may
 * sign for the charters contract). The charter keys join requests are
 * encrypted between are made from the MASTER key, asked for once when the
 * key is first needed (lib/moderation-charters/charter-keys.ts). Every key
 * typed in lives in this tab's memory only, until `forgetKeys()`.
 *
 * Each create is signed once under a known nonce and kept until proved, so
 * "try again" after an uncertain outcome broadcasts the same bytes and can
 * never file a second proposal or pay a second deposit.
 */
import * as secp256k1 from '@noble/secp256k1'
import type { Document as WasmDocument, IdentityPublicKey } from '@dashevo/wasm-sdk'
import { logger } from '@/lib/logger'
import { keyNetwork } from '@/lib/constants'
import { matchIdentityKey } from '@/lib/crypto/keys'
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { base64ToBytes, bytesToBase64, requireBytes } from '@/lib/bytes'
import { cancelKeyStepUp, requestKeyStepUp } from '@/lib/auth/key-step-up'
import { hasAppConnectSession } from '@/lib/auth/signing-keys'
import { getPrivateKey } from '@/lib/secure-storage'
import { NONCE_STORE_ERROR, extractErrorMessage, isAlreadyExistsError, sentWriteOutcomeUnknown } from '@/lib/error-utils'
import { sleep } from '@/lib/retry-utils'
import { CHARTERS_CONTRACT_ID, CHARTER_KEYS, isCharterKey, type RewardSplit } from '@/lib/moderation-charters/rules.mjs'
import {
  charterIdBytes, charterKeyInCreation, charterNonceConsumed, charterStepExists, signCharterCreate, type CharterDocumentType, type SignedCharterCreate,
} from '@/lib/moderation-charters/transitions.mjs'
import { withIdentityWriteLock } from '@/lib/identity-write-lock'
import {
  deriveCharterKey, forgetCharterKeys, heldCharterKey, holdCharterKey, keyMatches, readPrivateKeyInput, type CharterRole,
} from '@/lib/moderation-charters/charter-keys'
import { CHARTER_UNCERTAIN_MESSAGE, CharterActionError, charterActionError, type CharterAction } from '@/lib/moderation-charters/refusals'
import type { CreateFees } from '@/lib/moderation-charters/costs'
import { getEvoSdk } from './evo-sdk-service'
import { WRITE_PRECONDITION_FAILED, allocateNonce, awaitNonce, releaseNonce, reserveNonce, withSdkSignedWrite, type PendingTransition } from './identity-nonce'
import { stateTransitionService } from './state-transition-service'
import { documentToPlainObject, identifierToBase58 } from './sdk-helpers'
import { toProposal, toReason, type CharterProposal, type CharterReason } from './moderation-election-service'

/** A join request as the leader's list shows it (its message is read separately). */
export interface JoinRequest {
  id: string
  ownerId: string
  createdAt: number | null
}

/** A team change after seating: the document and the member it names. */
export interface TeamRecord {
  id: string
  memberId: string
}

const PROOF_ATTEMPTS = 12
const PROOF_PAUSE_MS = 5000
const PAGE = 100
/** At most this many pages of join requests or reasons are read (10,000 documents). */
const MAX_PAGES = 100

const asWif = (input: string) => privateKeyToWif(readPrivateKeyInput(input), keyNetwork())
const keyData = (key: IdentityPublicKey) => requireBytes(key.data, 'identity key data')
const keyInputError = (error: unknown) => (error instanceof Error ? error.message : 'That key could not be read.')
/** The documents a query returned, without the holes the SDK leaves for absent ones. */
const presentDocs = (docs: Map<unknown, WasmDocument | null | undefined>) => [...docs.values()].filter((doc): doc is WasmDocument => !!doc)

async function wasmModule() {
  // getEvoSdk initialised this same glue; never compile the wasm a second time.
  return import('@dashevo/wasm-sdk')
}

/** The identity, read fresh (keys change as charter keys are added). */
async function fetchIdentity(identityId: string) {
  const sdk = await getEvoSdk()
  const identity = await sdk.identities.fetch(identityId)
  if (!identity) throw new CharterActionError("Your account couldn't be read. Try again in a moment.", 'refused')
  return identity
}

/** A signed create that may still land, with the nonce reservation that keeps others off its nonce. */
interface PendingCreate {
  signed: SignedCharterCreate
  fingerprint: string
  reservation: PendingTransition
}

/**
 * Signed creates live in localStorage, the one source of truth for every tab
 * and every deployment of this origin (the signed bytes are what goes on the
 * wire, nothing secret): a reload or another tab resends and proves the same
 * transition instead of signing a second one under a new nonce. Keyed like the
 * nonce store, by owner, contract and slot, and not scoped by base path or
 * storage epoch: the charters contract is the same for every deployment.
 */
const PENDING_PREFIX = `yappr:charter-pending:${CHARTERS_CONTRACT_ID}:`

const MAY_STILL_LAND = 'Your last try may still go through. Check again in a minute before changing anything.'
const APPLICATION_MAY_STILL_LAND = 'Your application may still go through. Check the election on this page before applying again.'
const EARLIER_VERSION_FILED = 'An earlier version of this was filed, not the one you just sent. Refresh to see it.'
const STILL_SENDING = 'Your last try is still being sent. Wait for it before changing anything.'

/** Whether the entry was stored: when it was not, nothing may be broadcast. */
function savePendingCreate(key: string, entry: PendingCreate): boolean {
  try {
    const { signed, fingerprint, reservation } = entry
    localStorage.setItem(PENDING_PREFIX + key, JSON.stringify({
      signed: { ...signed, bytes: bytesToBase64(signed.bytes) },
      fingerprint,
      reservation: { id: reservation.id, nonce: String(reservation.nonce), expiresAt: reservation.expiresAt, scope: reservation.scope },
    }))
    return true
  } catch (error) {
    logger.warn('charters: a signed create could not be stored; not sending it', extractErrorMessage(error))
    return false
  }
}

/**
 * What a slot holds once its create is proved landed, in place of the signed
 * create: a retry from any tab, whose own read may still lag, answers from it
 * (filed, or filed in an earlier version) and signs nothing. For
 * {@link LANDED_TRUSTED_MS} it is trusted as is; after that a retry saying the
 * same thing is answered only once the document is proved still there, and a
 * write saying something else is a new one. A proposal's marker for the same
 * contents stays authoritative at any age: proposals can never be deleted, so
 * an absence read (which may be stale) never reopens one.
 */
interface LandedCreate {
  landed: string
  fingerprint: string
  at: number
}

const LANDED_TRUSTED_MS = 15 * 60_000

const isRecent = (marker: LandedCreate) => {
  const age = Date.now() - marker.at
  return age >= 0 && age < LANDED_TRUSTED_MS
}

type StoredSlot = PendingCreate | LandedCreate

const isLanded = (stored: StoredSlot): stored is LandedCreate => 'landed' in stored

/** Replaces the slot's stored create with its landed marker, only while storage still holds `entry`. */
function markLanded(key: string, entry: PendingCreate): void {
  try {
    if (storedReservationId(key) !== entry.reservation.id) return
    const marker: LandedCreate = { landed: entry.signed.id, fingerprint: entry.fingerprint, at: Date.now() }
    localStorage.setItem(PENDING_PREFIX + key, JSON.stringify(marker))
  } catch (error) {
    // The create landed either way: the signed entry stays, and a later retry proves it again.
    logger.warn('charters: a landed create could not be marked; keeping its signed entry', extractErrorMessage(error))
  }
}

/** The reservation id of the signed create the slot holds now, if any (throws when storage or the value can't be read). */
function storedReservationId(key: string): unknown {
  const raw = localStorage.getItem(PENDING_PREFIX + key)
  return raw === null ? undefined : (JSON.parse(raw) as { reservation?: { id?: unknown } }).reservation?.id
}

/**
 * What the slot holds: a signed create, a landed marker, or null for nothing.
 * A stored value that cannot be read may still be a transition that lands, so
 * it never reads as "none": the write stops as uncertain instead of signing
 * another.
 */
function loadSlot(key: string): StoredSlot | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(PENDING_PREFIX + key)
  } catch {
    // Storage blocked: nothing can have been stored, and nothing will be sent (savePendingCreate fails).
    return null
  }
  if (raw === null) return null
  try {
    const saved = JSON.parse(raw) as {
      signed: Omit<SignedCharterCreate, 'bytes'> & { bytes: string }
      fingerprint: string
      reservation: { id: string; nonce: string; expiresAt: number | null; scope?: string }
    } | LandedCreate
    if ('landed' in saved) {
      if (typeof saved.landed !== 'string' || typeof saved.fingerprint !== 'string' || typeof saved.at !== 'number') throw new Error('unexpected shape')
      return saved
    }
    if (typeof saved.signed?.id !== 'string' || typeof saved.signed.nonce !== 'string' || typeof saved.signed.bytes !== 'string'
      || typeof saved.fingerprint !== 'string' || typeof saved.reservation?.id !== 'string') throw new Error('unexpected shape')
    return {
      signed: { ...saved.signed, bytes: base64ToBytes(saved.signed.bytes) },
      fingerprint: saved.fingerprint,
      reservation: { ...saved.reservation, nonce: BigInt(saved.reservation.nonce) },
    }
  } catch (error) {
    logger.warn('charters: a stored create could not be read; not signing another', extractErrorMessage(error))
    throw new CharterActionError(MAY_STILL_LAND, 'uncertain')
  }
}

/** Removes the slot's stored create only while it is still `entry` (another tab may have replaced it). */
function forgetPendingCreate(key: string, entry: PendingCreate): void {
  try {
    if (storedReservationId(key) === entry.reservation.id) localStorage.removeItem(PENDING_PREFIX + key)
  } catch {
    // Storage blocked or the value unreadable: leave it, the next write stops on it.
  }
}

type MatchResult = ReturnType<typeof matchIdentityKey<IdentityPublicKey>>

/** Why a typed key can't sign charters documents, in words; null when it can. */
function signingKeyProblem(result: MatchResult, key: IdentityPublicKey | null): string | null {
  if (result.ok) return key && (key as { contractBounds?: unknown }).contractBounds ? 'That key only signs for another contract. Use your CRITICAL or HIGH key.' : null
  if (result.reason === 'rejected' && result.match.securityLevel === SecurityLevel.MASTER) {
    return "That's your MASTER key. Charter documents are signed with your CRITICAL or HIGH key."
  }
  if (result.reason === 'rejected') return "That key can't sign documents. Use your CRITICAL or HIGH key."
  return "That key isn't one of this account's keys."
}

class CharterService {
  /** Signing keys typed in, by identity: this tab's memory only. */
  private signingWifs = new Map<string, string>()
  /** The write each slot has under way, so a second click joins it instead of signing again. */
  private inFlight = new Map<string, { fingerprint: string; work: Promise<string> }>()
  /** Bumped by `forgetKeys`: a key answered for an earlier generation is never kept. */
  private generation = 0

  /**
   * The current session, to pass to each write of a multi-write action (key
   * setup, reasons, then the proposal): once `forgetKeys` runs, every later
   * write of that action is refused unsigned, not only the one under way.
   */
  session(): number {
    return this.generation
  }

  /** Drops every key this tab was given for charters (on leaving the page, signing out or switching account). */
  forgetKeys(): void {
    this.generation++
    cancelKeyStepUp()
    this.signingWifs.clear()
    forgetCharterKeys()
  }

  // ---- reads ------------------------------------------------------------------

  async getProposal(id: string): Promise<CharterProposal | null> {
    const sdk = await getEvoSdk()
    const doc = await sdk.moderationCharters.submittedCharter(id)
    if (!doc) return null
    try {
      return toProposal(documentToPlainObject(doc))
    } finally {
      doc.free()
    }
  }

  /** The reasons `ownerId` filed, by code (any proposal of theirs may list them). */
  async ownReasons(ownerId: string): Promise<CharterReason[]> {
    const sdk = await getEvoSdk()
    const docs = await sdk.documents.query({ dataContractId: CHARTERS_CONTRACT_ID, documentTypeName: 'reason',
      where: [['$ownerId', '==', ownerId]], orderBy: [['code', 'asc']], limit: PAGE })
    return presentDocs(docs).map((doc) => toReason(documentToPlainObject(doc)))
  }

  /** Every join request for a proposal, in the order of their owners' ids. */
  async joinRequests(submittedCharterId: string): Promise<JoinRequest[]> {
    const requests: JoinRequest[] = []
    await this.eachJoinRequest(submittedCharterId, (doc) => {
      const data = documentToPlainObject(doc)
      requests.push({ id: identifierToBase58(data.$id) ?? '', ownerId: identifierToBase58(data.$ownerId) ?? '', createdAt: Number(data.$createdAt ?? NaN) || null })
    })
    return requests
  }

  private async eachJoinRequest(submittedCharterId: string, visit: (doc: WasmDocument) => Promise<void> | void): Promise<void> {
    const sdk = await getEvoSdk()
    let startAfter: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const docs = presentDocs(await sdk.moderationCharters.joinRequests({ submittedCharterId, limit: PAGE, ...(startAfter ? { startAfter } : {}) }))
      for (const doc of docs) {
        try {
          await visit(doc)
        } finally {
          startAfter = doc.id.toBase58()
          doc.free()
        }
      }
      if (docs.length < PAGE) return
    }
  }

  /**
   * The messages of a proposal's join requests, decrypted with the leader's
   * charter key (asked for when this tab does not hold it): by request id,
   * null where a message could not be read.
   */
  async readJoinMessages(submittedCharterId: string, leaderId: string): Promise<Map<string, string | null>> {
    const leaderKey = await this.charterKey(leaderId, 'leader', { create: false })
    const sdk = await getEvoSdk()
    const { PrivateKey } = await wasmModule()
    const contract = await sdk.contracts.fetch(CHARTERS_CONTRACT_ID)
    if (!contract) throw new CharterActionError("The join requests couldn't be read. Try again in a moment.", 'refused')
    const recipientPrivateKey = PrivateKey.fromWIF(privateKeyToWif(leaderKey, keyNetwork()))
    const messages = new Map<string, string | null>()
    try {
      await this.eachJoinRequest(submittedCharterId, async (doc) => {
        const id = doc.id.toBase58()
        try {
          const data = documentToPlainObject(doc)
          const member = await sdk.identities.fetch(doc.ownerId.toBase58())
          const senderKey = member?.getPublicKeyById(Number(data.senderKeyId))
          if (!senderKey) throw new Error('the sender key is missing')
          const bytes = await sdk.encryptedFor.decrypt({ dataContract: contract, document: doc, property: 'encryptedMessage', recipientPrivateKey, senderKey })
          messages.set(id, new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        } catch (error) {
          logger.warn('charters: a join message could not be read', extractErrorMessage(error))
          messages.set(id, null)
        }
      })
    } finally {
      contract.free()
      recipientPrivateKey.free()
      leaderKey.fill(0)
    }
    return messages
  }

  /** The additions or removals the seated leader made, as they stand now. */
  async teamRecords(type: 'addedModerator' | 'removedModerator', electedCharterId: string): Promise<TeamRecord[]> {
    const sdk = await getEvoSdk()
    const docs = await sdk.documents.query({ dataContractId: CHARTERS_CONTRACT_ID, documentTypeName: type,
      where: [['electedCharterId', '==', electedCharterId]], orderBy: [['memberId', 'asc']], limit: PAGE })
    return presentDocs(docs).map((doc) => {
      const data = documentToPlainObject(doc)
      return { id: identifierToBase58(data.$id) ?? '', memberId: identifierToBase58(data.memberId) ?? '' }
    })
  }

  /** The members who asked to leave and are still on the team. */
  async pendingResignations(electedCharterId: string): Promise<string[]> {
    const sdk = await getEvoSdk()
    const docs = await sdk.moderationCharters.pendingResignationRequests(electedCharterId)
    return docs.map((doc) => {
      try {
        return doc.ownerId.toBase58()
      } finally {
        doc.free()
      }
    })
  }

  /** The identity's credit balance, read fresh; null when it can't be read. */
  async balance(identityId: string): Promise<bigint | null> {
    try {
      const sdk = await getEvoSdk()
      const balance = await sdk.identities.balance(identityId)
      return balance === undefined || balance === null ? null : BigInt(balance)
    } catch (error) {
      logger.warn('charters: balance read failed', extractErrorMessage(error))
      return null
    }
  }

  /**
   * What one create of each charters type costs (fees only, deposit apart),
   * priced offline from the proved charters contract for a write of this
   * shape: `descriptionBytes`, `reasons` and `members` size the variable fields.
   */
  async createFees(shape: { descriptionBytes: number; reasons: number; members: number }): Promise<CreateFees> {
    const sdk = await getEvoSdk()
    const w = await wasmModule()
    const contract = await sdk.contracts.fetch(CHARTERS_CONTRACT_ID)
    if (!contract) throw new Error('the charters contract could not be read')
    try {
      const fee = (type: keyof CreateFees, fields: Record<string, { present?: boolean; length?: number }> = {}) => {
        const cost = w.documentCreateCost(contract, type, { fields }, w.PlatformVersion.latest())
        return BigInt(cost.storage.credits.newValues) + BigInt(cost.processingCredits.newValues)
      }
      return {
        reason: fee('reason', { description: { length: 200 } }),
        submittedCharter: fee('submittedCharter', { description: { length: Math.max(1, shape.descriptionBytes) }, reasons: { length: shape.reasons } }),
        joinRequest: fee('joinRequest', { encryptedMessage: { length: 160 } }),
        electedCharter: fee('electedCharter', { members: { length: shape.members } }),
        addedModerator: fee('addedModerator'),
        removedModerator: fee('removedModerator'),
      }
    } finally {
      contract.free()
    }
  }

  /** Whether the identity already holds its charter key of `role` (so setting it up costs nothing). */
  async hasCharterKey(identityId: string, role: CharterRole): Promise<boolean> {
    const identity = await fetchIdentity(identityId)
    const { purpose, documentType } = CHARTER_KEYS[role]
    return identity.publicKeys.some((key) => isCharterKey(key, purpose, documentType))
  }

  // ---- keys -------------------------------------------------------------------

  /**
   * A key that may sign charters documents for `identityId`: the session's
   * own raw key when it is an unbound CRITICAL or HIGH authentication key,
   * else one typed in earlier in this tab, else asked for now.
   */
  private async signingKey(identityId: string, generation = this.generation): Promise<{ wif: string; identityKey: IdentityPublicKey }> {
    const identity = await fetchIdentity(identityId)
    // An action cancelled meanwhile asks for nothing, and keeps nothing typed for it.
    this.assertSameSession(generation)
    const keys = identity.publicKeys
    const match = (wif: string) => matchIdentityKey(wif, keys, {
      network: keyNetwork(), purpose: KeyPurpose.AUTHENTICATION, allowedSecurityLevels: [SecurityLevel.CRITICAL, SecurityLevel.HIGH],
    })
    // A wallet session must not reach past its grant to a raw key left in storage.
    const candidates = [hasAppConnectSession(identityId) ? null : getPrivateKey(identityId)?.trim(), this.signingWifs.get(identityId)]
    for (const wif of candidates) {
      if (!wif) continue
      const result = match(wif)
      if (result.ok && signingKeyProblem(result, result.key) === null) return { wif, identityKey: result.key }
    }
    const input = await requestKeyStepUp({
      identityId,
      title: 'Sign with your CRITICAL key',
      description: 'Moderation charters are signed with your account\'s CRITICAL (or HIGH) key, which your wallet holds. It stays in this tab only and is forgotten when you leave this page.',
      label: 'CRITICAL or HIGH key',
      validate: async (typed) => {
        try {
          const result = match(asWif(typed))
          return signingKeyProblem(result, result.ok ? result.key : null)
        } catch (error) {
          return keyInputError(error)
        }
      },
    })
    this.assertSameSession(generation)
    const wif = asWif(input)
    const result = match(wif)
    if (!result.ok) throw new CharterActionError("That key can't sign this. Use your CRITICAL or HIGH key.", 'refused')
    this.signingWifs.set(identityId, wif)
    return { wif, identityKey: result.key }
  }

  /** The keys were forgotten (sign-out, a switch of account, the page left) while this was asked: stop. */
  private assertSameSession(generation: number): void {
    if (generation !== this.generation) throw new CharterActionError('Nothing was sent.', 'cancelled')
  }

  /**
   * The identity's charter key of `role`, as private key bytes (the caller
   * zeroes them): held by this tab, or unlocked from the MASTER key (or the
   * charter key itself) typed in now. With `create`, an identity without one
   * gets it added, signed with that MASTER key.
   */
  async charterKey(identityId: string, role: CharterRole, { create, session }: { create: boolean; session?: number }): Promise<Uint8Array> {
    const generation = session ?? this.generation
    this.assertSameSession(generation)
    const identity = await fetchIdentity(identityId)
    // Cancelled while the identity was read: the old account's MASTER key is never asked for.
    this.assertSameSession(generation)
    const { purpose, documentType } = CHARTER_KEYS[role]
    const onChain = identity.publicKeys.filter((key) => isCharterKey(key, purpose, documentType)).sort((a, b) => b.keyId - a.keyId)[0] ?? null
    const onChainData = onChain ? keyData(onChain) : null
    const held = heldCharterKey(identityId, role)
    if (held && onChainData && keyMatches(held, onChainData)) return held
    held?.fill(0)
    if (!onChain && !create) {
      throw new CharterActionError(role === 'leader' ? "This account has no charter key, so join messages can't be read here." : 'Set up your charter key first.', 'refused')
    }
    const isMaster = (wif: string) => matchIdentityKey(wif, identity.publicKeys, {
      network: keyNetwork(), purpose: KeyPurpose.AUTHENTICATION, allowedSecurityLevels: [SecurityLevel.MASTER],
    }).ok
    /** The charter key `typed` gives (the caller zeroes it), or null; every other copy is zeroed. */
    const unlock = (typed: string): Uint8Array | null => {
      const bytes = readPrivateKeyInput(typed)
      if (onChainData && keyMatches(bytes, onChainData)) return bytes
      try {
        // Unlocking a key already on the account needs only the secret it was made from (a MASTER key
        // rotated out since still makes it); adding a new one needs an enabled MASTER key.
        if (!onChainData && !isMaster(privateKeyToWif(bytes, keyNetwork()))) return null
        const derived = deriveCharterKey(bytes, identityId, role)
        if (!onChainData || keyMatches(derived, onChainData)) return derived
        derived.fill(0)
        return null
      } finally {
        bytes.fill(0)
      }
    }
    const input = await requestKeyStepUp({
      identityId,
      title: onChain ? 'Unlock your charter key' : 'Set up your charter key',
      description: onChain
        ? (role === 'leader' ? 'Join messages are encrypted to your charter key.' : 'Your join message is encrypted with your charter key.')
          + ' Enter the MASTER key it was made from (Yappr makes your charter key from it) or the charter key itself. It stays in this tab only.'
        : (role === 'leader' ? 'Members encrypt their join messages to a charter key on your account.' : 'Your join message is encrypted with a charter key on your account.')
          + ' Yappr adds it once, signed with your MASTER key, which stays in this tab only and is never stored.',
      label: onChain ? 'MASTER key or charter key' : 'MASTER key',
      validate: async (typed) => {
        try {
          const unlocked = unlock(typed)
          if (unlocked) {
            unlocked.fill(0)
            return null
          }
          if (onChain && isMaster(asWif(typed))) {
            return "Your account's charter key wasn't made from this MASTER key. Enter the MASTER key you had when you set it up (a replaced one still works), or the charter key itself."
          }
          return onChain ? "That key doesn't unlock this account's charter key." : "That isn't this account's MASTER key."
        } catch (error) {
          return keyInputError(error)
        }
      },
    })
    this.assertSameSession(generation)
    const key = unlock(input)
    if (!key) throw new CharterActionError("That key doesn't fit this account.", 'refused')
    try {
      if (!onChain) await this.addCharterKey(identityId, identity, role, readPrivateKeyInput(input), key, generation)
      this.assertSameSession(generation)
    } catch (error) {
      key.fill(0)
      throw error
    }
    holdCharterKey(identityId, role, key)
    return key
  }

  private async addCharterKey(
    identityId: string,
    identity: Awaited<ReturnType<typeof fetchIdentity>>,
    role: CharterRole,
    master: Uint8Array,
    charterKey: Uint8Array,
    generation: number,
  ): Promise<void> {
    // The MASTER key's bytes are zeroed whatever throws, from the first line on.
    try {
      const sdk = await getEvoSdk()
      const w = await wasmModule()
      // The SDK setup awaited: a session forgotten meanwhile adds no key (and pays no fee). Nothing below awaits until the update.
      this.assertSameSession(generation)
      const { purpose, documentType } = CHARTER_KEYS[role]
      const keyId = identity.publicKeys.reduce((max, key) => Math.max(max, key.keyId), 0) + 1
      const publicKey = secp256k1.getPublicKey(charterKey, true)
      const signer = new w.IdentitySigner()
      const masterKey = w.PrivateKey.fromWIF(privateKeyToWif(master, keyNetwork()))
      // The new key signs its own ownership proof.
      const newKey = w.PrivateKey.fromWIF(privateKeyToWif(charterKey, keyNetwork()))
      try {
        signer.addKey(masterKey)
        signer.addKey(newKey)
        await sdk.identities.update({ identity, addPublicKeys: [charterKeyInCreation(w, { keyId, purpose, documentType, publicKey })], signer })
      } catch (error) {
        if (!sentWriteOutcomeUnknown(error)) throw charterActionError('charter-key', error)
        logger.warn('charters: adding the charter key reported no verdict; checking the identity', extractErrorMessage(error))
      } finally {
        signer.free()
        masterKey.free()
        newKey.free()
      }
      for (let attempt = 0; attempt < PROOF_ATTEMPTS; attempt++) {
        const fresh = await sdk.identities.fetch(identityId).catch(() => undefined)
        if (fresh?.publicKeys.some((key) => key.keyId === keyId && isCharterKey(key, purpose, documentType) && keyMatches(charterKey, keyData(key)))) return
        await sleep(PROOF_PAUSE_MS)
      }
      throw new CharterActionError(CHARTER_UNCERTAIN_MESSAGE, 'uncertain')
    } finally {
      master.fill(0)
    }
  }

  // ---- writes -----------------------------------------------------------------

  /**
   * Signs (once) and files one charters create in `slot`, then proves it,
   * resolving to the document id. The slot (owner, type, what it is for) holds
   * at most one signed create, stored in localStorage (the one source of truth
   * for every tab) until it is proved or known dead:
   *
   * - a definite refusal drops it;
   * - an outcome without a verdict keeps it, and the next try (in any tab)
   *   broadcasts exactly the same bytes, never a new transition under a new nonce;
   * - it is dropped as dead only on proof (`stateTransitionService.settleCreate`:
   *   its nonce consumed, gap-aware, and the document proved absent at that
   *   height or later); a read that fails or lags proves nothing;
   * - proved landed, it becomes a landed marker for 15 minutes, so a retry
   *   from a tab whose reads still lag is answered from it and signs nothing;
   * - an application (with its 0.5 DASH deposit) lives in the contest, not in
   *   document storage, and is NEVER declared dead here: it stays uncertain
   *   until it shows in the contest or the seat. Only the leader's deliberate
   *   "Clear and start over" ({@link abandonApplication}) frees its slot;
   * - a try with different contents while one may still land is refused,
   *   and one landed with different contents is reported as such, so an edit
   *   after a timeout can never file a second proposal or pay a second deposit,
   *   nor be reported filed when the earlier version was.
   *
   * Every look at the slot, every signature and every broadcast happens under
   * the identity's write lock on the charters contract (Web Locks: shared by
   * every tab; where the browser has none, a queue in this tab only), and
   * nonces come from the shared coordinator (`identity-nonce.ts`) like every
   * other write this browser signs. Only the prompts (a charter key, a signing
   * key) come before the lock, and only when a new create must be signed.
   */
  private file(action: CharterAction, input: {
    ownerId: string
    type: CharterDocumentType
    /** The document's data, built only when a new create is signed (never for a resend). */
    data: () => Promise<Record<string, unknown>>
    /** What the create is for: a second create there waits for this one. */
    slot: string
    /** What it says, to tell a retry from a changed write. */
    fingerprint: string
    /** The session of the action this write belongs to ({@link session}); this one's when not given. */
    session?: number
    targetContractId?: string
    fund?: boolean
    /**
     * Re-checks, right before a new create is signed (after every prompt and wait), that it may still be
     * filed; throws when not. It runs under the cross-tab write lock, so its reads hold other writes back.
     */
    beforeSigning?: () => Promise<void>
  }): Promise<string> {
    const key = `${input.ownerId}:${input.type}:${input.slot}`
    const running = this.inFlight.get(key)
    if (running) {
      if (running.fingerprint !== input.fingerprint) return Promise.reject(charterActionError(action, new CharterActionError(STILL_SENDING, 'uncertain')))
      return running.work
    }
    const work = this.fileOnce(key, input).catch((error: unknown) => {
      throw charterActionError(action, error)
    }).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, { fingerprint: input.fingerprint, work })
    return work
  }

  private async fileOnce(key: string, input: Parameters<CharterService['file']>[1]): Promise<string> {
    const { ownerId, type, fingerprint, targetContractId = '', fund = false } = input
    // Leaving the page, signing out or switching account cancels whatever this write has not yet signed.
    const generation = input.session ?? this.generation
    const sdk = await getEvoSdk()
    const w = await wasmModule()
    const lock = <T>(work: () => Promise<T>) => withIdentityWriteLock(ownerId, CHARTERS_CONTRACT_ID, work)
    // True when proved there, false when proved absent, null when the read failed (which proves nothing).
    const exists = (signed: SignedCharterCreate) => charterStepExists(w, sdk, signed, targetContractId).catch(() => null)
    /** Landed, proved dead, or still unknown. An application is never proved dead here. */
    const settle = async (signed: SignedCharterCreate): Promise<'landed' | 'dead' | null> => {
      if (await exists(signed) === true) return 'landed'
      if (type === 'electedCharter') return null
      const outcome = await stateTransitionService.settleCreate({
        contractId: CHARTERS_CONTRACT_ID, documentType: type, ownerId, documentId: signed.id, nonce: BigInt(signed.nonce), transition: signed.bytes,
      }, { mayResend: () => generation === this.generation }) // proof only once the session is forgotten
      return outcome === 'landed' ? 'landed' : outcome === 'not-recorded' ? 'dead' : null
    }
    const uncertain = () => new CharterActionError(type === 'electedCharter' ? APPLICATION_MAY_STILL_LAND : CHARTER_UNCERTAIN_MESSAGE, 'uncertain')

    /**
     * Under the lock: settles what the slot holds now (always read from
     * storage, so another tab's newer entry is never dropped for an older one).
     * A landed entry resolves to its id when it says what this write says;
     * one that says something else is reported as filed in its earlier version.
     */
    type Slot = { kind: 'landed'; id: string } | { kind: 'dead'; entry: PendingCreate } | { kind: 'empty' } | { kind: 'pending'; entry: PendingCreate }
    const resolveSlot = async (): Promise<Slot> => {
      const stored = loadSlot(key)
      if (!stored) return { kind: 'empty' }
      if (isLanded(stored)) {
        if (isRecent(stored)) {
          if (stored.fingerprint !== fingerprint) throw new CharterActionError(EARLIER_VERSION_FILED, 'refused')
          return { kind: 'landed', id: stored.landed }
        }
        // An older marker: the same write again is the filed one. A proposal can never be deleted and is
        // not unique per target, so its marker stays authoritative (an absence read could be stale);
        // anything else is proved still there first. A different write is a new one.
        if (stored.fingerprint === fingerprint && type === 'submittedCharter') return { kind: 'landed', id: stored.landed }
        if (stored.fingerprint === fingerprint) {
          const there = await charterStepExists(w, sdk, { id: stored.landed, type, owner: ownerId }, targetContractId).catch(() => null)
          if (there === true) return { kind: 'landed', id: stored.landed }
          if (there === null) throw new CharterActionError("Your earlier submission couldn't be checked. Try again in a moment.", 'refused')
        }
        // Kept until a new create is actually signed (which overwrites it): a new write that is cancelled
        // or refused must leave the earlier one's marker for its own retry.
        return { kind: 'empty' }
      }
      const outcome = await settle(stored.signed)
      if (outcome === 'landed') {
        const id = this.proved(ownerId, key, stored)
        if (stored.fingerprint !== fingerprint) throw new CharterActionError(EARLIER_VERSION_FILED, 'refused')
        return { kind: 'landed', id }
      }
      if (outcome === 'dead') {
        this.release(ownerId, key, stored, true)
        return { kind: 'dead', entry: stored }
      }
      if (stored.fingerprint !== fingerprint) throw type === 'electedCharter' ? uncertain() : new CharterActionError(MAY_STILL_LAND, 'uncertain')
      return { kind: 'pending', entry: stored }
    }

    /** Under the lock: broadcasts the entry's signed bytes; a definite refusal drops it. */
    const send = async (entry: PendingCreate): Promise<PendingCreate> => {
      // A resend waits for the lock too: a session forgotten meanwhile sends nothing (the bytes stay stored).
      this.assertSameSession(generation)
      try {
        await sdk.stateTransitions.broadcastAndWait(w.StateTransition.fromBytes(entry.signed.bytes))
      } catch (error) {
        // A verdict on these bytes drops them. "Already in the mempool or chain",
        // a nonce clash (these bytes may have executed on an earlier try) and a
        // lost connection are not verdicts: prove the document instead.
        if (!isAlreadyExistsError(error) && !sentWriteOutcomeUnknown(error)) {
          // Refused at execution (paid), its nonce is spent; refused at broadcast, it is not.
          this.release(ownerId, key, entry, await charterNonceConsumed(sdk, ownerId, entry.signed.nonce).catch(() => false))
          throw error
        }
        logger.warn(`charters: ${type} ${entry.signed.id} reported no verdict; checking for it`, extractErrorMessage(error))
      }
      return entry
    }

    // One lock for a resend; a new create first leaves it for its prompts, then takes it again. Settling
    // can rebroadcast stored bytes, so a session forgotten while waiting for either lock settles nothing.
    // (The final settle below takes no lock-time check: it is proof-only once the session is forgotten,
    // through settleCreate's mayResend, and what it may rebroadcast while the session lasts, this call's
    // create or another tab's stored one, is the same signed bytes under the same nonce.)
    const first = await lock(async () => {
      this.assertSameSession(generation)
      const slot = await resolveSlot()
      if (slot.kind === 'landed') return slot.id
      return slot.kind === 'pending' ? send(slot.entry) : null
    })
    if (typeof first === 'string') return first

    let sending = first
    if (!sending) {
      const fresh = { data: await input.data(), signing: await this.signingKey(ownerId, generation) }
      const second = await lock(async () => {
        // Storage again: another tab may have signed, proved or dropped this slot meanwhile.
        this.assertSameSession(generation)
        const slot = await resolveSlot()
        if (slot.kind === 'landed') return slot.id
        if (slot.kind === 'pending') return send(slot.entry)
        this.assertSameSession(generation)
        const { current: tip, value: nonce } = await awaitNonce(ownerId, CHARTERS_CONTRACT_ID, allocateNonce)
        this.assertSameSession(generation)
        // The nonce read above stays this write's while the re-check reads the network: the lock holds every
        // write from this browser off it (one from another device would get this one refused, never doubled).
        // After every wait (prompts, lock, earlier transitions settling), right before the transition is built.
        await input.beforeSigning?.().catch((error: unknown) => {
          if (error instanceof CharterActionError) throw error
          logger.warn('charters: the eligibility re-check failed; nothing signed', extractErrorMessage(error))
          throw new CharterActionError("Nothing was sent: the election couldn't be read. Try again in a moment.", 'refused')
        })
        this.assertSameSession(generation)
        const privateKey = w.PrivateKey.fromWIF(fresh.signing.wif)
        let created: PendingCreate
        try {
          const signed = await signCharterCreate(w, sdk, { type, ownerId, data: fresh.data, nonce, privateKey, identityKey: fresh.signing.identityKey, fund })
          // The builder reads the network (the contest fund): nothing signed for a forgotten session is kept or sent.
          this.assertSameSession(generation)
          created = { signed, fingerprint, reservation: reserveNonce(ownerId, CHARTERS_CONTRACT_ID, nonce, tip, key) }
        } finally {
          privateKey.free()
        }
        // Stored before the broadcast, or not sent at all: a reload or another tab must find these bytes.
        if (!savePendingCreate(key, created)) {
          releaseNonce(ownerId, CHARTERS_CONTRACT_ID, created.reservation)
          throw new CharterActionError(NONCE_STORE_ERROR, 'refused')
        }
        return send(created)
      })
      if (typeof second === 'string') return second
      sending = second
    }

    const proving = sending
    for (let attempt = 0; attempt < PROOF_ATTEMPTS; attempt++) {
      if (await exists(proving.signed) === true) return lock(async () => this.proved(ownerId, key, proving))
      await sleep(PROOF_PAUSE_MS)
    }
    // The slot may now hold another tab's newer create: its verdict is not this one's unless this one is proved.
    const last = await lock(resolveSlot).catch(async (error: unknown) => {
      if (await exists(proving.signed) === true) return { kind: 'landed', id: proving.signed.id } as const
      throw error
    })
    if (last.kind === 'landed') return last.id
    // "Wasn't recorded" only when this very call proved this very create dead.
    if (last.kind === 'dead' && last.entry.reservation.id === proving.reservation.id) {
      throw new CharterActionError("This wasn't recorded. Check, then try again.", 'refused')
    }
    if (last.kind !== 'pending') {
      // Freed by another tab (which may have proved it landed), or replaced: only a proof answers.
      if (await exists(proving.signed) === true) return proving.signed.id
    }
    throw uncertain()
  }

  /**
   * Whether an application for `targetContractId` signed in this browser may
   * still go through (stored, not yet proved): the page then offers "Check the
   * election" and the deliberate {@link abandonApplication}.
   */
  hasPendingApplication(ownerId: string, targetContractId: string): boolean {
    try {
      const stored = loadSlot(`${ownerId}:electedCharter:${targetContractId}`)
      return stored !== null && !isLanded(stored)
    } catch {
      // Unreadable: it may still go through, which is what this asks.
      return true
    }
  }

  /**
   * The leader's deliberate way out of an application stuck uncertain: frees
   * its slot so a new one can be signed. The earlier one may still execute, so
   * the page asks for confirmation that a second application and deposit may
   * follow. Nothing else ever clears an application's slot.
   */
  async abandonApplication(ownerId: string, targetContractId: string): Promise<void> {
    const key = `${ownerId}:electedCharter:${targetContractId}`
    await withIdentityWriteLock(ownerId, CHARTERS_CONTRACT_ID, async () => {
      let stored: StoredSlot | null = null
      try {
        stored = loadSlot(key)
      } catch {
        // Unreadable: drop the raw value below all the same.
      }
      try {
        localStorage.removeItem(PENDING_PREFIX + key)
      } catch {
        // Storage blocked: nothing was stored there.
      }
      // Its nonce may still execute: counting it spent raises the floor past it (the safe direction), so nothing new reuses it.
      if (stored && !isLanded(stored)) releaseNonce(ownerId, CHARTERS_CONTRACT_ID, stored.reservation, BigInt(stored.signed.nonce))
    })
  }

  /** Drops a slot's signed create (only while storage still holds it), telling the nonce coordinator whether its nonce is spent. */
  private release(ownerId: string, key: string, entry: PendingCreate, spent: boolean): void {
    forgetPendingCreate(key, entry)
    releaseNonce(ownerId, CHARTERS_CONTRACT_ID, entry.reservation, spent ? BigInt(entry.signed.nonce) : undefined)
  }

  /** A create proved landed: its slot keeps a landed marker for a while (see {@link LandedCreate}), its nonce is spent. */
  private proved(ownerId: string, key: string, entry: PendingCreate): string {
    markLanded(key, entry)
    releaseNonce(ownerId, CHARTERS_CONTRACT_ID, entry.reservation, BigInt(entry.signed.nonce))
    return entry.signed.id
  }

  /**
   * Files a reason; resolves to its id. Codes are unique per owner, so a
   * reason this owner already filed with the same code and text (an earlier
   * try that landed unseen) is reused.
   */
  async fileReason(ownerId: string, reason: { code: string; label: string; description?: string }, { session }: { session?: number } = {}): Promise<string> {
    const data = { code: reason.code, label: reason.label.trim(), ...(reason.description?.trim() ? { description: reason.description.trim() } : {}) }
    try {
      return await this.file('reason', { ownerId, type: 'reason', data: async () => data, slot: data.code, fingerprint: JSON.stringify(data), session })
    } catch (error) {
      if (!(error instanceof CharterActionError) || error.code !== 40105) throw error
      const same = (await this.ownReasons(ownerId)).find((own) => own.code === data.code && own.label === data.label && (own.description ?? '') === (data.description ?? ''))
      if (same) return same.id
      throw error
    }
  }

  /**
   * Files the proposal (`submittedCharter`); resolves to its id. `stillOpen`
   * re-checks that no team holds the seat right before a new proposal is
   * signed (a resend of one already signed skips it).
   */
  async submitProposal(ownerId: string, terms: {
    targetContractId: string
    description: string
    reasonIds: readonly string[]
    moderatorsShare: number
    rewardSplit: RewardSplit
  }, { stillOpen, session }: { stillOpen?: () => Promise<void>; session?: number } = {}): Promise<string> {
    const w = await wasmModule()
    const data = {
      targetContractId: charterIdBytes(w, terms.targetContractId),
      description: terms.description,
      reasons: terms.reasonIds.map((id) => charterIdBytes(w, id)),
      moderatorsShare: terms.moderatorsShare,
      rewardSplit: { ...terms.rewardSplit },
    }
    const fingerprint = JSON.stringify({ ...terms, reasonIds: [...terms.reasonIds] })
    return this.file('proposal', { ownerId, type: 'submittedCharter', data: async () => data, slot: terms.targetContractId, fingerprint, beforeSigning: stillOpen, session })
  }

  /** Asks to join a proposal's team, with a message only its leader can read; resolves to the request's id. */
  async requestToJoin(ownerId: string, submittedCharterId: string, message: string): Promise<string> {
    // Built (and its charter key asked for) only when a new request is signed: a request
    // already signed, maybe sent, is resent as it is, its message encrypted then.
    const data = async (): Promise<Record<string, unknown>> => {
      const memberKey = await this.charterKey(ownerId, 'member', { create: true })
      try {
        const sdk = await getEvoSdk()
        const w = await wasmModule()
        const writer = await fetchIdentity(ownerId)
        const writerEncryptionKey = w.PrivateKey.fromWIF(privateKeyToWif(memberKey, keyNetwork()))
        try {
          const join = await sdk.moderationCharters.buildJoinRequest({ submittedCharterId, message, writer, writerEncryptionKey })
          try {
            // Keep the SDK's encryption envelope and key ids; the create derives its own system fields.
            return Object.fromEntries(Object.entries(join.toObject() as Record<string, unknown>).filter(([name]) => !name.startsWith('$')))
          } finally {
            join.free()
          }
        } finally {
          writerEncryptionKey.free()
        }
      } finally {
        memberKey.fill(0)
      }
    }
    // The message tells a retry from an edited request: hashed, so its text is never stored.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`yappr/join-request:${ownerId}:${submittedCharterId}:${message}`)))
    const fingerprint = `${submittedCharterId}:${bytesToBase64(digest)}`
    return this.file('join', { ownerId, type: 'joinRequest', data, slot: submittedCharterId, fingerprint })
  }

  /**
   * Files the application (`electedCharter`) for `proposal` with `members`,
   * paying the 0.5 DASH contest deposit; resolves to its id. `stillEligible`
   * re-checks the election (window open, no seat, not applied, balance) right
   * before a new application is signed, after the key prompt and any wait
   * for another tab's write; a resend of one already signed skips it.
   */
  async fileApplication(
    ownerId: string, proposal: CharterProposal, targetContractId: string, members: readonly string[], stillEligible?: () => Promise<void>,
  ): Promise<string> {
    const w = await wasmModule()
    const data = {
      targetContractId: charterIdBytes(w, targetContractId),
      submittedCharterId: charterIdBytes(w, proposal.id),
      members: members.map((id) => charterIdBytes(w, id)),
    }
    // One application per target: a changed member list waits for an earlier try to resolve.
    return this.file('application', { ownerId, type: 'electedCharter', data: async () => data, slot: targetContractId,
      fingerprint: `${proposal.id}:${[...members].sort().join(',')}`, targetContractId, fund: true, beforeSigning: stillEligible })
  }

  /** Adds a member from the proposal's join requests to the seated team. */
  async addMember(ownerId: string, seated: { electedCharterId: string; submittedCharterId: string }, memberId: string): Promise<string> {
    const w = await wasmModule()
    const data = {
      electedCharterId: charterIdBytes(w, seated.electedCharterId),
      submittedCharterId: charterIdBytes(w, seated.submittedCharterId),
      memberId: charterIdBytes(w, memberId),
    }
    const slot = `${seated.electedCharterId}:${memberId}`
    return this.file('add-member', { ownerId, type: 'addedModerator', data: async () => data, slot, fingerprint: slot })
  }

  /** Takes an elected member off the seated team. */
  async removeMember(ownerId: string, electedCharterId: string, memberId: string): Promise<string> {
    const w = await wasmModule()
    const data = { electedCharterId: charterIdBytes(w, electedCharterId), memberId: charterIdBytes(w, memberId) }
    const slot = `${electedCharterId}:${memberId}`
    return this.file('remove-member', { ownerId, type: 'removedModerator', data: async () => data, slot, fingerprint: slot })
  }

  /**
   * Deletes a team change: an addition (takes that member off) or a removal
   * (puts that elected member back). Its slot's landed marker goes with it,
   * so the same change made again is signed, not answered from the marker.
   */
  async undoTeamChange(ownerId: string, type: 'addedModerator' | 'removedModerator', change: { documentId: string; electedCharterId: string; memberId: string }): Promise<void> {
    const { documentId } = change
    const key = `${ownerId}:${type}:${change.electedCharterId}:${change.memberId}`
    const generation = this.generation
    let sent = false
    try {
      const { wif, identityKey } = await this.signingKey(ownerId, generation)
      const sdk = await getEvoSdk()
      const w = await wasmModule()
      // The SDK picks this nonce itself: the coordinator holds other writes off it. Queued behind
      // another write, a session forgotten meanwhile fails the precondition: nothing reserved or sent.
      await withSdkSignedWrite(ownerId, CHARTERS_CONTRACT_ID, async () => {
        this.assertSameSession(generation)
        const signer = new w.IdentitySigner()
        const privateKey = w.PrivateKey.fromWIF(wif)
        try {
          signer.addKey(privateKey)
          sent = true
          await sdk.documents.delete({ document: { id: documentId, ownerId, dataContractId: CHARTERS_CONTRACT_ID, documentTypeName: type }, identityKey, signer })
        } finally {
          signer.free()
          privateKey.free()
        }
      }, `${type}:${documentId}`, async () => generation === this.generation)
    } catch (error) {
      if (error instanceof Error && error.message === WRITE_PRECONDITION_FAILED) throw new CharterActionError('Nothing was sent.', 'cancelled')
      throw charterActionError('undo-team-change', error)
    } finally {
      // Once the delete was sent, whatever its outcome: a stale "filed" is worse than a refused duplicate.
      if (sent) await withIdentityWriteLock(ownerId, CHARTERS_CONTRACT_ID, async () => {
        try {
          const stored = loadSlot(key)
          if (stored && isLanded(stored) && stored.landed === documentId) localStorage.removeItem(PENDING_PREFIX + key)
        } catch {
          // Storage blocked or unreadable: nothing of ours to drop.
        }
      })
    }
  }
}

export const charterService = new CharterService()
