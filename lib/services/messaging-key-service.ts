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
import { getPrivateKey, storeEncryptionKey, storeEncryptionKeyType } from '@/lib/secure-storage'
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

/**
 * Whether the draft is the anchor's current key (a fresh read; throws when it
 * fails, so a network error never reads as "not set up").
 */
export async function isCurrentMessagingKey(draft: MessagingKeyDraft): Promise<boolean> {
  const current = await resolveEncryptionPublicKey(draft.identityId, async () => null)
  return current !== null && bytesEqual(current, draft.publicKey)
}

/** Add the draft key, signing the IdentityUpdate with a MASTER key the user holds. */
export async function addMessagingKeyWithMasterKey(draft: MessagingKeyDraft, masterKeyWif: string): Promise<void> {
  const result = await identityService.addEncryptionKey(draft.identityId, draft.privateKey, masterKeyWif)
  if (!result.success) throw new Error(result.error || 'Couldn\'t set up messaging.')
}

/** Add the draft key, signing with the session's login key, which `loginKeyIsMaster` found to be the MASTER key. */
export async function addMessagingKeyWithLoginKey(draft: MessagingKeyDraft): Promise<void> {
  const loginKey = getPrivateKey(draft.identityId)
  if (!loginKey) throw new Error('Sign in again to set up messaging.')
  await addMessagingKeyWithMasterKey(draft, loginKey)
}

/** A `dash-st:` link carrying the unsigned IdentityUpdate that adds the draft key, for the wallet to sign. */
export async function messagingKeyHandOffUri(draft: MessagingKeyDraft): Promise<string> {
  const [{ buildUnsignedBoundEncryptionKeyTransition }, { buildYapprStateTransitionUri }] = await Promise.all([
    import('./identity-update-builder'),
    import('platform-auth'),
  ])
  const { transitionBytes } = await buildUnsignedBoundEncryptionKeyTransition({
    identityId: draft.identityId,
    encryptionPrivateKey: draft.privateKey,
    contractId: draft.anchorId,
  })
  return buildYapprStateTransitionUri(transitionBytes, getConfiguredNetwork())
}

/**
 * Keep the draft, now the anchor's current key, as this session's encryption
 * key. Returns its WIF for the caller to merge into the password vault.
 */
export function adoptMessagingKey(draft: MessagingKeyDraft): string {
  const wif = privateKeyToWif(draft.privateKey, keyNetwork(), true)
  rememberAnchorKey(draft.identityId, draft.publicKey)
  storeEncryptionKey(draft.identityId, wif)
  storeEncryptionKeyType(draft.identityId, 'derived')
  identityService.clearCache(draft.identityId)
  return wif
}
