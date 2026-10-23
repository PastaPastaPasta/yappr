'use client'

/**
 * Sign in with a passkey (docs/PASSKEY_VAULT.md).
 *
 * A signed-in session adds a passkey: Yappr writes one `vaultEntry` holding
 * the session's own signing keys, sealed so only that passkey opens it. On
 * any other browser on yap.pr, picking the passkey opens the entry, every key
 * is checked against the identity on chain, and the same session comes back:
 *
 * - a wallet (App Connect) sign-in comes back as its key ring, with the grant's
 *   limits; an expired, spent or revoked grant leads to renewing in the wallet;
 * - a key sign-in comes back as that key and the messaging key. A CRITICAL key
 *   that is not group-bound is kept only for moderators, checked when the
 *   passkey is added, updated and used.
 *
 * MASTER and TRANSFER keys never go in. Any signed-in device can update every
 * passkey's entry without a passkey prompt, so updates are never silent: the
 * user reviews the list first (lib/auth/passkey-vault-policy.ts has the rules).
 * Every private key read here is wiped on every path, success or throw.
 */
import bs58 from 'bs58'
import {
  APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS,
  KeyPurpose,
  KeySecurityLevel,
  PasskeyCancelledError,
  PasskeyExistsError,
  clearSensitiveBytes,
  createPasskeyWithPrf,
  getPasskeyPrf,
  passkeysAvailable,
  signalUnknownPasskey,
  verifyAppConnectKeys,
  type AppConnectGrant,
  type AppConnectIdentityKey,
  type AppConnectRejectReason,
  type PasskeyRelyingParty,
} from 'platform-auth'
import { logger } from '@/lib/logger'
import { STORAGE_SCOPE } from '@/lib/storage-scope'
import { base64ToBytes, bytesEqual, bytesToBase64, bytesToBase64Url, bytesToHex, hexToBytes } from '@/lib/bytes'
import { YAPPR_PASSKEY_VAULT_CONTRACT_ID, getConfiguredNetwork, keyNetwork } from '@/lib/constants'
import { getPublicKey, matchIdentityKey } from '@/lib/crypto/keys'
import { parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'
import { resolveEncryptionPublicKey } from '@/lib/crypto/encryption-key-lookup'
import {
  BundleFormat,
  VaultCryptoError,
  openEntry,
  prfInput,
  recipientFromPrf,
  sealEntry,
  wipeBundle,
  type VaultBundle,
  type VaultKey,
} from '@/lib/crypto/passkey-vault'
import { appConnectPins, isAppConnectBuild } from '@/lib/app-connect/config'
import { appConnectPlatformPort } from '@/lib/app-connect/platform-port'
import { appConnectSessions } from '@/lib/app-connect/session-manager'
import { primaryGroupKey } from '@/lib/app-connect/session-health'
import { wipeGrant } from '@/lib/app-connect/wallet-sign-in'
import { buildYapprAppConnectRequest } from '@/lib/app-connect/yappr-request'
import { rememberAnchorKey } from '@/lib/app-connect/anchor-key-mark'
import {
  expectPasskeyCriticalKey,
  getEncryptionKeyBytes,
  getPrivateKey,
  settlePasskeyCriticalKey,
  storeEncryptionKey,
  storeEncryptionKeyType,
} from '@/lib/secure-storage'
import { passkeyVaultService, type VaultEntryDocument } from '@/lib/services/passkey-vault-service'
import type { CreateReceipt } from '@/lib/services/state-transition-service'
import { withIdentityWriteLock } from '@/lib/identity-write-lock'
import {
  forgetPasskeyHere,
  forgetUnsettledPasskey,
  passkeyMarker,
  passkeyName,
  passkeysHere,
  rememberPasskeyHere,
  rememberUnsettledPasskey,
  unsettledPasskey,
} from './passkey-device'
import {
  MAX_PASSKEYS,
  checkSignInKey,
  entryNeedsUpdate,
  identityOfUserHandle,
  keyRingBundle,
  passkeyDisplayName,
  passkeyRpId,
  passkeyUserHandle,
  primaryGrantedKey,
  rawKeyBundle,
  slotFor,
} from './passkey-vault-policy'

export type PasskeyErrorCode =
  /** The user closed the passkey sheet: say nothing. */
  | 'cancelled'
  /** The passkey gives no PRF output, so it cannot open (or seal) an entry. */
  | 'no-prf'
  /** The browser refused to make a second passkey for this account in the same provider. */
  | 'exists'
  | 'limit'
  /** The passkey is not one of Yappr's (no or a malformed user handle). */
  | 'not-yappr'
  /** No entry for this passkey here (another network or deployment, or removed). */
  | 'not-set-up'
  /** The entry holds a key the identity no longer has, or that no longer checks out. */
  | 'stale'
  /** This session cannot keep a passkey (say, a CRITICAL key that is not a moderator's). */
  | 'not-eligible'
  /** The wallet sign-in this session runs on needs renewing first. */
  | 'renew-first'
  /** Wallet sign-in is paused on this build (the group check failed). */
  | 'untrusted'
  /** The entry was sent but is not confirmed yet: it may still land, so another passkey is not needed. */
  | 'pending'
  /** A read failed or something unexpected happened: try again. */
  | 'failed'

export class PasskeyVaultError extends Error {
  constructor(readonly code: PasskeyErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'PasskeyVaultError'
  }
}

/** A passkey whose wallet sign-in expired, ran out or was turned off: renew it in the wallet first. */
export interface PasskeyRenewal {
  identityId: string
  reason: 'expired' | 'revoked'
}

const RP_NAME = 'Yappr'

const VAULT_CONTRACT_ID: Uint8Array | null = (() => {
  try {
    const bytes = bs58.decode(YAPPR_PASSKEY_VAULT_CONTRACT_ID)
    return bytes.length === 32 ? bytes : null
  } catch {
    return null
  }
})()

interface Setup {
  rp: PasskeyRelyingParty
  contractId: Uint8Array
}

/** Where passkeys work: a configured vault, on yap.pr (or localhost), in a browser that runs WebAuthn. Null elsewhere. */
function setup(): Setup | null {
  if (typeof window === 'undefined' || !VAULT_CONTRACT_ID || !passkeysAvailable()) return null
  const id = passkeyRpId(window.location.hostname)
  return id ? { rp: { id, name: RP_NAME }, contractId: VAULT_CONTRACT_ID } : null
}

/** Whether this page offers passkeys at all. */
export function passkeysOffered(): boolean {
  return setup() !== null
}

function requireSetup(): Setup {
  const found = setup()
  if (!found) throw new PasskeyVaultError('failed', 'Passkeys are not available here')
  return found
}

const identityBytes = (identityId: string): Uint8Array => bs58.decode(identityId)

function vaultIsPinned(): boolean {
  return Boolean(appConnectPins()?.members.some((member) => member.contractId === YAPPR_PASSKEY_VAULT_CONTRACT_ID))
}

/** Whether this build's wallet sign-in can keep passkeys: the vault is one of its pinned group members. */
export function walletPasskeysPossible(): boolean {
  return isAppConnectBuild() && vaultIsPinned()
}

/** Whether the wallet's group key can sign for the vault now (the trust check vouched for it). */
async function groupCoversVault(): Promise<boolean> {
  if (!vaultIsPinned()) return false
  const trust = await appConnectSessions.trust()
  return trust.group.members.some((member) => member.kind === 'contract' && member.contractId === YAPPR_PASSKEY_VAULT_CONTRACT_ID)
}

/**
 * Whether `identityId` sits on a moderation team now (social, storefront or
 * blog: the seated leader and members, or the appointed moderators while no
 * team is seated), read fresh. A contract owner that moderates under an
 * interim does not count. Throws when a team cannot be read, so a failed read
 * never passes for either answer.
 */
async function isModeratorAnywhere(identityId: string): Promise<boolean> {
  const { moderationServiceFor } = await import('@/lib/services/moderation-service')
  for (const key of ['social', 'storefront', 'blog'] as const) {
    const team = await moderationServiceFor(key).getTeam({ fresh: true })
    if (team?.appointed.includes(identityId)) return true
  }
  return false
}

/**
 * Whether this session may keep (or use) the checked sign-in key. A CRITICAL
 * key needing the moderator check is refused outright where it would be
 * stored past the tab (builds without App Connect persist every typed key).
 */
async function signInKeyAllowed(identityId: string, needsModerator: boolean): Promise<boolean> {
  if (!needsModerator) return true
  return isAppConnectBuild() && isModeratorAnywhere(identityId)
}

/**
 * The request Yappr makes a wallet today. A kept grant is checked against its
 * bindings; the ephemeral key and connection id are placeholders the checks
 * never read.
 */
function walletRequest() {
  const pins = appConnectPins()
  if (!pins) throw new PasskeyVaultError('untrusted')
  return buildYapprAppConnectRequest({ pins, appEphemeralPubKey: new Uint8Array(33), connectionId: new Uint8Array(16), createdAt: Date.now() })
}

type KeptGrant = { ok: true; grant: AppConnectGrant } | { ok: false; reason: AppConnectRejectReason }

/**
 * Rebuilds a wallet grant from kept private keys, checked on chain as a fresh
 * wallet answer is. A secondary key that is refused (the DashPay profile key
 * spent, a superseded messaging key) is dropped and the rest checked again;
 * only the group key at `primaryIndex` decides. A read that may only lag
 * (an identity, key or budget not visible yet) throws `failed` rather than
 * dropping or refusing anything.
 * Wipes `privateKeys`.
 */
async function verifyKeptGrant(identityId: string, privateKeys: Uint8Array[], primaryIndex: number): Promise<KeptGrant> {
  try {
    const request = walletRequest()
    let keys = privateKeys
    let primary = primaryIndex
    for (;;) {
      const result = await verifyAppConnectKeys({
        request,
        ownerId: identityId,
        identity: appConnectPlatformPort,
        now: Date.now(),
        // The signing margin, as entryNeedsUpdate uses: a key that still signs is not "expired" here and "healthy" there.
        expiryMarginMs: APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS,
        privateKeys: keys.map((key) => key.slice()),
      })
      if (result.ok) return result
      // For a fresh answer a superseded encryption key may be a lagging read; for a kept one it is final.
      const final = !result.retryable || result.reason === 'encryption-key-not-current'
      if (!final) throw new PasskeyVaultError('failed', `wallet keys could not be checked yet (${result.reason})`)
      const slot = result.slot
      if (slot === undefined || slot === primary) return { ok: false, reason: result.reason }
      keys = keys.filter((_, index) => index !== slot)
      if (slot < primary) primary -= 1
    }
  } finally {
    privateKeys.forEach(clearSensitiveBytes)
  }
}

async function freshKeys(identityId: string): Promise<AppConnectIdentityKey[]> {
  const identity = await appConnectPlatformPort.getIdentityFresh(identityId)
  if (!identity) throw new PasskeyVaultError('failed', 'Identity not found')
  return identity.publicKeys
}

/**
 * The slot for `privateKey` as `identityId`'s messaging key, or null unless
 * it is the key peers encrypt to now (on App Connect builds, the anchor's).
 * A failed check leaves the messaging key out.
 */
async function messagingSlot(identityId: string, privateKey: Uint8Array, keys: AppConnectIdentityKey[]): Promise<VaultKey | null> {
  try {
    const publicKey = getPublicKey(privateKey)
    const current = await resolveEncryptionPublicKey(identityId, async () => keys.map((key) => ({
      id: key.id, type: key.type, purpose: key.purpose, data: key.data,
      ...(key.disabledAt !== undefined ? { disabledAt: key.disabledAt } : {}),
    })))
    if (!current || !bytesEqual(current, publicKey)) return null
    const key = keys.find((candidate) => candidate.purpose === KeyPurpose.ENCRYPTION
      && candidate.securityLevel === KeySecurityLevel.MEDIUM
      && candidate.disabledAt === undefined
      && bytesEqual(candidate.data, publicKey))
    return key ? slotFor(key, privateKey) : null
  } catch (error) {
    logger.warn('Passkey vault: could not check the messaging key; leaving it out', error)
    return null
  }
}

/** This session's key ring as a bundle, checked on chain now. */
async function keyRingSessionBundle(identityId: string): Promise<VaultBundle> {
  const ring = appConnectSessions.current(identityId)
  if (!ring) throw new PasskeyVaultError('not-eligible')
  if (!await groupCoversVault()) throw new PasskeyVaultError('not-eligible')
  const primaryRef = primaryGroupKey(ring)?.keyRef
  const privateKeys: Uint8Array[] = []
  let primaryIndex = -1
  try {
    for (const ref of [...ring.authKeys.map((key) => key.keyRef), ...ring.encKeys.map((key) => key.keyRef)]) {
      const key = await appConnectSessions.keyStore().privateKey(ring, ref)
      if (!key) continue
      if (ref === primaryRef) primaryIndex = privateKeys.length
      privateKeys.push(key)
    }
  } catch (error) {
    privateKeys.forEach(clearSensitiveBytes)
    throw error
  }
  if (primaryIndex === -1) {
    privateKeys.forEach(clearSensitiveBytes)
    throw new PasskeyVaultError('renew-first')
  }
  const kept = await verifyKeptGrant(identityId, privateKeys, primaryIndex)
  if (!kept.ok) throw new PasskeyVaultError('renew-first')
  try {
    return keyRingBundle(kept.grant)
  } finally {
    wipeGrant(kept.grant)
  }
}

/** This session's typed-in key (and messaging key) as a bundle, checked on chain now. */
async function rawKeySessionBundle(identityId: string): Promise<VaultBundle> {
  const wif = getPrivateKey(identityId)
  if (!wif) throw new PasskeyVaultError('not-eligible')
  const keys = await freshKeys(identityId)
  const match = matchIdentityKey(wif, keys, {
    network: keyNetwork(),
    purpose: KeyPurpose.AUTHENTICATION,
    allowedSecurityLevels: [KeySecurityLevel.CRITICAL, KeySecurityLevel.HIGH],
  })
  if (!match.ok) throw new PasskeyVaultError('not-eligible')
  const signIn = slotFor(match.key, parsePrivateKey(wif).privateKey)
  let messaging: VaultKey | null = null
  try {
    const check = checkSignInKey(signIn, keys, Date.now(), appConnectPins()?.groupId ?? null)
    if (!check.ok || !await signInKeyAllowed(identityId, check.needsModerator)) throw new PasskeyVaultError('not-eligible')
    const messagingKey = getEncryptionKeyBytes(identityId)
    messaging = messagingKey ? await messagingSlot(identityId, messagingKey, keys) : null
    if (!messaging) messagingKey?.fill(0)
    return rawKeyBundle(signIn, messaging)
  } catch (error) {
    signIn.privateKey.fill(0)
    messaging?.privateKey.fill(0)
    throw error
  }
}

/**
 * The bundle this session would keep in a passkey, checked on chain now.
 * Throws {@link PasskeyVaultError} when the session cannot keep one. The
 * caller wipes the bundle.
 */
function sessionBundle(identityId: string): Promise<VaultBundle> {
  return appConnectSessions.current(identityId) ? keyRingSessionBundle(identityId) : rawKeySessionBundle(identityId)
}

/** Why this session cannot keep a passkey, or null when it can. Reads chain. */
export async function passkeyEligibility(identityId: string): Promise<PasskeyErrorCode | null> {
  try {
    wipeBundle(await sessionBundle(identityId))
    return null
  } catch (error) {
    if (error instanceof PasskeyVaultError) return error.code
    logger.warn('Passkey vault: could not check this session:', error)
    return 'failed'
  }
}

/** Runs a WebAuthn ceremony, turning a closed sheet or an existing passkey into vault errors. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof PasskeyCancelledError) throw new PasskeyVaultError('cancelled')
    if (error instanceof PasskeyExistsError) throw new PasskeyVaultError('exists')
    throw error
  }
}

/**
 * Enrolments whose entry was sent but not confirmed, by identity. Kept in this
 * browser until they settle, across reloads and sign-outs (public facts only,
 * lib/auth/passkey-device.ts), unlike the recognition markers: a new passkey
 * excludes their credentials, and only a proved outcome or a confirmed removal
 * retires them. This map holds the restored objects, so a dialog keeps the one it shows.
 */
const pendingEnrolments = new Map<string, PendingPasskey>()

/** The enrolment still settling for `identityId` in this browser, if any. */
export function pendingEnrolmentFor(identityId: string): PendingPasskey | null {
  const held = pendingEnrolments.get(identityId)
  if (held) return held
  const restored = restorePending(identityId)
  if (restored) pendingEnrolments.set(identityId, restored)
  return restored
}

/** The session ended: this tab lets go of its copies. The stored record stays until the enrolment settles. */
export function forgetPendingEnrolments(): void {
  pendingEnrolments.clear()
}

function restorePending(identityId: string): PendingPasskey | null {
  const stored = unsettledPasskey(identityId)
  // Another deployment's vault: not this one's to settle (its user handle names that vault).
  if (!stored || !setup() || stored.vault !== YAPPR_PASSKEY_VAULT_CONTRACT_ID) return null
  const credentialId = base64UrlToBytes(stored.credentialId)
  let sentTo: Uint8Array
  try {
    sentTo = hexToBytes(stored.recipientKey)
  } catch {
    return null
  }
  if (!credentialId || sentTo.length !== 32) return null
  let receipts: CreateReceipt[]
  try {
    receipts = stored.receipts.map((receipt) => ({ ...receipt, nonce: BigInt(receipt.nonce), transition: base64ToBytes(receipt.transition) }))
  } catch {
    return null
  }
  // Only this identity's writes to this vault settle it.
  if (receipts.some((receipt) => receipt.ownerId !== identityId || receipt.contractId !== YAPPR_PASSKEY_VAULT_CONTRACT_ID)) return null
  return { identityId, credentialId, createPrf: null, sentTo, receipts }
}

/**
 * Holds an enrolment whose entry is about to be sent (one more write), in
 * this tab and in this browser. Runs under the identity's cross-tab write
 * lock, right before the broadcast: `busy` when this browser already holds
 * another passkey's unsettled enrolment for the identity (one at a time, so
 * no record is ever overwritten), `unstored` when the browser could not store it.
 */
function holdPending(pending: PendingPasskey, sentTo: Uint8Array, receipt: CreateReceipt | undefined, resuming: boolean): 'held' | 'busy' | 'unstored' | 'settled' {
  // What is stored decides, the same way a reload reads it (another vault's or an unreadable record is not one).
  const stored = restorePending(pending.identityId)
  if (stored && !bytesEqual(stored.credentialId, pending.credentialId)) return 'busy'
  // A later write resumes a record: one gone meanwhile was settled (and may have been dropped) elsewhere.
  if (resuming && !stored) return 'settled'
  pending.sentTo = sentTo
  // Merged with what another tab may have sent for it meanwhile: a write is only ever added, never dropped.
  pending.receipts = mergeReceipts(stored?.receipts, pending.receipts, receipt ? [receipt] : [])
  pendingEnrolments.set(pending.identityId, pending)
  return writePending(pending) ? 'held' : 'unstored'
}

/** Every write in `lists`, once each (by document id). */
function mergeReceipts(...lists: (CreateReceipt[] | undefined)[]): CreateReceipt[] {
  const byId = new Map<string, CreateReceipt>()
  for (const list of lists) for (const receipt of list ?? []) byId.set(receipt.documentId, receipt)
  return [...byId.values()]
}

function writePending(pending: PendingPasskey): boolean {
  if (!pending.sentTo) return false
  return rememberUnsettledPasskey(pending.identityId, {
    vault: YAPPR_PASSKEY_VAULT_CONTRACT_ID,
    credentialId: bytesToBase64Url(pending.credentialId),
    recipientKey: bytesToHex(pending.sentTo),
    receipts: (pending.receipts ?? []).map((sent) => ({ ...sent, nonce: sent.nonce.toString(), transition: bytesToBase64(sent.transition) })),
  })
}

/**
 * Brings `pending` up to date with what is stored (another tab may have sent
 * or settled it). False when nothing is stored for it any more: it settled elsewhere.
 */
function refreshPending(pending: PendingPasskey): boolean {
  const stored = restorePending(pending.identityId)
  if (!stored || !bytesEqual(stored.credentialId, pending.credentialId)) return false
  pending.sentTo = stored.sentTo
  pending.receipts = mergeReceipts(stored.receipts, pending.receipts)
  return true
}

/**
 * Seals the session to `recipientKey` for `pending`'s passkey and sends it,
 * holding the enrolment before anything goes out. True once the entry is
 * confirmed or seen; false while it settles. `retireOnVerdict`: a refusal (or
 * nothing sent) ends the enrolment, true only for its first write.
 */
async function sendEntry(pending: PendingPasskey, recipientKey: Uint8Array, retireOnVerdict: boolean, replacesNonce?: bigint): Promise<boolean> {
  const { contractId } = requireSetup()
  if (!pending.vouchedFor || !bytesEqual(pending.vouchedFor, recipientKey)) throw new PasskeyVaultError('failed', 'the passkey has not vouched for this recipient key')
  const bundle = await sessionBundle(pending.identityId)
  let sealed
  try {
    sealed = sealEntry({ contractId, ownerId: identityBytes(pending.identityId), credentialId: pending.credentialId, recipientKey, bundle })
  } finally {
    wipeBundle(bundle)
  }
  let held: ReturnType<typeof holdPending> | null = null
  let sent: CreateReceipt | undefined
  let written
  try {
    written = await passkeyVaultService.add(pending.identityId, sealed, {
      replacesNonce,
      beforeBroadcast: (receipt) => {
        // Kept before anything is sent: a reload from here on resumes it, and no new passkey can replace it.
        held = holdPending(pending, recipientKey, receipt, !retireOnVerdict)
        sent = receipt
        if (held !== 'held') throw new Error(held === 'busy' ? 'another passkey is still being saved' : held === 'settled' ? 'it was settled elsewhere' : 'this browser could not keep the passkey while it is saved')
      },
    })
  } catch (error) {
    if (held === 'busy') throw new PasskeyVaultError('pending')
    if (held === 'settled') throw new SettledElsewhere()
    // A verdict (refused, or proved not recorded) or nothing sent: this write never lands. Under the write
    // lock every send takes, so no other tab's write slips in between: a first write ends the enrolment
    // with it, unless another tab sent a later write for it meanwhile (that one may land); a later write
    // only drops its own receipt, as earlier writes may still land.
    const mine = sent?.documentId
    // Published (held in storage) before the send: other tabs could take it up from then on.
    const published = held === 'held'
    const outcome = await withIdentityWriteLock(pending.identityId, YAPPR_PASSKEY_VAULT_CONTRACT_ID, async () => {
      const stored = restorePending(pending.identityId)
      const ours = stored !== null && bytesEqual(stored.credentialId, pending.credentialId)
      // Gone since it was published: another tab settled it, maybe by saving a later write.
      if (published && !ours) return 'settled-elsewhere'
      const others = ours ? (stored.receipts ?? []).filter((receipt) => receipt.documentId !== mine) : []
      if (retireOnVerdict && others.length === 0) {
        pending.receipts = []
        retirePending(pending.identityId, pending.credentialId)
        return 'ended'
      }
      if (ours && mine !== undefined) {
        pending.sentTo = stored.sentTo
        pending.receipts = others
        writePending(pending)
      }
      return 'still-out'
    })
    if (outcome === 'settled-elsewhere') throw new SettledElsewhere()
    // Another tab's later write is still out: this passkey may yet be saved, whatever storage says later.
    if (retireOnVerdict && outcome === 'still-out') throw new StillOut()
    throw error
  }
  if (!written.confirmed && !await entryLanded(pending.identityId, pending.credentialId, recipientKey)) return false
  rememberPasskeyHere(pending.identityId, markerOf(pending.credentialId, recipientKey))
  retirePending(pending.identityId, pending.credentialId)
  return true
}

/** The enrolment of `credentialId` for `identityId` settled: its entry was seen, proved never recorded, or removed. */
function retirePending(identityId: string, credentialId: Uint8Array): void {
  const held = pendingEnrolments.get(identityId)
  if (held && bytesEqual(held.credentialId, credentialId)) pendingEnrolments.delete(identityId)
  forgetUnsettledPasskey(identityId, bytesToBase64Url(credentialId))
}

/** A passkey made by {@link startPasskeyEnrolment}, waiting for its confirming sign-in. */
export interface PendingPasskey {
  identityId: string
  credentialId: Uint8Array
  createPrf: Uint8Array | null
  /** Set once its entry was sent: the recipient key it was sealed to, for {@link passkeySaved}. */
  sentTo?: Uint8Array
  /**
   * The recipient key this passkey's PRF gave in this tab: the only key the
   * session is ever sealed to. One restored from storage has none until
   * {@link confirmPendingEnrolment} gets it, so whatever storage says
   * (`sentTo`), the session never goes to a key only storage vouches for.
   */
  vouchedFor?: Uint8Array
  /** Every write sent for its entry, which settle it ({@link checkPendingEnrolment}). */
  receipts?: CreateReceipt[]
}

/**
 * Enrolment, step 1: checks the session can keep a passkey and has room,
 * then makes the passkey (the browser's create sheet). Nothing is written.
 */
export async function startPasskeyEnrolment(user: { identityId: string; username?: string }): Promise<PendingPasskey> {
  const { rp, contractId } = requireSetup()
  // One at a time: a passkey still being saved here is checked again, never joined by another.
  if (pendingEnrolmentFor(user.identityId)) throw new PasskeyVaultError('pending')
  const eligibility = await passkeyEligibility(user.identityId)
  if (eligibility) throw new PasskeyVaultError(eligibility)
  const existing = await passkeyVaultService.list(user.identityId)
  if (existing.length >= MAX_PASSKEYS) throw new PasskeyVaultError('limit')
  const name = user.username ?? `${user.identityId.slice(0, 8)}…`
  const created = await ceremony(() => createPasskeyWithPrf({
    rp,
    userId: passkeyUserHandle(identityBytes(user.identityId), contractId),
    userName: name,
    displayName: passkeyDisplayName(name, { network: getConfiguredNetwork(), scope: STORAGE_SCOPE }),
    prfInput: prfInput(contractId),
    // Also this browser's own passkeys and any still settling, so none is ever replaced in the provider.
    excludeCredentialIds: [
      ...existing.map((entry) => entry.credentialId),
      ...credentialsHere(user.identityId),
      ...[pendingEnrolmentFor(user.identityId)?.credentialId].filter((id): id is Uint8Array => id !== undefined),
    ],
  }))
  if (created.prfEnabled === false) {
    created.prfOutput?.fill(0)
    await signalUnknownPasskey(rp.id, created.credentialId)
    throw new PasskeyVaultError('no-prf')
  }
  return { identityId: user.identityId, credentialId: created.credentialId, createPrf: created.prfOutput }
}

/**
 * Enrolment, step 2 (behind its own tap: Safari wants a fresh gesture): signs
 * in once with the new passkey, which proves it can sign in and gives the PRF
 * output the entry is sealed to, then writes the entry. A closed sheet keeps
 * `pending` (and its PRF output) so Confirm can be tapped again; every other
 * outcome wipes it.
 */
/** Whether the session may go to the record's recipient key: the one this passkey's PRF gave in this tab. */
function vouchedForRecord(pending: PendingPasskey): boolean {
  return pending.vouchedFor !== undefined && pending.sentTo !== undefined && bytesEqual(pending.vouchedFor, pending.sentTo)
}

/** A first write was refused while another tab's later write for the same passkey was out: it stays pending. */
class StillOut extends PasskeyVaultError {
  constructor() {
    super('pending', 'another tab has a later write out for this passkey')
  }
}

/** A pending enrolment's record went while this tab was working on it: another tab settled it. */
class SettledElsewhere extends Error {
  constructor() {
    super('the enrolment was settled elsewhere')
    this.name = 'SettledElsewhere'
  }
}

/** One sign-in restricted to `pending`'s passkey, evaluating the vault's PRF. */
function pendingPasskeyAssertion(pending: PendingPasskey) {
  const { rp, contractId } = requireSetup()
  return ceremony(() => getPasskeyPrf({ rpId: rp.id, prfInput: prfInput(contractId), allowCredentialIds: [pending.credentialId] }))
}

/** Tells the provider to drop a passkey this browser made that signs in to nothing. */
async function dropFromProvider(credentialId: Uint8Array): Promise<void> {
  const found = setup()
  if (found) await signalUnknownPasskey(found.rp.id, credentialId)
}

export async function finishPasskeyEnrolment(pending: PendingPasskey, stillWanted: () => boolean = () => true): Promise<void> {
  let prf: Uint8Array | null
  try {
    prf = (await pendingPasskeyAssertion(pending)).prfOutput
  } catch (error) {
    // A closed sheet keeps it (and its PRF output) for another tap on Confirm, while someone can still tap it
    // (`stillWanted`: the dialog may have gone meanwhile, say on a sign-out); anything else ends it.
    const cancelled = error instanceof PasskeyVaultError && error.code === 'cancelled'
    if (!cancelled || !stillWanted()) await abandonPasskeyEnrolment(pending)
    throw error
  }
  // Sent with no verdict yet: it may land, or have landed already (another tab may even have seen it and
  // retired the record), so nothing here may drop it from the provider whatever is stored.
  let unconfirmed = false
  try {
    // A provider that gives nothing at sign-in, or something else than at creation, cannot be trusted to open the entry later.
    if (!prf || prf.length !== 32 || (pending.createPrf && !bytesEqual(prf, pending.createPrf))) throw new PasskeyVaultError('no-prf')
    const recipient = recipientFromPrf(prf)
    recipient.privateKey.fill(0)
    // Derived from the passkey's own PRF output, right here.
    pending.vouchedFor = recipient.publicKey.slice()
    // Remembered as this device's only once it is confirmed (passkeySaved): one that never lands leaves no marker.
    if (!await sendEntry(pending, recipient.publicKey, true)) {
      unconfirmed = true
      throw new PasskeyVaultError('pending')
    }
  } catch (error) {
    // Settled in another tab meanwhile, maybe saved: never dropped on this write's verdict.
    if (error instanceof SettledElsewhere) {
      if (await passkeySaved(pending)) return
      throw new PasskeyVaultError('failed', error.message)
    }
    // Another tab's later write for it was out when this write's verdict came: that one may land (or have
    // landed, its record retired since), so the passkey is never dropped here.
    if (error instanceof StillOut) throw error
    // Otherwise it was never sent, or a verdict says it never lands (refused, proved not recorded, another
    // passkey still saving here, no PRF): it signs in to nothing.
    if (!unconfirmed) await abandonPasskeyEnrolment(pending)
    throw error
  } finally {
    prf?.fill(0)
    pending.createPrf?.fill(0)
  }
}

const LANDED_READS = 6
const LANDED_READ_MS = 3000

/** Whether the entry for this exact passkey and recipient key is on chain, read a few times while a write settles. */
async function entryLanded(identityId: string, credentialId: Uint8Array, recipientKey: Uint8Array): Promise<boolean> {
  for (let attempt = 0; attempt < LANDED_READS; attempt += 1) {
    try {
      const entry = await passkeyVaultService.find(identityId, credentialId)
      if (entry) return bytesEqual(entry.recipientKey, recipientKey)
    } catch (error) {
      logger.debug('Passkey vault: checking a saved passkey failed:', error)
    }
    // No wait after the last read: an entry that lands then is only missed, never read as absent.
    if (attempt < LANDED_READS - 1) await new Promise((resolve) => setTimeout(resolve, LANDED_READ_MS))
  }
  return false
}

/**
 * For an enrolment whose entry is still settling (`pending`): whether that
 * exact entry has landed now. Never makes or writes anything, so a second
 * passkey cannot replace the first in the provider while it settles.
 */
async function passkeySaved(pending: PendingPasskey): Promise<boolean> {
  if (!pending.sentTo) return false
  const landed = await entryLanded(pending.identityId, pending.credentialId, pending.sentTo)
  if (landed) {
    rememberPasskeyHere(pending.identityId, markerOf(pending.credentialId, pending.sentTo))
    retirePending(pending.identityId, pending.credentialId)
  }
  return landed
}

/**
 * Checks a pending enrolment again: `saved` once its entry is seen.
 * `not-saved` only when Platform proves its write can never land (the
 * state-transition service settles it by proof, re-sending the same signed
 * write while its nonce is free): the provider is then told to drop the
 * passkey, which signs in to nothing, and the enrolment is forgotten, so a new
 * one can be added. Anything short of proof, a failed read included, is `waiting`.
 */
/** Where checking a pending enrolment got to; `confirm`: saving it again needs its passkey to vouch first. */
export type EnrolmentCheck = 'saved' | 'not-saved' | 'waiting' | 'confirm'

export async function checkPendingEnrolment(pending: PendingPasskey): Promise<EnrolmentCheck> {
  if (await passkeySaved(pending)) return 'saved'
  // Settled in another tab (seen, proved never recorded, or removed): nothing is left here to settle or send.
  if (!refreshPending(pending)) {
    if (pendingEnrolments.get(pending.identityId) === pending) pendingEnrolments.delete(pending.identityId)
    return 'not-saved'
  }
  const receipts = pending.receipts ?? []
  const outcomes: Awaited<ReturnType<typeof passkeyVaultService.settleAdd>>[] = []
  for (const receipt of receipts) {
    const outcome = await passkeyVaultService.settleAdd(receipt)
    outcomes.push(outcome)
    if (outcome === 'landed') break
  }
  if (outcomes.includes('landed')) return await passkeySaved(pending) ? 'saved' : 'waiting'
  // One still in flight may land: nothing else is sent meanwhile.
  if (outcomes.includes(null)) return 'waiting'
  if (receipts.length > 0 && outcomes.every((outcome) => outcome === 'not-recorded')) {
    // Retired only if, under the write lock every send takes, the stored record holds no write beyond
    // those just proved: another tab may have sent one since.
    const proved = new Set(receipts.map((receipt) => receipt.documentId))
    const retired = await withIdentityWriteLock(pending.identityId, YAPPR_PASSKEY_VAULT_CONTRACT_ID, async () => {
      const stored = restorePending(pending.identityId)
      if (!stored || !bytesEqual(stored.credentialId, pending.credentialId)) return 'settled-elsewhere'
      if ((stored.receipts ?? []).some((receipt) => !proved.has(receipt.documentId))) return 'more-sent'
      retirePending(pending.identityId, pending.credentialId)
      return 'retired'
    })
    if (retired === 'more-sent') return 'waiting'
    if (retired === 'settled-elsewhere') {
      // Another tab ended it meanwhile, maybe by saving a later write: the writes proved here say nothing of
      // that one, so the passkey is never dropped on their word.
      if (pendingEnrolments.get(pending.identityId) === pending) pendingEnrolments.delete(pending.identityId)
      return await passkeySaved(pending) ? 'saved' : 'not-saved'
    }
    // Only a passkey this tab knows to be the one on record is dropped from the provider: a record read from
    // storage may name anyone's public credential id (the user's working passkey, another account's).
    if (vouchedForRecord(pending)) await dropFromProvider(pending.credentialId)
    return 'not-saved'
  }
  // Every write so far is refused for now (its nonce still free) or proved never recorded: save it again
  // with this session, sealed to the same recipient key, AT THE STALLED WRITE'S NONCE, so the two can never
  // both execute and the stalled one cannot land later (say, after the entry is removed). Writes share that
  // nonce from the first one on, and byCredential is unique: whichever lands is the entry, and it opens
  // with this passkey.
  if (!pending.sentTo) return 'waiting'
  // Restored from storage, or its record's recipient key changed since: the passkey vouches for it first
  // (a gesture, so the UI asks). The session only ever goes to the key the passkey gave.
  const recipient = pending.vouchedFor
  if (!recipient || !bytesEqual(recipient, pending.sentTo)) return 'confirm'
  const stalled = receipts.filter((_, index) => outcomes[index] === 'stalled').map((receipt) => receipt.nonce)
  const replaces = stalled.length > 0 ? stalled.reduce((low, nonce) => (nonce < low ? nonce : low)) : undefined
  try {
    return await sendEntry(pending, recipient, false, replaces) ? 'saved' : 'waiting'
  } catch (error) {
    if (!(error instanceof SettledElsewhere)) throw error
    // Settled in another tab between the proofs and this write: nothing was sent, and nothing is dropped here.
    if (pendingEnrolments.get(pending.identityId) === pending) pendingEnrolments.delete(pending.identityId)
    return await passkeySaved(pending) ? 'saved' : 'not-saved'
  }
}

/**
 * For a pending enrolment restored from storage that needs saving again
 * (`checkPendingEnrolment` said `confirm`): one sign-in restricted to its
 * passkey, whose PRF must give exactly the recipient key on record. Only then
 * is the session sealed to it. A record whose passkey gives a different key
 * is dropped (it can only be a damaged or planted one), and nothing is sealed.
 * The passkey must also name this identity and vault in its user handle (the
 * PRF input is shared by every account), or the record is dropped the same
 * way. A passkey that gives no PRF or no user handle here (another device or
 * path) proves nothing: the record is kept, as its write may still land.
 */
export async function confirmPendingEnrolment(pending: PendingPasskey): Promise<EnrolmentCheck> {
  const { contractId } = requireSetup()
  const assertion = await pendingPasskeyAssertion(pending)
  const prf = assertion.prfOutput
  try {
    if (!prf || prf.length !== 32 || !bytesEqual(assertion.credentialId, pending.credentialId)) throw new PasskeyVaultError('no-prf')
    // The PRF input is the vault's, shared by every account: only the user handle says whose passkey this is.
    // One the authenticator gave none for proves nothing either way.
    if (!assertion.userHandle) throw new PasskeyVaultError('not-yappr')
    const owner = identityOfUserHandle(assertion.userHandle, contractId)
    const recipient = recipientFromPrf(prf)
    recipient.privateKey.fill(0)
    const ours = owner !== null && bytesEqual(owner, identityBytes(pending.identityId))
    if (!ours || !pending.sentTo || !bytesEqual(recipient.publicKey, pending.sentTo)) {
      // Another account's (or vault's) passkey, or one that opens something else: the record can only be
      // damaged or planted. Retired under the write lock every send and retirement takes, and only if still
      // this same record; the passkey itself is someone's, and is never dropped from the provider.
      const sentTo = pending.sentTo
      await withIdentityWriteLock(pending.identityId, YAPPR_PASSKEY_VAULT_CONTRACT_ID, async () => {
        const stored = restorePending(pending.identityId)
        if (stored && bytesEqual(stored.credentialId, pending.credentialId) && (!sentTo || !stored.sentTo || bytesEqual(stored.sentTo, sentTo))) {
          retirePending(pending.identityId, pending.credentialId)
        }
      })
      throw new PasskeyVaultError('failed', 'the passkey does not open what this browser recorded for it')
    }
    pending.vouchedFor = recipient.publicKey.slice()
  } finally {
    prf?.fill(0)
  }
  return await checkPendingEnrolment(pending)
}

/**
 * The user left an enrolment that was made but not saved (the dialog closed,
 * the session ended, or the confirming sign-in failed): its PRF output is
 * wiped, and the passkey is dropped from the provider (it signs in to
 * nothing). Only for one never sent, or whose writes a verdict says never
 * land: callers never pass one sent with no verdict. One still held as
 * settling is kept regardless.
 */
export async function abandonPasskeyEnrolment(pending: PendingPasskey): Promise<void> {
  pending.createPrf?.fill(0)
  const held = pendingEnrolmentFor(pending.identityId)
  if (held && bytesEqual(held.credentialId, pending.credentialId)) return
  await dropFromProvider(pending.credentialId)
}

/** What opening a passkey restores. */
export type PasskeyUnlock =
  | { kind: 'raw-key'; identityId: string; signInWif: string; messagingWif: string | null; critical: boolean }
  | { kind: 'key-ring'; identityId: string; grant: AppConnectGrant }
  | ({ kind: 'renew' } & PasskeyRenewal)

const RENEW_REASONS: Partial<Record<AppConnectRejectReason, PasskeyRenewal['reason']>> = {
  'key-expired': 'expired',
  'budget-exhausted': 'expired',
  'key-limits': 'expired',
  'key-disabled': 'revoked',
}

/** Rebuilds the wallet grant the bundle holds. The caller wipes the bundle. */
async function unlockKeyRing(identityId: string, bundle: VaultBundle): Promise<PasskeyUnlock> {
  const trust = await appConnectSessions.trust({ fresh: true })
  if (!trust.ok) throw new PasskeyVaultError('untrusted')
  const kept = await verifyKeptGrant(identityId, bundle.keys.map((key) => key.privateKey.slice()), 0)
  if (!kept.ok) {
    const renew = RENEW_REASONS[kept.reason]
    if (renew) return { kind: 'renew', identityId, reason: renew }
    logger.warn(`Passkey vault: the kept wallet keys were refused (${kept.reason})`)
    throw new PasskeyVaultError('stale')
  }
  if (primaryGrantedKey(kept.grant)?.key.id !== bundle.keys[0].keyId) {
    wipeGrant(kept.grant)
    throw new PasskeyVaultError('stale')
  }
  return { kind: 'key-ring', identityId, grant: kept.grant }
}

/** Checks the raw key the bundle holds. The caller wipes the bundle. */
async function unlockRawKey(identityId: string, bundle: VaultBundle): Promise<PasskeyUnlock> {
  const keys = await freshKeys(identityId)
  const [signIn, ...rest] = bundle.keys
  const check = checkSignInKey(signIn, keys, Date.now(), appConnectPins()?.groupId ?? null)
  if (!check.ok) throw new PasskeyVaultError('stale')
  if (!await signInKeyAllowed(identityId, check.needsModerator)) throw new PasskeyVaultError('not-eligible')
  // A copy: the bundle's own key is wiped with the bundle, and this one below whatever the check says.
  const messagingCopy = rest[0]?.privateKey.slice() ?? null
  try {
    const messaging = messagingCopy ? await messagingSlot(identityId, messagingCopy, keys) : null
    const network = keyNetwork()
    return {
      kind: 'raw-key',
      identityId,
      signInWif: privateKeyToWif(signIn.privateKey, network, true),
      messagingWif: messaging ? privateKeyToWif(messaging.privateKey, network, true) : null,
      critical: check.key.securityLevel === KeySecurityLevel.CRITICAL,
    }
  } finally {
    messagingCopy?.fill(0)
  }
}

/**
 * Sign-in: the browser's passkey picker (any of Yappr's passkeys), then the
 * entry is read, opened with the passkey's PRF output and checked on chain.
 * Nothing is stored here; the caller signs in with the result.
 */
export async function unlockWithPasskey(expectedIdentityId?: string): Promise<PasskeyUnlock> {
  const { rp, contractId } = requireSetup()
  const assertion = await ceremony(() => getPasskeyPrf({ rpId: rp.id, prfInput: prfInput(contractId) }))
  const prf = assertion.prfOutput
  try {
    if (!assertion.userHandle) throw new PasskeyVaultError('not-yappr')
    const owner = identityOfUserHandle(assertion.userHandle, contractId)
    // A passkey of another Yappr deployment on yap.pr (say /testing) names another vault contract.
    if (!owner) throw new PasskeyVaultError(assertion.userHandle.length === 64 ? 'not-set-up' : 'not-yappr')
    if (!prf || prf.length !== 32) throw new PasskeyVaultError('no-prf')
    const identityId = bs58.encode(owner)
    // Step-up for one account: another account's passkey is refused before its entry is read or opened.
    if (expectedIdentityId !== undefined && identityId !== expectedIdentityId) throw new PasskeyVaultError('not-eligible', 'the passkey is another account\'s')
    const entry = await passkeyVaultService.find(identityId, assertion.credentialId)
    if (!entry) throw new PasskeyVaultError('not-set-up')
    let bundle: VaultBundle
    try {
      bundle = openEntry({ contractId, ownerId: owner, entry, prfOutput: prf })
    } catch (error) {
      if (error instanceof VaultCryptoError) {
        logger.warn('Passkey vault: the entry did not open:', error.message)
        throw new PasskeyVaultError('stale')
      }
      throw error
    }
    try {
      const unlocked = bundle.format === BundleFormat.KEY_RING
        ? await unlockKeyRing(identityId, bundle)
        : await unlockRawKey(identityId, bundle)
      // openEntry proved this passkey derives the entry's recipient key.
      rememberPasskeyHere(identityId, markerOf(assertion.credentialId, entry.recipientKey))
      return unlocked
    } finally {
      wipeBundle(bundle)
    }
  } finally {
    prf?.fill(0)
  }
}

/**
 * Whether one of `identityId`'s passkeys holds its CRITICAL key now: an entry
 * whose sign-in key is an enabled, unbound CRITICAL authentication key (a
 * moderator's raw key, V2). Reads chain; false on any failure, which only
 * hides the passkey choice in the step-up sheet.
 */
export async function hasCriticalKeyPasskey(identityId: string): Promise<boolean> {
  if (!setup()) return false
  try {
    const [entries, keys] = await Promise.all([passkeyVaultService.list(identityId), freshKeys(identityId)])
    return entries.some((entry) => keys.some((key) => key.id === entry.authKeyId
      && key.purpose === KeyPurpose.AUTHENTICATION
      && key.securityLevel === KeySecurityLevel.CRITICAL
      && key.disabledAt === undefined
      // A wallet's group key heads a key-ring entry: that passkey signs in, it holds no raw key.
      && key.bounds === undefined))
  } catch (error) {
    logger.debug('Passkey vault: could not read the passkeys for the step-up sheet', error)
    return false
  }
}

/**
 * Step-up: the browser's passkey picker, then `identityId`'s CRITICAL key from
 * the passkey picked, checked on chain as at sign-in (and, for an unbound
 * key, the moderator check). Nothing is stored here. Throws
 * {@link PasskeyVaultError}: `cancelled` when the picker was closed,
 * `not-eligible` when the passkey is another account's or holds another key.
 */
export async function unlockCriticalKeyWithPasskey(identityId: string): Promise<string> {
  const unlocked = await unlockWithPasskey(identityId)
  if (unlocked.kind === 'key-ring') wipeGrant(unlocked.grant)
  if (unlocked.kind !== 'raw-key' || unlocked.identityId !== identityId || !unlocked.critical) {
    throw new PasskeyVaultError('not-eligible', 'the passkey does not hold this account\'s CRITICAL key')
  }
  return unlocked.signInWif
}

/** One passkey as Settings and the update review show it. */
export interface PasskeyEntryView {
  entryId: string
  credentialId: string
  /** This passkey's credential and recipient key ({@link passkeyMarker}): what its local name is kept under. */
  marker: string
  addedAt: number
  updatedAt: number
  /** Added or used in this browser. */
  thisDevice: boolean
  /** Its sign-in key no longer works: update it, or remove it. */
  needsUpdate: boolean
  /** The name given to it in this browser, if any. */
  name: string | null
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return null
  }
}

