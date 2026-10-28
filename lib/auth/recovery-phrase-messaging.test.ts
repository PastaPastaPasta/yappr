/**
 * Recovery-phrase sign-in against the DIP's encryption key rules (dashpay/dips#181
 * "Encryption Keys"): which of the phrase's keys it uses as the account's
 * messaging key, and the one case where it registers one (rotation 0' at the
 * 9-level path).
 */
import { sha256 } from '@noble/hashes/sha2.js'
import bs58 from 'bs58'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToHex } from '@/lib/bytes'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { getPublicKey } from '@/lib/crypto/keys'
import {
  APP_KEY_PURPOSE,
  appEncryptionKeyPath,
  identityAuthKeyPath,
  legacyAppEncryptionKeyPath,
  type Dip13Key,
  type Dip13Wallet,
} from '@/lib/crypto/dip13'

const ANCHOR = bs58.encode(new Uint8Array(32).fill(0x6b))
const IDENTITY = bs58.encode(new Uint8Array(32).fill(0x35))

const state = vi.hoisted(() => ({
  publicKeys: [] as unknown[],
  current: null as Uint8Array | null,
  added: [] as Uint8Array[],
  afterAdd: null as ((publicKey: Uint8Array) => void) | null,
}))

vi.mock('@/lib/services/identity-service', () => ({
  identityService: { getIdentity: async () => ({ id: IDENTITY, balance: 0, revision: 0, publicKeys: state.publicKeys }) },
}))
vi.mock('@/lib/services/dpns-service', () => ({ dpnsService: {} }))
vi.mock('@/lib/app-connect/config', () => ({ messagingAnchorId: () => ANCHOR }))
vi.mock('@/lib/retry-utils', () => ({ sleep: async () => {} }))
vi.mock('@/lib/crypto/encryption-key-lookup', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/crypto/encryption-key-lookup')>()),
  resolveEncryptionPublicKey: async () => state.current,
}))
vi.mock('@/lib/services/messaging-key-service', () => ({
  MessagingAlreadySetUpError: class extends Error {},
  MessagingSetupCancelledError: class extends Error {},
  addMessagingKeyWithMasterKey: async (draft: { publicKey: Uint8Array }) => {
    state.added.push(draft.publicKey)
    state.afterAdd?.(draft.publicKey)
  },
  anchorKeyState: async (draft: { publicKey: Uint8Array }) => {
    if (state.current === null) return 'none'
    return bytesToHex(state.current) === bytesToHex(draft.publicKey) ? 'this-key' : 'other-key'
  },
}))

import { preparePhraseSession } from './recovery-phrase-sign-in'

/** Every path derives its own key: sha256 of the path is a valid scalar with overwhelming probability. */
const wallet: Dip13Wallet = {
  derive(path: string): Dip13Key {
    const privateKey = sha256(new TextEncoder().encode(path))
    return { privateKey, publicKey: getPublicKey(privateKey) }
  },
}
const ids = { identity: bs58.decode(IDENTITY), anchor: bs58.decode(ANCHOR) }
const rotationKey = (rotation: number) =>
  wallet.derive(appEncryptionKeyPath('testnet', ids.identity, ids.anchor, APP_KEY_PURPOSE.ENCRYPTION, rotation))
const legacyKey = () => wallet.derive(legacyAppEncryptionKeyPath('testnet', ids.identity, ids.anchor))
const foreignKey = () => getPublicKey(sha256(new TextEncoder().encode('another wallet')))

const authKey = (id: number, securityLevel: number) =>
  ({ id, type: KeyType.ECDSA_SECP256K1, purpose: KeyPurpose.AUTHENTICATION, securityLevel, data: wallet.derive(identityAuthKeyPath('testnet', 0, id)).publicKey })
const anchorKey = (id: number, data: Uint8Array, extra: Record<string, unknown> = {}) => ({
  id,
  type: KeyType.ECDSA_SECP256K1,
  purpose: KeyPurpose.ENCRYPTION,
  securityLevel: SecurityLevel.MEDIUM,
  data,
  contractBounds: { $type: 'singleContract', id: ANCHOR },
  ...extra,
})
function messagingKeyOf(session: Awaited<ReturnType<typeof preparePhraseSession>>) {
  if (!session.messagingKey) throw new Error('expected the session to carry a messaging key')
  return session.messagingKey
}
const account = { identityIndex: 0, identityId: IDENTITY, username: null }

