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
 *   limits; an expired or spent grant leads to renewing it in the wallet;
 * - a key sign-in comes back as that key and the messaging key. A CRITICAL key
 *   without contract bounds is kept only for moderators, checked when the
 *   passkey is added and again when it is used.
 *
 * MASTER and TRANSFER keys never go in. Any signed-in device can update every
 * passkey's entry without a passkey prompt, so updates are never silent: the
 * user reviews the list first (lib/auth/passkey-vault-policy.ts has the rules).
 */
import bs58 from 'bs58'
import {
  KeyPurpose,
  KeySecurityLevel,
  PasskeyCancelledError,
  PasskeyExistsError,
  clearSensitiveBytes,
  createPasskeyWithPrf,
  getPasskeyPrf,
  passkeysAvailable,
  signalAcceptedPasskeys,
  signalUnknownPasskey,
  verifyAppConnectKeys,
  type AppConnectGrant,
  type AppConnectIdentityKey,
  type AppConnectRejectReason,
  type PasskeyRelyingParty,
} from 'platform-auth'
import { logger } from '@/lib/logger'
import { STORAGE_SCOPE } from '@/lib/storage-scope'
import { bytesEqual, bytesToBase64Url } from '@/lib/bytes'
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
import { buildYapprAppConnectRequest } from '@/lib/app-connect/yappr-request'
import { getEncryptionKeyBytes, getPrivateKey, storeEncryptionKey, storeEncryptionKeyType } from '@/lib/secure-storage'
import { rememberAnchorKey } from '@/lib/app-connect/anchor-key-mark'
import { passkeyVaultService, type VaultEntryDocument } from '@/lib/services/passkey-vault-service'
import { forgetPasskeyHere, passkeyName, passkeysHere, rememberPasskeyHere } from './passkey-device'
import {
  MAX_PASSKEYS,
  checkSignInKey,
  entryNeedsUpdate,
  keyRingBundle,
  passkeyDisplayName,
  passkeyRpId,
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
  /** No entry for this passkey on this network. */
  | 'not-set-up'
  /** The entry holds a key the identity no longer has, or that no longer checks out. */
  | 'stale'
  /** This session cannot keep a passkey (say, a CRITICAL key that is not a moderator's). */
  | 'not-eligible'
  /** The wallet sign-in this session runs on needs renewing first. */
  | 'renew-first'
  /** Wallet sign-in is paused on this build (the group check failed). */
  | 'untrusted'
  | 'failed'

export class PasskeyVaultError extends Error {
  constructor(readonly code: PasskeyErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'PasskeyVaultError'
  }
}

const RP_NAME = 'Yappr'

function contractIdBytes(): Uint8Array | null {
  try {
    const bytes = bs58.decode(YAPPR_PASSKEY_VAULT_CONTRACT_ID)
    return bytes.length === 32 ? bytes : null
  } catch {
    return null
  }
}

/** The relying party for this page, or null where passkeys are not offered (mirrors, archives, the server). */
function relyingParty(): PasskeyRelyingParty | null {
  if (typeof window === 'undefined') return null
  const id = passkeyRpId(window.location.hostname)
  return id ? { id, name: RP_NAME } : null
}

/** Whether this page offers passkeys at all: the vault is configured, on yap.pr, in a browser that can run WebAuthn. */
export function passkeysOffered(): boolean {
  return contractIdBytes() !== null && relyingParty() !== null && passkeysAvailable()
}

function requireSetup(): { rp: PasskeyRelyingParty; contractId: Uint8Array } {
  const rp = relyingParty()
  const contractId = contractIdBytes()
  if (!rp || !contractId || !passkeysAvailable()) throw new PasskeyVaultError('failed', 'Passkeys are not available here')
  return { rp, contractId }
}

function userHandle(identityId: string): Uint8Array {
  return bs58.decode(identityId)
}

/** Whether the wallet's group key can sign for the vault on this build (the vault is a vouched-for group member). */
async function groupCoversVault(): Promise<boolean> {
  if (!appConnectPins()?.members.some((member) => member.contractId === YAPPR_PASSKEY_VAULT_CONTRACT_ID)) return false
  const trust = await appConnectSessions.trust()
  return trust.group.members.some((member) => member.kind === 'contract' && member.contractId === YAPPR_PASSKEY_VAULT_CONTRACT_ID)
}

/**
 * Whether `identityId` is on a moderation team now (social, storefront or
 * blog: seated, or appointed while no team is seated), read fresh. Throws
 * when a team cannot be read, so a failed read never passes for either answer.
 */
async function isModeratorAnywhere(identityId: string): Promise<boolean> {
  const { moderationServiceFor, moderatorIdsOf } = await import('@/lib/services/moderation-service')
  for (const key of ['social', 'storefront', 'blog'] as const) {
    const team = await moderationServiceFor(key).getTeam({ fresh: true })
    if (team && moderatorIdsOf(team).includes(identityId)) return true
  }
  return false
}

/** The request bindings Yappr asks a wallet for today: a kept grant is checked against exactly these. */
function walletBindings() {
  const pins = appConnectPins()
  if (!pins) throw new PasskeyVaultError('untrusted')
  return buildYapprAppConnectRequest({ pins, appEphemeralPubKey: new Uint8Array(33), connectionId: new Uint8Array(16), createdAt: Date.now() })
}

/** Rejections where only the named key is at fault: drop it and keep the rest of the ring. */
const DROPPABLE: ReadonlySet<AppConnectRejectReason> = new Set([
  'key-expired', 'budget-exhausted', 'budget-unknown', 'key-disabled', 'key-not-found', 'encryption-key-not-current', 'key-limits',
])

type KeptGrant = { ok: true; grant: AppConnectGrant } | { ok: false; reason: AppConnectRejectReason }

/**
 * Rebuilds a wallet grant from kept private keys, checked on chain as a fresh
 * wallet answer is. A spent or revoked secondary key (the DashPay profile key,
 * a superseded messaging key) is dropped rather than failing the whole ring;
 * only the group key decides. Wipes `privateKeys`.
 */
async function verifyKeptGrant(identityId: string, privateKeys: Uint8Array[], primaryIndex = 0): Promise<KeptGrant> {
  const request = walletBindings()
  let keys = privateKeys
  try {
    for (;;) {
      const copies = keys.map((key) => key.slice())
      const result = await verifyAppConnectKeys({ request, ownerId: identityId, identity: appConnectPlatformPort, now: Date.now(), privateKeys: copies })
      if (result.ok) return result
      const slot = result.slot
      if (slot === undefined || slot === primaryIndex || !DROPPABLE.has(result.reason)) return { ok: false, reason: result.reason }
      keys = keys.filter((_, index) => index !== slot)
      if (slot < primaryIndex) primaryIndex -= 1
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
 */
async function messagingSlot(identityId: string, privateKey: Uint8Array, keys: AppConnectIdentityKey[]): Promise<VaultKey | null> {
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
}

/**
 * The bundle this session would keep in a passkey, checked on chain now.
 * Throws {@link PasskeyVaultError} when the session cannot keep one. The
 * caller wipes the bundle.
 */
async function sessionBundle(identityId: string): Promise<VaultBundle> {
  const ring = appConnectSessions.current(identityId)
  if (ring) {
    if (!await groupCoversVault()) throw new PasskeyVaultError('not-eligible')
    const primaryRef = primaryGroupKey(ring)?.keyRef
    const refs = [...ring.authKeys.map((key) => key.keyRef), ...ring.encKeys.map((key) => key.keyRef)]
    const privateKeys: Uint8Array[] = []
    let primaryIndex = -1
    for (const ref of refs) {
      const key = await appConnectSessions.keyStore().privateKey(ring, ref)
      if (!key) continue
      if (ref === primaryRef) primaryIndex = privateKeys.length
      privateKeys.push(key)
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
      for (const granted of [...kept.grant.authKeys, ...kept.grant.encryptionKeys]) clearSensitiveBytes(granted.privateKey)
    }
  }

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
  const check = checkSignInKey(signIn, keys, Date.now())
  if (!check.ok || (check.needsModerator && !await isModeratorAnywhere(identityId))) {
    signIn.privateKey.fill(0)
    throw new PasskeyVaultError('not-eligible')
  }
  const messagingKey = getEncryptionKeyBytes(identityId)
  const messaging = messagingKey ? await messagingSlot(identityId, messagingKey, keys).catch((error: unknown) => {
    logger.warn('Passkey vault: could not check the messaging key; leaving it out', error)
    return null
  }) : null
  if (!messaging) messagingKey?.fill(0)
  return rawKeyBundle(signIn, messaging)
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

/** A passkey made by {@link startPasskeyEnrolment}, waiting for its confirming sign-in. */
export interface PendingPasskey {
  identityId: string
  credentialId: Uint8Array
  createPrf: Uint8Array | null
}

/**
 * Enrolment, step 1: checks the session can keep a passkey and has room,
 * then makes the passkey (the browser's create sheet). Nothing is written.
 */
export async function startPasskeyEnrolment(user: { identityId: string; username?: string }): Promise<PendingPasskey> {
  const { rp, contractId } = requireSetup()
  const eligibility = await passkeyEligibility(user.identityId)
  if (eligibility) throw new PasskeyVaultError(eligibility)
  const existing = await passkeyVaultService.list(user.identityId)
  if (existing.length >= MAX_PASSKEYS) throw new PasskeyVaultError('limit')
  const name = user.username ?? `${user.identityId.slice(0, 8)}…`
  try {
    const created = await createPasskeyWithPrf({
      rp,
      userId: userHandle(user.identityId),
      userName: name,
      displayName: passkeyDisplayName(name, { network: getConfiguredNetwork(), scope: STORAGE_SCOPE }),
      prfInput: prfInput(contractId),
      excludeCredentialIds: existing.map((entry) => entry.credentialId),
    })
    if (created.prfEnabled === false) {
      await signalUnknownPasskey(rp.id, created.credentialId)
      throw new PasskeyVaultError('no-prf')
    }
    return { identityId: user.identityId, credentialId: created.credentialId, createPrf: created.prfOutput }
  } catch (error) {
    throw toVaultError(error)
  }
}

function toVaultError(error: unknown): unknown {
  if (error instanceof PasskeyCancelledError) return new PasskeyVaultError('cancelled')
  if (error instanceof PasskeyExistsError) return new PasskeyVaultError('exists')
  return error
}

/**
 * Enrolment, step 2 (behind its own tap: Safari wants a fresh gesture): signs
 * in once with the new passkey, which proves it can sign in and gives the PRF
 * output the entry is sealed to, then writes the entry.
 */
export async function finishPasskeyEnrolment(pending: PendingPasskey): Promise<void> {
  const { rp, contractId } = requireSetup()
  let prf: Uint8Array | null
  try {
    prf = (await getPasskeyPrf({ rpId: rp.id, prfInput: prfInput(contractId), allowCredentialIds: [pending.credentialId] })).prfOutput
  } catch (error) {
    throw toVaultError(error)
  }
  try {
    // A provider that gives nothing at sign-in, or something else than at creation, cannot be trusted to open the entry later.
    if (!prf || prf.length !== 32 || (pending.createPrf && !bytesEqual(prf, pending.createPrf))) {
      await signalUnknownPasskey(rp.id, pending.credentialId)
      throw new PasskeyVaultError('no-prf')
    }
    const recipient = recipientFromPrf(prf)
    recipient.privateKey.fill(0)
    const bundle = await sessionBundle(pending.identityId)
    let sealed
    try {
      sealed = sealEntry({ contractId, ownerId: userHandle(pending.identityId), credentialId: pending.credentialId, recipientKey: recipient.publicKey, bundle })
    } finally {
      wipeBundle(bundle)
    }
    await passkeyVaultService.add(pending.identityId, sealed)
    rememberPasskeyHere(pending.identityId, bytesToBase64Url(pending.credentialId))
  } finally {
    prf?.fill(0)
    pending.createPrf?.fill(0)
  }
}

/** What opening a passkey restores. */
export type PasskeyUnlock =
  | { kind: 'raw-key'; identityId: string; signInWif: string; messagingWif: string | null; critical: boolean }
  | { kind: 'key-ring'; identityId: string; grant: AppConnectGrant }
  /** The wallet sign-in the passkey holds expired, ran out or was turned off: renew it in the wallet. */
  | { kind: 'renew'; identityId: string; reason: 'expired' | 'revoked' }

const RENEW_REASONS: Partial<Record<AppConnectRejectReason, 'expired' | 'revoked'>> = {
  'key-expired': 'expired',
  'budget-exhausted': 'expired',
  'key-limits': 'expired',
  'key-disabled': 'revoked',
  'key-not-found': 'revoked',
}

async function unlockKeyRing(identityId: string, bundle: VaultBundle): Promise<PasskeyUnlock> {
  const trust = await appConnectSessions.trust({ fresh: true })
  if (!trust.ok) {
    wipeBundle(bundle)
    throw new PasskeyVaultError('untrusted')
  }
  const kept = await verifyKeptGrant(identityId, bundle.keys.map((key) => key.privateKey), 0)
  if (!kept.ok) {
    const renew = RENEW_REASONS[kept.reason]
    if (renew) return { kind: 'renew', identityId, reason: renew }
    logger.warn(`Passkey vault: the kept wallet keys were refused (${kept.reason})`)
    throw new PasskeyVaultError('stale')
  }
  const primary = kept.grant.authKeys.find((granted) => granted.role === 'contractGroup' && granted.bindingIndex === 0)
  if (!primary || primary.key.id !== bundle.keys[0].keyId) {
    for (const granted of [...kept.grant.authKeys, ...kept.grant.encryptionKeys]) clearSensitiveBytes(granted.privateKey)
    throw new PasskeyVaultError('stale')
  }
  return { kind: 'key-ring', identityId, grant: kept.grant }
}

async function unlockRawKey(identityId: string, bundle: VaultBundle): Promise<PasskeyUnlock> {
  try {
    const keys = await freshKeys(identityId)
    const [signIn, ...rest] = bundle.keys
    const check = checkSignInKey(signIn, keys, Date.now())
    if (!check.ok) throw new PasskeyVaultError('stale')
    if (check.needsModerator && !await isModeratorAnywhere(identityId)) throw new PasskeyVaultError('not-eligible')
    const messaging = rest[0] ? await messagingSlot(identityId, rest[0].privateKey, keys).catch(() => null) : null
    const network = keyNetwork()
    return {
      kind: 'raw-key',
      identityId,
      signInWif: privateKeyToWif(signIn.privateKey, network, true),
      messagingWif: messaging ? privateKeyToWif(messaging.privateKey, network, true) : null,
      critical: check.key.securityLevel === KeySecurityLevel.CRITICAL,
    }
  } finally {
    wipeBundle(bundle)
  }
}

/**
 * Sign-in: the browser's passkey picker (any of Yappr's passkeys), then the
 * entry is read, opened with the passkey's PRF output and checked on chain.
 * Nothing is stored here; the caller signs in with the result.
 */
export async function unlockWithPasskey(): Promise<PasskeyUnlock> {
  const { rp, contractId } = requireSetup()
  let assertion
  try {
    assertion = await getPasskeyPrf({ rpId: rp.id, prfInput: prfInput(contractId) })
  } catch (error) {
    throw toVaultError(error)
  }
  const prf = assertion.prfOutput
  try {
    if (!assertion.userHandle || assertion.userHandle.length !== 32) throw new PasskeyVaultError('not-yappr')
    if (!prf || prf.length !== 32) throw new PasskeyVaultError('no-prf')
    const identityId = bs58.encode(assertion.userHandle)
    const entry = await passkeyVaultService.find(identityId, assertion.credentialId)
    if (!entry || entry.$ownerId !== identityId) throw new PasskeyVaultError('not-set-up')
    let bundle: VaultBundle
    try {
      bundle = openEntry({ contractId, ownerId: assertion.userHandle, entry, prfOutput: prf })
    } catch (error) {
      if (error instanceof VaultCryptoError) {
        logger.warn('Passkey vault: the entry did not open:', error.message)
        throw new PasskeyVaultError('stale')
      }
      throw error
    }
    const unlocked = bundle.format === BundleFormat.KEY_RING
      ? await unlockKeyRing(identityId, bundle)
      : await unlockRawKey(identityId, bundle)
    rememberPasskeyHere(identityId, bytesToBase64Url(assertion.credentialId))
    return unlocked
  } finally {
    prf?.fill(0)
  }
}

/** One passkey as Settings and the update review show it. */
export interface PasskeyEntryView {
  entryId: string
  credentialId: string
  addedAt: number
  updatedAt: number
  /** Added or used in this browser. */
  thisDevice: boolean
  /** Its sign-in key no longer works: update it, or remove it. */
  needsUpdate: boolean
  /** The name given to it in this browser, if any. */
  name: string | null
}

function viewOf(entry: VaultEntryDocument, keys: AppConnectIdentityKey[], here: string[], now: number): PasskeyEntryView {
  const credentialId = bytesToBase64Url(entry.credentialId)
  return {
    entryId: entry.$id,
    credentialId,
    addedAt: entry.$createdAt,
    updatedAt: entry.$updatedAt,
    thisDevice: here.includes(credentialId),
    needsUpdate: entryNeedsUpdate(entry.authKeyId, keys, now),
    name: passkeyName(credentialId),
  }
}

/** `identityId`'s passkeys, oldest first, each checked against the identity's keys now. Rejects when a read fails. */
export async function listPasskeys(identityId: string): Promise<PasskeyEntryView[]> {
  const [entries, keys] = await Promise.all([passkeyVaultService.list(identityId), freshKeys(identityId)])
  const here = passkeysHere(identityId)
  const now = Date.now()
  return entries.map((entry) => viewOf(entry, keys, here, now)).sort((a, b) => a.addedAt - b.addedAt)
}

/**
 * Seals this session's keys into each of `entryIds` (after the user reviewed
 * the list). No passkey prompt: HPKE seals to each passkey's public key.
 * Returns how many were updated; one that fails does not stop the rest.
 */
export async function updatePasskeys(identityId: string, entryIds: readonly string[]): Promise<{ updated: number; failed: number }> {
  const { contractId } = requireSetup()
  const entries = (await passkeyVaultService.list(identityId)).filter((entry) => entryIds.includes(entry.$id))
  const bundle = await sessionBundle(identityId)
  let updated = 0
  let failed = 0
  try {
    for (const entry of entries) {
      try {
        const sealed = sealEntry({ contractId, ownerId: userHandle(identityId), credentialId: entry.credentialId, recipientKey: entry.recipientKey, bundle })
        await passkeyVaultService.reseal(entry, sealed)
        updated += 1
      } catch (error) {
        logger.warn('Passkey vault: updating a passkey failed:', error)
        failed += 1
      }
    }
  } finally {
    wipeBundle(bundle)
  }
  return { updated, failed }
}

async function signalRemaining(identityId: string): Promise<void> {
  const rp = relyingParty()
  if (!rp) return
  try {
    const remaining = await passkeyVaultService.list(identityId)
    await signalAcceptedPasskeys(rp.id, userHandle(identityId), remaining.map((entry) => entry.credentialId))
  } catch (error) {
    logger.debug('Passkey vault: could not tell the passkey provider what remains:', error)
  }
}

/**
 * Removes passkeys: their entries are deleted, so they stop signing in, and
 * the provider is told so it can hide them. Copies sealed earlier stay in
 * chain history; only a new sign-in key makes them useless.
 */
export async function removePasskeys(identityId: string, entryIds: readonly string[]): Promise<{ removed: number; failed: number }> {
  const entries = (await passkeyVaultService.list(identityId)).filter((entry) => entryIds.includes(entry.$id))
  let removed = 0
  let failed = 0
  for (const entry of entries) {
    try {
      await passkeyVaultService.remove(entry)
      forgetPasskeyHere(identityId, bytesToBase64Url(entry.credentialId))
      removed += 1
    } catch {
      failed += 1
    }
  }
  await signalRemaining(identityId)
  return { removed, failed }
}

/** "Remove all and start over": every entry of `identityId`, including any the user does not recognise. */
export async function removeAllPasskeys(identityId: string): Promise<{ removed: number; failed: number }> {
  const entries = await passkeyVaultService.list(identityId)
  return removePasskeys(identityId, entries.map((entry) => entry.$id))
}

/**
 * After a passkey sign-in with a key: keeps the messaging key the passkey
 * held. {@link unlockWithPasskey} already checked it is the identity's
 * current one, so it counts as confirmed.
 */
export function restorePasskeyMessagingKey(identityId: string, wif: string): void {
  storeEncryptionKey(identityId, wif)
  storeEncryptionKeyType(identityId, 'external')
  rememberAnchorKey(identityId, getPublicKey(parsePrivateKey(wif).privateKey))
}

/** Whether this build's wallet sign-in could keep passkeys (used to word Settings for wallet sessions). */
export function walletPasskeysPossible(): boolean {
  return isAppConnectBuild() && Boolean(appConnectPins()?.members.some((member) => member.contractId === YAPPR_PASSKEY_VAULT_CONTRACT_ID))
}