/** The credential ids of the passkeys this browser made or opened for `identityId`. */
function credentialsHere(identityId: string): Uint8Array[] {
  return passkeysHere(identityId).flatMap((marker) => {
    const bytes = base64UrlToBytes(marker.slice(0, marker.indexOf('.')))
    return bytes ? [bytes] : []
  })
}

function markerOf(credentialId: Uint8Array, recipientKey: Uint8Array): string {
  return passkeyMarker(bytesToBase64Url(credentialId), bytesToHex(recipientKey))
}

function viewOf(entry: VaultEntryDocument, keys: AppConnectIdentityKey[], budgets: ReadonlyMap<number, bigint | undefined>, here: string[], now: number): PasskeyEntryView {
  const marker = markerOf(entry.credentialId, entry.recipientKey)
  return {
    entryId: entry.$id,
    credentialId: bytesToBase64Url(entry.credentialId),
    marker,
    addedAt: entry.$createdAt,
    updatedAt: entry.$updatedAt,
    thisDevice: here.includes(marker),
    needsUpdate: entryNeedsUpdate(entry.authKeyId, keys, now, budgets),
    name: passkeyName(marker),
  }
}

/**
 * What budgeted entry keys have left, so a spent wallet key reads "Needs update".
 * Rejects when a budget cannot be read: unknown must not read as spent or healthy.
 */
