import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'
import { sha256 } from '@noble/hashes/sha2.js'
import { getPublicKey } from '@/lib/crypto/keys'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { deriveEncryptionKey } from '@/lib/crypto/derive-encryption-key'
import { stubAppConnectBuild, stubBrowserStorage } from '@/lib/test-storage'

const mocks = vi.hoisted(() => ({
  currentKey: vi.fn<() => Promise<Uint8Array | null>>(),
  addEncryptionKey: vi.fn(),
  validateKeySecurityLevel: vi.fn(),
  clearCache: vi.fn(),
}))

vi.mock('@/lib/crypto/encryption-key-lookup', () => ({ resolveEncryptionPublicKey: () => mocks.currentKey() }))
vi.mock('./identity-service', () => ({
  identityService: {
    addEncryptionKey: mocks.addEncryptionKey,
    validateKeySecurityLevel: mocks.validateKeySecurityLevel,
    clearCache: mocks.clearCache,
  },
}))

const id = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const IDENTITY = id(7)
const ANCHOR = id(1)
const LOGIN_KEY = sha256(new TextEncoder().encode('messaging setup login key'))
const LOGIN_WIF = privateKeyToWif(LOGIN_KEY, 'testnet', true)
const EXPECTED = deriveEncryptionKey(LOGIN_KEY, IDENTITY, ANCHOR)

async function load() {
  vi.resetModules()
  const service = await import('./messaging-key-service')
  const storage = await import('@/lib/secure-storage')
  return { ...service, ...storage }
}

beforeEach(() => {
  stubBrowserStorage()
  stubAppConnectBuild(ANCHOR, id(3))
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('messaging key setup', () => {
  it('derives the anchor key from the login key', async () => {
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    const draft = s.draftMessagingKey(IDENTITY)
    expect(draft).toMatchObject({ identityId: IDENTITY, anchorId: ANCHOR, privateKey: EXPECTED, publicKey: getPublicKey(EXPECTED) })
  })

  it('needs a login key and an anchor', async () => {
    let s = await load()
    expect(() => s.draftMessagingKey(IDENTITY)).toThrow(/Sign in again/)
    vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', '')
    s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    expect(() => s.draftMessagingKey(IDENTITY)).toThrow(/isn't available/)
  })

  it('compares the draft with the anchor\'s current key', async () => {
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    const draft = s.draftMessagingKey(IDENTITY)
    mocks.currentKey.mockResolvedValueOnce(null)
    await expect(s.anchorKeyState(draft)).resolves.toBe('none')
    mocks.currentKey.mockResolvedValueOnce(getPublicKey(sha256(new TextEncoder().encode('a wallet-made key'))))
    await expect(s.anchorKeyState(draft)).resolves.toBe('other-key')
    mocks.currentKey.mockResolvedValueOnce(getPublicKey(EXPECTED))
    await expect(s.anchorKeyState(draft)).resolves.toBe('this-key')
    mocks.currentKey.mockRejectedValueOnce(new Error('DAPI down'))
    await expect(s.anchorKeyState(draft)).rejects.toThrow('DAPI down')
  })

  it('adopts the key as the session encryption key', async () => {
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    const draft = s.draftMessagingKey(IDENTITY)
    expect(s.hasEncryptionKey(IDENTITY)).toBe(false)
    const wif = s.adoptMessagingKey(draft)
    expect(wif).toBe(privateKeyToWif(EXPECTED, 'testnet', true))
    expect(s.getEncryptionKeyBytes(IDENTITY)).toEqual(EXPECTED)
    expect(s.getEncryptionKeyType(IDENTITY)).toBe('derived')
    expect(mocks.clearCache).toHaveBeenCalledWith(IDENTITY)
  })

  it('reports a refused master-signed update', async () => {
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    const draft = s.draftMessagingKey(IDENTITY)
    mocks.addEncryptionKey.mockResolvedValueOnce({ success: false, error: 'Identity modifications require a MASTER key. You provided a HIGH key.' })
    await expect(s.addMessagingKeyWithMasterKey(draft, LOGIN_WIF)).rejects.toThrow(/MASTER/)
    expect(mocks.addEncryptionKey).toHaveBeenCalledWith(IDENTITY, EXPECTED, LOGIN_WIF)
    mocks.addEncryptionKey.mockResolvedValueOnce({ success: false, error: 'Identity already has an encryption key' })
    await expect(s.addMessagingKeyWithMasterKey(draft, LOGIN_WIF)).rejects.toBeInstanceOf(s.MessagingAlreadySetUpError)
  })

  it('accepts a hex master key, signing with its WIF', async () => {
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    const draft = s.draftMessagingKey(IDENTITY)
    mocks.addEncryptionKey.mockResolvedValueOnce({ success: true, keyId: 5 })
    await s.addMessagingKeyWithMasterKey(draft, Buffer.from(LOGIN_KEY).toString('hex'))
    expect(mocks.addEncryptionKey).toHaveBeenCalledWith(IDENTITY, EXPECTED, LOGIN_WIF)
  })

  it('confirms a stored key that is the anchor key, even one not derived from the login key', async () => {
    const s = await load()
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    // As a password vault restores it: stored without any check.
    const vaultKey = sha256(new TextEncoder().encode('a key the user entered once'))
    s.storeEncryptionKey(IDENTITY, privateKeyToWif(vaultKey, 'testnet', true))
    expect(s.hasEncryptionKey(IDENTITY)).toBe(false)

    mocks.currentKey.mockResolvedValueOnce(getPublicKey(EXPECTED))
    await expect(s.confirmStoredEncryptionKey(IDENTITY)).resolves.toBe(false)
    expect(s.hasEncryptionKey(IDENTITY)).toBe(false)

    mocks.currentKey.mockResolvedValueOnce(getPublicKey(vaultKey))
    await expect(s.confirmStoredEncryptionKey(IDENTITY)).resolves.toBe(true)
    expect(s.getEncryptionKeyBytes(IDENTITY)).toEqual(vaultKey)
  })

  it('knows whether the login key is the MASTER key', async () => {
    const s = await load()
    await expect(s.loginKeyIsMaster(IDENTITY)).resolves.toBe(false)
    s.storePrivateKey(IDENTITY, LOGIN_WIF)
    mocks.validateKeySecurityLevel.mockResolvedValueOnce({ isValid: true })
    await expect(s.loginKeyIsMaster(IDENTITY)).resolves.toBe(true)
  })
})
