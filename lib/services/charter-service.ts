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
import { requireBytes } from '@/lib/bytes'
import { cancelKeyStepUp, requestKeyStepUp } from '@/lib/auth/key-step-up'
import { hasAppConnectSession } from '@/lib/auth/signing-keys'
import { getPrivateKey } from '@/lib/secure-storage'
import { extractErrorMessage, isAlreadyExistsError, sentWriteOutcomeUnknown } from '@/lib/error-utils'
import { sleep } from '@/lib/retry-utils'
import { CHARTERS_CONTRACT_ID, CHARTER_KEYS, isCharterKey, type RewardSplit } from '@/lib/moderation-charters/rules.mjs'
import {
  charterIdBytes, charterKeyInCreation, charterNonceConsumed, charterStepExists, nextCharterNonce, signCharterCreate,
  type CharterDocumentType, type SignedCharterCreate,
} from '@/lib/moderation-charters/transitions.mjs'
import {
  deriveCharterKey, forgetCharterKeys, heldCharterKey, holdCharterKey, keyMatches, readPrivateKeyInput, type CharterRole,
} from '@/lib/moderation-charters/charter-keys'
import { CHARTER_UNCERTAIN_MESSAGE, CharterActionError, charterActionError, type CharterAction } from '@/lib/moderation-charters/refusals'
import type { CreateFees } from '@/lib/moderation-charters/costs'
import { getEvoSdk } from './evo-sdk-service'
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
  /**
   * Signed creates not yet proved, by owner, type and what they are for (the
   * target, the proposal, the reason code): at most one per slot, retried
   * byte for byte, never re-signed while it may still land.
   */
  private pending = new Map<string, { signed: SignedCharterCreate; fingerprint: string }>()
  /** The write each slot has under way, so a second click joins it instead of signing again. */
  private inFlight = new Map<string, Promise<string>>()
  /** The highest charters nonce proved per identity, so a lagging read never reuses one. */
  private nonceFloors = new Map<string, bigint>()
  /** Bumped by `forgetKeys`: a key answered for an earlier generation is never kept. */
  private generation = 0

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
  private async signingKey(identityId: string): Promise<{ wif: string; identityKey: IdentityPublicKey }> {
    const identity = await fetchIdentity(identityId)
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
    const generation = this.generation
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
  async charterKey(identityId: string, role: CharterRole, { create }: { create: boolean }): Promise<Uint8Array> {
    const identity = await fetchIdentity(identityId)
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
        if (!isMaster(privateKeyToWif(bytes, keyNetwork()))) return null
        const derived = deriveCharterKey(bytes, identityId, role)
        if (!onChainData || keyMatches(derived, onChainData)) return derived
        derived.fill(0)
        return null
      } finally {
        bytes.fill(0)
      }
    }
    const generation = this.generation
    const input = await requestKeyStepUp({
      identityId,
      title: onChain ? 'Unlock your charter key' : 'Set up your charter key',
      description: onChain
        ? (role === 'leader' ? 'Join messages are encrypted to your charter key.' : 'Your join message is encrypted with your charter key.')
          + ' Enter your MASTER key (Yappr makes your charter key from it) or the charter key itself. It stays in this tab only.'
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
          if (onChain && isMaster(asWif(typed))) return "Your account's charter key wasn't made from this MASTER key. Enter the charter key itself."
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
      if (!onChain) await this.addCharterKey(identityId, identity, role, readPrivateKeyInput(input), key)
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
  ): Promise<void> {
    const sdk = await getEvoSdk()
    const w = await wasmModule()
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
      master.fill(0)
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
  }

  // ---- writes -----------------------------------------------------------------

  /**
   * Signs (once) and files one charters create in `slot`, then proves it,
   * resolving to the document id. Each slot (owner, type, what it is for)
   * holds at most one signed create until it is proved or known dead:
   *
   * - a definite refusal drops it;
   * - an outcome without a verdict keeps it, and the next try broadcasts
   *   exactly the same bytes, never a new transition under a new nonce;
   * - once its nonce is used up and the document is still absent, it can
   *   never land, so it is dropped and the caller told to check and retry;
   * - a try with different contents while one may still land is refused,
   *   so an edit after a timeout can never file a second proposal or pay a
   *   second deposit.
   */
  private file(action: CharterAction, input: {
    ownerId: string
    type: CharterDocumentType
    data: Record<string, unknown>
    /** What the create is for: a second create there waits for this one. */
    slot: string
    /** What it says, to tell a retry from a changed write. */
    fingerprint: string
    targetContractId?: string
    fund?: boolean
  }): Promise<string> {
    const key = `${input.ownerId}:${input.type}:${input.slot}`
    const running = this.inFlight.get(key)
    if (running) return running
    const work = this.fileOnce(key, input).catch((error: unknown) => {
      throw charterActionError(action, error)
    }).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, work)
    return work
  }

  private async fileOnce(key: string, input: Parameters<CharterService['file']>[1]): Promise<string> {
    const { ownerId, type, data, fingerprint, targetContractId = '', fund = false } = input
    const sdk = await getEvoSdk()
    const w = await wasmModule()
    const exists = (signed: SignedCharterCreate) => charterStepExists(w, sdk, signed, targetContractId).catch(() => false)
    let entry = this.pending.get(key)
    if (entry) {
      if (await exists(entry.signed)) return this.proved(key, entry.signed)
      if (await charterNonceConsumed(sdk, ownerId, entry.signed.nonce).catch(() => false)) {
        // Its nonce is used: it either landed (a lagging read) or never will.
        if (await this.proveWithin(exists, entry.signed)) return this.proved(key, entry.signed)
        this.pending.delete(key)
        entry = undefined
      } else if (entry.fingerprint !== fingerprint) {
        throw new CharterActionError('Your last try may still go through. Check again in a minute before changing anything.', 'uncertain')
      }
    }
    if (!entry) {
      const { wif, identityKey } = await this.signingKey(ownerId)
      const nonce = await nextCharterNonce(sdk, ownerId, this.nonceFloors.get(ownerId) ?? 0n)
      const privateKey = w.PrivateKey.fromWIF(wif)
      try {
        entry = { signed: await signCharterCreate(w, sdk, { type, ownerId, data, nonce, privateKey, identityKey, fund }), fingerprint }
      } finally {
        privateKey.free()
      }
      this.pending.set(key, entry)
    }
    const { signed } = entry
    try {
      await sdk.stateTransitions.broadcastAndWait(w.StateTransition.fromBytes(signed.bytes))
    } catch (error) {
      // A verdict on these bytes drops them. "Already in the mempool or chain",
      // a nonce already at the tip (these bytes executed on an earlier try) and
      // a lost connection are not verdicts: prove the document instead.
      if (!isAlreadyExistsError(error) && !sentWriteOutcomeUnknown(error)) {
        this.pending.delete(key)
        throw error
      }
      logger.warn(`charters: ${type} ${signed.id} reported no verdict; checking for it`, extractErrorMessage(error))
    }
    if (await this.proveWithin(exists, signed)) return this.proved(key, signed)
    if (await charterNonceConsumed(sdk, ownerId, signed.nonce).catch(() => false)) {
      this.pending.delete(key)
      throw new CharterActionError("This wasn't recorded. Check, then try again.", 'refused')
    }
    throw new CharterActionError(CHARTER_UNCERTAIN_MESSAGE, 'uncertain')
  }

  /** Whether `signed` is proved within about a minute. */
  private async proveWithin(exists: (signed: SignedCharterCreate) => Promise<boolean>, signed: SignedCharterCreate): Promise<boolean> {
    for (let attempt = 0; attempt < PROOF_ATTEMPTS; attempt++) {
      if (await exists(signed)) return true
      await sleep(PROOF_PAUSE_MS)
    }
    return false
  }

  private proved(key: string, signed: SignedCharterCreate): string {
    this.pending.delete(key)
    const nonce = BigInt(signed.nonce)
    if (nonce > (this.nonceFloors.get(signed.owner) ?? 0n)) this.nonceFloors.set(signed.owner, nonce)
    return signed.id
  }

  /**
   * Files a reason; resolves to its id. Codes are unique per owner, so a
   * reason this owner already filed with the same code and text (an earlier
   * try that landed unseen) is reused.
   */
  async fileReason(ownerId: string, reason: { code: string; label: string; description?: string }): Promise<string> {
    const data = { code: reason.code, label: reason.label.trim(), ...(reason.description?.trim() ? { description: reason.description.trim() } : {}) }
    try {
      return await this.file('reason', { ownerId, type: 'reason', data, slot: data.code, fingerprint: JSON.stringify(data) })
    } catch (error) {
      if (!(error instanceof CharterActionError) || error.code !== 40105) throw error
      const same = (await this.ownReasons(ownerId)).find((own) => own.code === data.code && own.label === data.label && (own.description ?? '') === (data.description ?? ''))
      if (same) return same.id
      throw error
    }
  }

  /** Files the proposal (`submittedCharter`); resolves to its id. */
  async submitProposal(ownerId: string, terms: {
    targetContractId: string
    description: string
    reasonIds: readonly string[]
    moderatorsShare: number
    rewardSplit: RewardSplit
  }): Promise<string> {
    const w = await wasmModule()
    const data = {
      targetContractId: charterIdBytes(w, terms.targetContractId),
      description: terms.description,
      reasons: terms.reasonIds.map((id) => charterIdBytes(w, id)),
      moderatorsShare: terms.moderatorsShare,
      rewardSplit: { ...terms.rewardSplit },
    }
    const fingerprint = JSON.stringify({ ...terms, reasonIds: [...terms.reasonIds] })
    return this.file('proposal', { ownerId, type: 'submittedCharter', data, slot: terms.targetContractId, fingerprint })
  }

  /** Asks to join a proposal's team, with a message only its leader can read; resolves to the request's id. */
  async requestToJoin(ownerId: string, submittedCharterId: string, message: string): Promise<string> {
    // A request already signed (and maybe sent) is retried as it is: its message was encrypted then.
    const pending = this.pending.get(`${ownerId}:joinRequest:${submittedCharterId}`)
    let data: Record<string, unknown> = {}
    if (!pending) {
      const memberKey = await this.charterKey(ownerId, 'member', { create: true }).catch((error: unknown) => {
        throw charterActionError('join', error)
      })
      try {
        const sdk = await getEvoSdk()
        const w = await wasmModule()
        const writer = await fetchIdentity(ownerId)
        const writerEncryptionKey = w.PrivateKey.fromWIF(privateKeyToWif(memberKey, keyNetwork()))
        try {
          const join = await sdk.moderationCharters.buildJoinRequest({ submittedCharterId, message, writer, writerEncryptionKey })
          try {
            // Keep the SDK's encryption envelope and key ids; the create derives its own system fields.
            data = Object.fromEntries(Object.entries(join.toObject() as Record<string, unknown>).filter(([name]) => !name.startsWith('$')))
          } finally {
            join.free()
          }
        } finally {
          writerEncryptionKey.free()
        }
      } catch (error) {
        throw charterActionError('join', error)
      } finally {
        memberKey.fill(0)
      }
    }
    return this.file('join', { ownerId, type: 'joinRequest', data, slot: submittedCharterId, fingerprint: submittedCharterId })
  }

  /**
   * Files the application (`electedCharter`) for `proposal` with `members`,
   * paying the 0.5 DASH contest deposit; resolves to its id.
   */
  async fileApplication(ownerId: string, proposal: CharterProposal, targetContractId: string, members: readonly string[]): Promise<string> {
    const w = await wasmModule()
    const data = {
      targetContractId: charterIdBytes(w, targetContractId),
      submittedCharterId: charterIdBytes(w, proposal.id),
      members: members.map((id) => charterIdBytes(w, id)),
    }
    // One application per target: a changed member list waits for an earlier try to resolve.
    return this.file('application', { ownerId, type: 'electedCharter', data, slot: targetContractId,
      fingerprint: `${proposal.id}:${[...members].sort().join(',')}`, targetContractId, fund: true })
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
    return this.file('add-member', { ownerId, type: 'addedModerator', data, slot, fingerprint: slot })
  }

  /** Takes an elected member off the seated team. */
  async removeMember(ownerId: string, electedCharterId: string, memberId: string): Promise<string> {
    const w = await wasmModule()
    const data = { electedCharterId: charterIdBytes(w, electedCharterId), memberId: charterIdBytes(w, memberId) }
    const slot = `${electedCharterId}:${memberId}`
    return this.file('remove-member', { ownerId, type: 'removedModerator', data, slot, fingerprint: slot })
  }

  /**
   * Deletes a team change: an addition (takes that member off) or a removal
   * (puts that elected member back).
   */
  async undoTeamChange(ownerId: string, type: 'addedModerator' | 'removedModerator', documentId: string): Promise<void> {
    try {
      const { wif, identityKey } = await this.signingKey(ownerId)
      const sdk = await getEvoSdk()
      const w = await wasmModule()
      // The SDK keeps its own nonce cache; creates signed here went around it.
      await sdk.wasm.refreshIdentityNonce(w.Identifier.fromBase58(ownerId))
      const signer = new w.IdentitySigner()
      const privateKey = w.PrivateKey.fromWIF(wif)
      try {
        signer.addKey(privateKey)
        await sdk.documents.delete({ document: { id: documentId, ownerId, dataContractId: CHARTERS_CONTRACT_ID, documentTypeName: type }, identityKey, signer })
      } finally {
        signer.free()
        privateKey.free()
      }
    } catch (error) {
      throw charterActionError('undo-team-change', error)
    }
  }
}

export const charterService = new CharterService()