async function entryKeyBudgets(identityId: string, entries: VaultEntryDocument[], keys: AppConnectIdentityKey[]): Promise<ReadonlyMap<number, bigint | undefined>> {
  const budgeted = [...new Set(entries.map((entry) => entry.authKeyId))]
    .filter((keyId) => keys.some((key) => key.id === keyId && key.totalBudget !== undefined && key.disabledAt === undefined))
  if (budgeted.length === 0) return new Map()
  const budgets = await appConnectPlatformPort.remainingBudgets(identityId, budgeted)
  // Unknown is neither spent nor healthy: a budget the node did not report fails the listing, so callers retry.
  if (budgeted.some((keyId) => budgets.get(keyId) === undefined)) throw new PasskeyVaultError('failed', 'a wallet key budget could not be read')
  return budgets
}

/** `identityId`'s passkeys, oldest first, each checked against the identity's keys now. Rejects when a read fails. */
export async function listPasskeys(identityId: string): Promise<PasskeyEntryView[]> {
  const [entries, keys] = await Promise.all([passkeyVaultService.list(identityId), freshKeys(identityId)])
  const here = passkeysHere(identityId)
  const now = Date.now()
  const budgets = await entryKeyBudgets(identityId, entries, keys)
  return entries.map((entry) => viewOf(entry, keys, budgets, here, now)).sort((a, b) => a.addedAt - b.addedAt)
}

