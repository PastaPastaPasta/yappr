/**
 * Recovery-phrase sign-in (D38, App Connect builds): derive from the phrase
 * what a wallet holding it derives (lib/crypto/dip13.ts), so the account and
 * its messaging key are the ones the wallet would use.
 *
 * 1. Find the phrase's identities: identity index 0, 1, ... by its MASTER
 *    key's hash, stopping after IDENTITY_GAP_LIMIT unused indexes in a row.
 * 2. For the one chosen, the keys it holds; the session signs with its HIGH
 *    (else CRITICAL) authentication key, as if that key had been typed in.
 * 3. Its messaging key: the DIP-13 7' key for this build's anchor at rotation
 *    0. Used when it is current, added (MASTER-signed) when the account has
 *    none, and left alone when another wallet's key is there.
 *
 * The phrase is passed in, never stored, logged or sent; derived key bytes are
 * zeroed once their WIFs are taken (best effort: see dip13.ts).
 */
import bs58 from 'bs58'
import { messagingAnchorId } from '@/lib/app-connect/config'
import { keyNetwork } from '@/lib/constants'
import { resolveEncryptionPublicKey } from '@/lib/crypto/encryption-key-lookup'
import { hash160 } from '@/lib/crypto/hash'
import {
  appEncryptionKeyPath,
  identityAuthKeyPath,
  IDENTITY_GAP_LIMIT,
  InvalidPhraseError,
  MASTER_KEY_INDEX,
  openDip13Wallet,
  type Dip13Wallet,
} from '@/lib/crypto/dip13'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { logger } from '@/lib/logger'
import { sleep } from '@/lib/retry-utils'
import { dpnsService } from '@/lib/services/dpns-service'
import { identityService } from '@/lib/services/identity-service'
import {
  addMessagingKeyWithMasterKey,
  anchorKeyState,
  MessagingAlreadySetUpError,
  MessagingSetupCancelledError,
  type AnchorKeyState,
  type MessagingKeyDraft,
} from '@/lib/services/messaging-key-service'
import { masterKey, phraseKeys, phraseMessagingState, sessionKey, type PhraseKey } from './recovery-phrase'

/** After adding the messaging key: how long to wait for Platform to show it as current (the setup dialog's pattern). */
const CONFIRM_ATTEMPTS = 6
const CONFIRM_DELAY_MS = 2_000

export interface PhraseAccount {
  identityIndex: number
  identityId: string
  username: string | null
}

/** The refusal of a phrase that fails its checksum: the one failure that leaves the phrase in its field to correct. */
export const INVALID_PHRASE = 'That recovery phrase isn\'t valid. Check each word and try again.'

/** A sign-in that cannot go on, with words fit to show the user as they are. */
export class PhraseSignInError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhraseSignInError'
  }
}

/** The sign-in was abandoned (its dialog closed, or another sign-in or sign-out came first) before anything was written. */
class PhraseSignInCancelled extends Error {}

/** Opens `phrase` (normalized), checking its BIP-39 checksum: no network yet. */
export async function openRecoveryPhrase(phrase: string): Promise<Dip13Wallet> {
  try {
    return await openDip13Wallet(phrase, keyNetwork())
  } catch (error) {
    // Only a phrase that fails its checksum is the user's to fix; a failed SDK load is not.
    if (error instanceof InvalidPhraseError) throw new PhraseSignInError(INVALID_PHRASE)
    throw error
  }
}

/**
 * The phrase's identities on this network, as a wallet discovers them: no
 * bound but the gap limit (rs-platform-wallet `discover`). Network failures
 * throw: an unanswered lookup never reads as "no account".
 */
export async function findPhraseAccounts(wallet: Dip13Wallet): Promise<PhraseAccount[]> {
  const network = keyNetwork()
  const accounts: PhraseAccount[] = []
  for (let identityIndex = 0, misses = 0; misses < IDENTITY_GAP_LIMIT; identityIndex++) {
    const key = wallet.derive(identityAuthKeyPath(network, identityIndex, MASTER_KEY_INDEX))
    key.privateKey.fill(0)
    const identityId = await identityService.getIdentityIdByPublicKeyHash(hash160(key.publicKey))
    if (!identityId) {
      misses++
      continue
    }
    misses = 0
    accounts.push({ identityIndex, identityId, username: null })
  }
  await Promise.all(accounts.map(async (account) => {
    account.username = await dpnsService.resolveUsername(account.identityId).catch(() => null)
  }))
  return accounts
}

