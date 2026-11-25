/**
 * #612: every `dash-st:` payload the app builds is a tagged StateTransition,
 * the standard DPP framing. Wallets decode `dash-st:` with
 * `StateTransition.fromBytes` (platform-wallet's `decode_state_transition`
 * takes untagged identity updates only as a tolerance for Yappr's old links).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'
import { StateTransition, ensureInitialized } from '@dashevo/evo-sdk'
import { buildYapprStateTransitionUri, parseYapprStateTransitionUri } from 'platform-auth'
import { getPublicKey } from '@/lib/crypto/keys'

const OWNER = bs58.encode(new Uint8Array(32).fill(7))
const RECIPIENT = bs58.encode(new Uint8Array(32).fill(8))
const TOKEN = bs58.encode(new Uint8Array(32).fill(9))
const ANCHOR = bs58.encode(new Uint8Array(32).fill(1))

vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({
    identities: {
      fetch: async () => ({ publicKeys: [{ keyId: 0 }], toJSON: () => ({ revision: 1 }) }),
      nonce: async () => BigInt(1),
      contractNonce: async () => BigInt(100),
    },
  }),
}))
vi.mock('./token-service', () => ({ tokenService: { getTokenId: async () => TOKEN } }))
vi.mock('../contract-topology', async (importOriginal) => ({
  ...await importOriginal<typeof import('../contract-topology')>(),
  yappIsTransferable: () => true,
}))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
})

beforeAll(async () => {
  await ensureInitialized()
})

beforeEach(() => {
  storage.clear()
  vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', 'legacy')
})

const payloads: Array<[string, string, () => Promise<Uint8Array>]> = [
  ['key registration', 'IdentityUpdate', async () => {
    const { buildUnsignedKeyRegistrationTransition } = await import('./identity-update-builder')
    const authPrivateKey = new Uint8Array(32).fill(2)
    const encryptionPrivateKey = new Uint8Array(32).fill(3)
    const { transitionBytes } = await buildUnsignedKeyRegistrationTransition({
      identityId: OWNER,
      authPrivateKey,
      authPublicKey: getPublicKey(authPrivateKey),
      encryptionPrivateKey,
      encryptionPublicKey: getPublicKey(encryptionPrivateKey),
    })
    return transitionBytes
  }],
  ['messaging key', 'IdentityUpdate', async () => {
    const { buildUnsignedBoundEncryptionKeyTransition } = await import('./identity-update-builder')
    const { transitionBytes } = await buildUnsignedBoundEncryptionKeyTransition({
      identityId: OWNER,
      encryptionPrivateKey: new Uint8Array(32).fill(4),
      contractId: ANCHOR,
    })
    return transitionBytes
  }],
  ['YAPP purchase', 'DocumentsBatch([TokenDirectPurchase])', async () => {
    const { buildUnsignedDirectPurchaseTransition } = await import('./token-purchase-builder')
    return (await buildUnsignedDirectPurchaseTransition(OWNER, BigInt(5), BigInt(1_000_000))).bytes
  }],
  ['YAPP tip', 'DocumentsBatch([TokenTransfer])', async () => {
    const { buildUnsignedYappTipTransition } = await import('./token-transfer-builder')
    return (await buildUnsignedYappTipTransition(OWNER, RECIPIENT, BigInt(1), 'thanks')).bytes
  }],
]

describe('dash-st: payloads (#612)', () => {
  it.each(payloads)('the %s link carries a tagged StateTransition', async (_name, actionType, build) => {
    const bytes = await build()
    const parsed = parseYapprStateTransitionUri(buildYapprStateTransitionUri(bytes, 'testnet'))
    if (!parsed) throw new Error('unparseable dash-st: URI')
    expect(parsed.transitionBytes).toEqual(bytes)
    const decoded = StateTransition.fromBytes(parsed.transitionBytes)
    try {
      expect(decoded.actionType).toBe(actionType)
      expect(decoded.toBytes()).toEqual(bytes)
    } finally {
      decoded.free()
    }
  })
})
