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
 * zeroed once their WIFs are taken.
 */
import bs58 from 'bs58'
import { messagingAnchorId } from '@/lib/app-connect/config'
import { keyNetwork } from '@/lib/constants'
import { hash160 } from '@/lib/crypto/hash'
import {
  appEncryptionKeyPath,
  identityAuthKeyPath,
  IDENTITY_GAP_LIMIT,
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
  type MessagingKeyDraft,
} from '@/lib/services/messaging-key-service'
import { resolveEncryptionPublicKey } from '@/lib/crypto/encryption-key-lookup'
import { masterKey, phraseKeys, phraseMessagingState, sessionKey, type PhraseKey } from './recovery-phrase'

/** Identity indexes probed at most, whatever the gaps (a bound on the lookups one phrase can cause). */
const MAX_IDENTITY_INDEX = 32
/** After adding the messaging key: how long to wait for Platform to show it as current (the setup dialog's pattern). */
const CONFIRM_ATTEMPTS = 6
const CONFIRM_DELAY_MS = 2_000

export interface PhraseAccount {
  identityIndex: number
  identityId: string
  username: string | null
}

export interface OpenedPhrase {
  wallet: Dip13Wallet
  accounts: PhraseAccount[]
}

/** The phrase does not check out (BIP-39 checksum or word list). */
export class InvalidRecoveryPhraseError extends Error {
  constructor() {
    super('That recovery phrase isn\'t valid. Check each word and try again.')
  }
}

/**
 * Opens `phrase` (normalized) and finds its identities on this network.
 * Network failures throw: an unanswered lookup never reads as "no account".
 */
export async function openRecoveryPhrase(phrase: string): Promise<OpenedPhrase> {
  const network = keyNetwork()
  let wallet: Dip13Wallet
  try {
    wallet = await openDip13Wallet(phrase, network)
  } catch {
    throw new InvalidRecoveryPhraseError()
  }
  const accounts: PhraseAccount[] = []
  let misses = 0
  for (let identityIndex = 0; identityIndex < MAX_IDENTITY_INDEX && misses < IDENTITY_GAP_LIMIT; identityIndex++) {
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
  return { wallet, accounts }
}

/** What happened to messaging during a phrase sign-in, for the one line the dialog says about it. */
export type PhraseMessaging =
  /** The phrase's key is the account's messaging key (it was, or was just added). */
  | 'ready'
  /** Another wallet set messaging up; the phrase can't unlock it. */
  | 'another-wallet'
  /** The account has none and adding it failed or did not show up in time. */
  | 'not-set-up'
  /** This build has no messaging anchor. */
  | 'unavailable'

export interface PhraseSession {
  identityId: string
  signInWif: string
  /** The messaging key to keep once the session is stored, when `messaging` is `ready`. */
  messagingKey: MessagingKeyDraft | null
  messaging: PhraseMessaging
}

function wipe(keys: readonly PhraseKey[]): void {
  for (const key of keys) key.privateKey.fill(0)
}

/** Add the phrase's messaging key with its MASTER key, then wait until Platform shows it as current. */
async function addMessagingKey(draft: MessagingKeyDraft, master: PhraseKey): Promise<boolean> {
  const masterWif = privateKeyToWif(master.privateKey, keyNetwork(), true)
  try {
    await addMessagingKeyWithMasterKey(draft, masterWif)
  } catch (error) {
    if (error instanceof MessagingAlreadySetUpError) return false
    // An answer lost after the broadcast may still land: keep checking below.
    logger.warn('Recovery phrase sign-in: adding the messaging key reported an error:', error)
  }
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(CONFIRM_DELAY_MS)
    const state = await anchorKeyState(draft).catch(() => null)
    if (state === 'this-key') return true
    if (state === 'other-key') return false
  }
  return false
}

/**
 * The session for `account` of an opened phrase, with its messaging key ready
 * or added. Throws when the phrase holds no key that may sign in.
 */
export async function preparePhraseSession(wallet: Dip13Wallet, account: PhraseAccount): Promise<PhraseSession> {
  const network = keyNetwork()
  const { identityId, identityIndex } = account
  const identity = await identityService.getIdentity(identityId, { fresh: true })
  if (!identity) throw new Error('This account couldn\'t be found. Try again in a moment.')
  const held = phraseKeys(identity.publicKeys, (keyIndex) => wallet.derive(identityAuthKeyPath(network, identityIndex, keyIndex)))
  try {
    const signIn = sessionKey(held)
    if (!signIn) throw new Error('This recovery phrase can\'t sign in to this account.')
    const session = { identityId, signInWif: privateKeyToWif(signIn.privateKey, network, true) }

    const anchorId = messagingAnchorId()
    if (!anchorId) return { ...session, messagingKey: null, messaging: 'unavailable' }
    const key = wallet.derive(appEncryptionKeyPath(network, bs58.decode(identityId), bs58.decode(anchorId)))
    const draft: MessagingKeyDraft = { identityId, anchorId, privateKey: key.privateKey, publicKey: key.publicKey }
    const current = await resolveEncryptionPublicKey(identityId, async () => null)
    const state = phraseMessagingState(key.publicKey, current, identity.publicKeys, anchorId)
    if (state === 'current') return { ...session, messagingKey: draft, messaging: 'ready' }
    if (state === 'absent') {
      const master = masterKey(held)
      if (master && await addMessagingKey(draft, master)) return { ...session, messagingKey: draft, messaging: 'ready' }
      key.privateKey.fill(0)
      // Another device may have set messaging up meanwhile: say which.
      const now = await anchorKeyState(draft).catch(() => null)
      return { ...session, messagingKey: null, messaging: now === 'other-key' ? 'another-wallet' : 'not-set-up' }
    }
    key.privateKey.fill(0)
    return { ...session, messagingKey: null, messaging: 'another-wallet' }
  } finally {
    wipe(held)
  }
}
