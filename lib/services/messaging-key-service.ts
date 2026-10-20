/**
 * Messaging setup on App Connect builds: a signed-in user who signs with a
 * raw key and has no anchor-bound ENCRYPTION key adds one
 * (docs/APP_CONNECT_PROFILE.md: messages, orders and private feeds encrypt
 * to the identity's current key for the `yappr-app` anchor, and nothing else
 * stands in for it).
 *
 * The key is derived from the session's login key (the anchor variant in
 * lib/crypto/derive-encryption-key.ts), so signing in with the same key recovers it
 * on any device. It is an ENCRYPTION/MEDIUM ECDSA_SECP256K1 key bound
 * `singleContract(anchor)`; the anchor stores the latest such key as current
 * (`requiresIdentityEncryptionBoundedKey: 2`), so once Platform accepts the
 * IdentityUpdate it is what peers encrypt to. The update needs a MASTER
 * signature: the wallet's (a `dash-st:` hand-off) or a MASTER key the user
 * holds.
 */

import { messagingAnchorId } from '@/lib/app-connect/config'
import { rememberAnchorKey } from '@/lib/app-connect/anchor-key-mark'
import { bytesEqual } from '@/lib/bytes'
import { getConfiguredNetwork, keyNetwork } from '@/lib/constants'
import { resolveEncryptionPublicKey } from '@/lib/crypto/encryption-key-lookup'
import { deriveEncryptionKey } from '@/lib/crypto/derive-encryption-key'
import { getPublicKey } from '@/lib/crypto/keys'
import { parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'
import { getPrivateKey, storeEncryptionKey, storeEncryptionKeyType, storedEncryptionPublicKey } from '@/lib/secure-storage'
import { identityService } from './identity-service'

export interface MessagingKeyDraft {
  identityId: string
  anchorId: string
  privateKey: Uint8Array
  publicKey: Uint8Array
}

/**
 * The messaging key for the signed-in raw-key session of `identityId`. Throws
 * when this build has no anchor or the session holds no login key (a wallet
 * sign-in gets its key from the wallet instead).
 */
export function draftMessagingKey(identityId: string): MessagingKeyDraft {
  const anchorId = messagingAnchorId()
  if (!anchorId) throw new Error('Messaging isn\'t available here yet.')
  const loginKey = getPrivateKey(identityId)
  if (!loginKey) throw new Error('Sign in again to set up messaging.')
  const privateKey = deriveEncryptionKey(parsePrivateKey(loginKey).privateKey, identityId, anchorId)
  return { identityId, anchorId, privateKey, publicKey: getPublicKey(privateKey) }
}

/** Whether the session's login key is the identity's MASTER key, which can sign the update itself. */
export async function loginKeyIsMaster(identityId: string): Promise<boolean> {
  const loginKey = getPrivateKey(identityId)
  if (!loginKey) return false
  return (await identityService.validateKeySecurityLevel(loginKey, identityId)).isValid
}

/** The identity already has a messaging key that is not this draft: setup must not replace it (recover it instead). */
export class MessagingAlreadySetUpError extends Error {
  constructor() {
    super('Messaging is already set up on this account.')
  }
}

/** The caller backed out before the IdentityUpdate was broadcast: nothing was written. */
export class MessagingSetupCancelledError extends Error {
  constructor() {
    super('Messaging setup was cancelled before anything was sent.')
  }
}

/** The anchor's current key compared with the draft: this key, another key, or none. */
export type AnchorKeyState = 'this-key' | 'other-key' | 'none'

/**
 * Where the draft stands against the anchor's current key (a fresh read;
 * throws when it fails, so a network error never reads as "not set up").
 */
export async function anchorKeyState(draft: MessagingKeyDraft): Promise<AnchorKeyState> {
  const current = await resolveEncryptionPublicKey(draft.identityId, async () => null)
  if (current === null) return 'none'
  return bytesEqual(current, draft.publicKey) ? 'this-key' : 'other-key'
}

/**
 * Add the draft key, signing the IdentityUpdate with a MASTER key the user
 * holds (WIF or hex). `cancelled` is asked right before the broadcast.
 */
export async function addMessagingKeyWithMasterKey(draft: MessagingKeyDraft, masterKey: string, cancelled?: () => boolean): Promise<void> {
  const parsed = parsePrivateKey(masterKey)
  // The identity service matches and signs WIF only.
  const masterKeyWif = parsed.format === 'hex' ? privateKeyToWif(parsed.privateKey, keyNetwork(), true) : masterKey
  const result = await identityService.addEncryptionKey(draft.identityId, draft.privateKey, masterKeyWif, undefined, { cancelled })
  if (result.success) return
  if (result.cancelled) throw new MessagingSetupCancelledError()
  if (/already has an encryption key/i.test(result.error ?? '')) throw new MessagingAlreadySetUpError()
  throw new Error(result.error || 'Couldn\'t set up messaging.')
}

/** Add the draft key, signing with the session's login key, which `loginKeyIsMaster` found to be the MASTER key. */
export async function addMessagingKeyWithLoginKey(draft: MessagingKeyDraft): Promise<void> {
  const loginKey = getPrivateKey(draft.identityId)
  if (!loginKey) throw new Error('Sign in again to set up messaging.')
  await addMessagingKeyWithMasterKey(draft, loginKey)
}

/** A `dash-st:` link carrying the unsigned IdentityUpdate that adds the draft key, for the wallet to sign. */
export async function messagingKeyHandOffUri(draft: MessagingKeyDraft): Promise<string> {
  const [{ buildUnsignedBoundEncryptionKeyTransition, BoundKeyExistsError }, { buildYapprStateTransitionUri }] = await Promise.all([
    import('./identity-update-builder'),
    import('platform-auth'),
  ])
  try {
    const { transitionBytes } = await buildUnsignedBoundEncryptionKeyTransition({
      identityId: draft.identityId,
      encryptionPrivateKey: draft.privateKey,
      contractId: draft.anchorId,
    })
    return buildYapprStateTransitionUri(transitionBytes, getConfiguredNetwork())
  } catch (error) {
    throw error instanceof BoundKeyExistsError ? new MessagingAlreadySetUpError() : error
  }
}

/**
 * App Connect builds: confirm this browser's stored encryption key for
 * `identityId` (whatever put it there) by comparing it
 * with the anchor's current key, read fresh. On a match the stored key may
 * stand in for the anchor key from now on (anchor-key-mark). Returns whether
 * it was confirmed; a key that does not match stays unused.
 */
export async function confirmStoredEncryptionKey(identityId: string): Promise<boolean> {
  if (!messagingAnchorId()) return false
  const stored = storedEncryptionPublicKey(identityId)
  if (!stored) return false
  const current = await resolveEncryptionPublicKey(identityId, async () => null)
  if (!current || !bytesEqual(current, stored)) return false
  rememberAnchorKey(identityId, stored)
  return true
}

/**
 * Keep the draft, now the anchor's current key, as this session's encryption
 * key. Returns its WIF.
 */
export function adoptMessagingKey(draft: MessagingKeyDraft): string {
  const wif = privateKeyToWif(draft.privateKey, keyNetwork(), true)
  rememberAnchorKey(draft.identityId, draft.publicKey)
  storeEncryptionKey(draft.identityId, wif)
  storeEncryptionKeyType(draft.identityId, 'derived')
  identityService.clearCache(draft.identityId)
  return wif
}