/**
 * Seals this session's keys into each of `entryIds`, which the user picked in
 * the review. No passkey prompt: HPKE seals to each passkey's public key.
 * One that fails does not stop the rest.
 */
export async function updatePasskeys(identityId: string, entryIds: readonly string[]): Promise<{ updated: number; failed: number }> {
  const { contractId } = requireSetup()
  const entries = (await passkeyVaultService.list(identityId)).filter((entry) => entryIds.includes(entry.$id))
  const ownerId = identityBytes(identityId)
  const bundle = await sessionBundle(identityId)
  let updated = 0
  try {
    for (const entry of entries) {
      try {
        await passkeyVaultService.reseal(entry, sealEntry({ contractId, ownerId, credentialId: entry.credentialId, recipientKey: entry.recipientKey, bundle }))
        updated += 1
      } catch (error) {
        logger.warn('Passkey vault: updating a passkey failed:', error)
      }
    }
  } finally {
    wipeBundle(bundle)
  }
  // Counted over what was asked for: a selected entry this read missed (a node behind) was not updated either.
  return { updated, failed: new Set(entryIds).size - updated }
}

/**
 * Tells the provider these passkeys no longer work here, so it can hide them.
 * Only passkeys whose removal was confirmed: a list of what remains could come
 * from a node behind and hide a passkey nobody touched.
 */