beforeEach(() => {
  state.publicKeys = [authKey(0, SecurityLevel.MASTER), authKey(2, SecurityLevel.HIGH)]
  state.current = null
  state.added = []
  state.afterAdd = null
})

describe('preparePhraseSession messaging key', () => {
  it('registers rotation 0 at the 9-level path when no candidate was ever on the identity', async () => {
    state.afterAdd = (publicKey) => { state.current = publicKey }
    const session = await preparePhraseSession(wallet, account)
    expect(session.messaging).toBe('ready')
    expect(state.added.map(bytesToHex)).toEqual([bytesToHex(rotationKey(0).publicKey)])
    expect(bytesToHex(messagingKeyOf(session).publicKey)).toBe(bytesToHex(rotationKey(0).publicKey))
    expect(bytesToHex(messagingKeyOf(session).privateKey)).toBe(bytesToHex(rotationKey(0).privateKey))
  })

  it('uses rotation 0 when it is the current key', async () => {
    const key = rotationKey(0)
    state.publicKeys.push(anchorKey(5, key.publicKey))
    state.current = key.publicKey
    const session = await preparePhraseSession(wallet, account)
    expect(session.messaging).toBe('ready')
    expect(bytesToHex(messagingKeyOf(session).publicKey)).toBe(bytesToHex(key.publicKey))
    expect(state.added).toEqual([])
  })

  it('uses a later rotation when it is the current key and the earlier ones are disabled', async () => {
    state.publicKeys.push(
      anchorKey(5, rotationKey(0).publicKey, { disabledAt: 1 }),
      anchorKey(6, rotationKey(1).publicKey),
    )
    state.current = rotationKey(1).publicKey
    const session = await preparePhraseSession(wallet, account)
    expect(session.messaging).toBe('ready')
    expect(bytesToHex(messagingKeyOf(session).privateKey)).toBe(bytesToHex(rotationKey(1).privateKey))
    expect(state.added).toEqual([])
  })

  it('uses the pre-DIP key (no rotation level) when it is the current key', async () => {
    state.publicKeys.push(anchorKey(5, legacyKey().publicKey))
    state.current = legacyKey().publicKey
    const session = await preparePhraseSession(wallet, account)
    expect(session.messaging).toBe('ready')
    expect(bytesToHex(messagingKeyOf(session).privateKey)).toBe(bytesToHex(legacyKey().privateKey))
    expect(state.added).toEqual([])
  })

  it('leaves another wallet\'s current key alone, even next to the phrase\'s disabled one', async () => {
    state.publicKeys.push(anchorKey(5, rotationKey(0).publicKey, { disabledAt: 1 }), anchorKey(6, foreignKey()))
    state.current = foreignKey()
    const session = await preparePhraseSession(wallet, account)
    expect(session).toMatchObject({ messaging: 'another-wallet', messagingKey: null })
    expect(state.added).toEqual([])
  })

  it('registers nothing when the only candidate on the identity, the pre-DIP key, is disabled', async () => {
    state.publicKeys.push(anchorKey(5, legacyKey().publicKey, { disabledAt: 1 }))
    const session = await preparePhraseSession(wallet, account)
    expect(session).toMatchObject({ messaging: 'another-wallet', messagingKey: null })
    expect(state.added).toEqual([])
  })

  it('registers nothing when the only anchor key on the identity is another wallet\'s disabled one', async () => {
    state.publicKeys.push(anchorKey(5, foreignKey(), { disabledAt: 1 }))
    const session = await preparePhraseSession(wallet, account)
    expect(session).toMatchObject({ messaging: 'another-wallet', messagingKey: null })
    expect(state.added).toEqual([])
  })

  it('registers nothing when the rotations are all disabled', async () => {
    state.publicKeys.push(
      anchorKey(5, rotationKey(0).publicKey, { disabledAt: 1 }),
      anchorKey(6, rotationKey(1).publicKey, { disabledAt: 2 }),
    )
    const session = await preparePhraseSession(wallet, account)
    expect(session).toMatchObject({ messaging: 'another-wallet', messagingKey: null })
    expect(state.added).toEqual([])
  })
})