/** What happened to messaging during a phrase sign-in, for the one line the dialog says about it. */
export type PhraseMessaging =
  /** The phrase's key is the account's messaging key (it was, or was just added). */
  | 'ready'
  /** Another wallet set messaging up; the phrase can't unlock it. */
  | 'another-wallet'
  /** The account has none and adding it failed or did not show up in time. */
  | 'not-set-up'
  /** The account has none, and the phrase doesn't hold the MASTER key that could add it. */
  | 'no-master-key'
  /** This build has no messaging anchor. */
  | 'unavailable'

export interface PhraseSession {
  identityId: string
  signInWif: string
  /** The messaging key to keep once the session is stored, when `messaging` is `ready`. */
  messagingKey: MessagingKeyDraft | null
  messaging: PhraseMessaging
}

/**
 * Add the phrase's messaging key with its MASTER key, then wait until
 * Platform shows it as current. `addEncryptionKey` already settles a
 * broadcast whose answer was lost, so a refusal is final: one check, no wait.
 */
async function addMessagingKey(draft: MessagingKeyDraft, master: PhraseKey, cancelled: () => boolean): Promise<AnchorKeyState | null> {
  const masterWif = privateKeyToWif(master.privateKey, keyNetwork(), true)
  let refused = false
  try {
    await addMessagingKeyWithMasterKey(draft, masterWif, cancelled)
  } catch (error) {
    if (error instanceof MessagingSetupCancelledError) throw new PhraseSignInCancelled()
    refused = true
    if (!(error instanceof MessagingAlreadySetUpError)) logger.warn('Recovery phrase sign-in: adding the messaging key failed:', error)
  }
  const attempts = refused ? 1 : CONFIRM_ATTEMPTS
  let state: AnchorKeyState | null = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(CONFIRM_DELAY_MS)
    state = await anchorKeyState(draft).catch(() => null)
    if (state === 'this-key' || state === 'other-key') return state
  }
  if (refused) return state
  // Added, but the current-key read still lags: the identity's own newest anchor key decides.
  const identity = await identityService.getIdentity(draft.identityId, { fresh: true }).catch(() => null)
  return identity && phraseMessagingState(draft.publicKey, null, identity.publicKeys, draft.anchorId) === 'current' ? 'this-key' : state
}

/**
 * The session for `account` of an opened phrase, with its messaging key ready
 * or added. `cancelled` is asked before anything is written. Throws a
 * PhraseSignInError when the phrase holds no key that may sign in.
 */
export async function preparePhraseSession(
  wallet: Dip13Wallet,
  account: PhraseAccount,
  cancelled: () => boolean = () => false,
): Promise<PhraseSession> {
  const network = keyNetwork()
  const { identityId, identityIndex } = account
  const identity = await identityService.getIdentity(identityId, { fresh: true })
  if (!identity) throw new PhraseSignInError('This account couldn\'t be found. Try again in a moment.')
  const held = phraseKeys(identity.publicKeys, (keyIndex) => wallet.derive(identityAuthKeyPath(network, identityIndex, keyIndex)))
  let messagingKey: MessagingKeyDraft | null = null
  try {
    const signIn = sessionKey(held)
    if (!signIn) throw new PhraseSignInError('This recovery phrase can\'t sign in to this account.')
    const session = { identityId, signInWif: privateKeyToWif(signIn.privateKey, network, true) }

    const anchorId = messagingAnchorId()
    if (!anchorId) return { ...session, messagingKey: null, messaging: 'unavailable' }
    const key = wallet.derive(appEncryptionKeyPath(network, bs58.decode(identityId), bs58.decode(anchorId)))
    messagingKey = { identityId, anchorId, privateKey: key.privateKey, publicKey: key.publicKey }
    const current = await resolveEncryptionPublicKey(identityId, async () => null)
    const state = phraseMessagingState(key.publicKey, current, identity.publicKeys, anchorId)
    if (state === 'another-wallet') return { ...session, messagingKey: null, messaging: 'another-wallet' }
    if (state === 'absent') {
      const master = masterKey(held)
      if (!master) return { ...session, messagingKey: null, messaging: 'no-master-key' }
      if (cancelled()) throw new PhraseSignInCancelled()
      const added = await addMessagingKey(messagingKey, master, cancelled)
      // Another device may have set messaging up meanwhile: say which.
      if (added === 'other-key') return { ...session, messagingKey: null, messaging: 'another-wallet' }
      if (added !== 'this-key') return { ...session, messagingKey: null, messaging: 'not-set-up' }
    }
    const ready = messagingKey
    messagingKey = null
    return { ...session, messagingKey: ready, messaging: 'ready' }
  } finally {
    // Everything but a messaging key handed back is wiped, whichever way this ends.
    for (const key of held) key.privateKey.fill(0)
    messagingKey?.privateKey.fill(0)
  }
}