async function signalRemoved(credentialIds: Uint8Array[]): Promise<void> {
  const found = setup()
  if (!found) return
  for (const credentialId of credentialIds) await signalUnknownPasskey(found.rp.id, credentialId)
}

/**
 * Removes passkeys: their entries are deleted, so they stop signing in, and
 * the provider is told so it can hide them. Copies sealed earlier stay in
 * chain history; only turning the keys they hold off makes them useless.
 */
export async function removePasskeys(identityId: string, entryIds: readonly string[]): Promise<{ removed: number; failed: number }> {
  const { gone, failed } = await removeEntries(identityId, entryIds)
  return { removed: gone.length, failed }
}

/** Deletes `entryIds`; the ids confirmed gone, and how many are not. Tells the provider about the confirmed ones only. */
async function removeEntries(identityId: string, entryIds: readonly string[]): Promise<{ gone: string[]; failed: number }> {
  const entries = (await passkeyVaultService.list(identityId, { partial: true })).filter((entry) => entryIds.includes(entry.$id))
  const confirmed = new Set<string>()
  for (const entry of entries) {
    try {
      await passkeyVaultService.remove(entry)
      confirmed.add(entry.$id)
    } catch (error) {
      logger.warn('Passkey vault: removing a passkey failed:', error)
    }
  }
  // A successful transition confirms the deletion. A stale or failing read-back cannot undo it.
  const gone = entries.filter((entry) => confirmed.has(entry.$id))
  // Only passkeys this browser made or opened are known to be this identity's: a planted entry can carry
  // another account's public credential id, and the provider signal names no user.
  const here = passkeysHere(identityId)
  const ours = gone.filter((entry) => here.includes(markerOf(entry.credentialId, entry.recipientKey)))
  for (const entry of gone) forgetPasskeyHere(identityId, bytesToBase64Url(entry.credentialId))
  // A pending enrolment whose entry landed and was then removed is over.
  const pending = pendingEnrolmentFor(identityId)
  if (pending && gone.some((entry) => bytesEqual(entry.credentialId, pending.credentialId))) retirePending(identityId, pending.credentialId)
  // Counted over what was asked for: a requested entry this read missed (a node behind) is not known gone either.
  const failed = new Set(entryIds).size - gone.length
  await signalRemoved(ours.map((entry) => entry.credentialId))
  return { gone: gone.map((entry) => entry.$id), failed }
}

/** Rounds of "Remove all": each reads up to the list's limit and deletes it, so even a flood of planted entries drains. */
const REMOVE_ALL_ROUNDS = 5

/** "Remove all and start over": every entry of `identityId` read now, including any the user never saw listed. */
export async function removeAllPasskeys(identityId: string): Promise<{ removed: number; failed: number }> {
  const attempted = new Set<string>()
  const gone = new Set<string>()
  for (let round = 0; round < REMOVE_ALL_ROUNDS; round += 1) {
    const entries = await passkeyVaultService.list(identityId, { partial: true })
    if (entries.length === 0) break
    entries.forEach((entry) => attempted.add(entry.$id))
    const result = await removeEntries(identityId, entries.map((entry) => entry.$id))
    result.gone.forEach((id) => gone.add(id))
    // Nothing confirmed gone this round (every delete refused): another round would not do better.
    if (result.gone.length === 0) break
  }
  // An entry counts as removed only once its own delete was confirmed; an empty read alone proves nothing.
  const left = await passkeyVaultService.list(identityId, { partial: true })
  const unconfirmed = new Set([...attempted].filter((id) => !gone.has(id)))
  left.forEach((entry) => unconfirmed.add(entry.$id))
  return { removed: gone.size, failed: unconfirmed.size }
}

/**
 * The hooks a raw-key passkey sign-in runs inside the controller's commit,
 * around storing the sign-in key, and only if that commit is still current:
 * a CRITICAL key is expected right before, so it is stored as one tagged
 * record and never exists without its provenance (lib/secure-storage.ts), and
 * the messaging key is stored only once the sign-in key is. A sign-out or
 * another sign-in meanwhile runs neither, so nothing of this one is left behind.
 */
export function rawKeyStoreHooks(unlocked: Extract<PasskeyUnlock, { kind: 'raw-key' }>): { beforeStore: () => void; afterStore: () => void } {
  const { identityId, signInWif, messagingWif, critical } = unlocked
  return {
    beforeStore: () => { if (critical) expectPasskeyCriticalKey(identityId, signInWif) },
    afterStore: () => {
      settlePasskeyCriticalKey(identityId)
      // Never throws into the commit, which has already stored the session: messaging can be set up again later.
      try {
        if (messagingWif) restorePasskeyMessagingKey(identityId, messagingWif)
      } catch (error) {
        logger.warn('Passkey sign-in: could not keep the messaging key:', error)
      }
    },
  }
}

/**
 * After a passkey sign-in with a key: keeps the messaging key the passkey
 * held. {@link unlockWithPasskey} already checked it is the identity's
 * current one, so it counts as confirmed.
 */
function restorePasskeyMessagingKey(identityId: string, wif: string): void {
  storeEncryptionKey(identityId, wif)
  storeEncryptionKeyType(identityId, 'external')
  rememberAnchorKey(identityId, getPublicKey(parsePrivateKey(wif).privateKey))
}
