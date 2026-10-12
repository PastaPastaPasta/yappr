/**
 * The App Connect responder's offline pieces: sealing against the published
 * interop vectors, the deterministic key derivation, fault-flag parsing and
 * the grant state file.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { openAppConnectPayload } from '../../../vendor/platform-auth/src/app-connect/crypto'
import { parseAppConnectUri } from '../../../vendor/platform-auth/src/app-connect/request'
import { verifyAppConnectCandidate } from '../../../vendor/platform-auth/src/app-connect/verify'
import {
  appConnectDerivationTag,
  deriveAppConnectAuthKey,
  deriveAppConnectEncryptionKey,
} from '../src/app-connect/derive'
import { describeFaults, parseFaults } from '../src/app-connect/faults'
import { fileGrantStore } from '../src/app-connect/state'
import { respondToAppConnect, sealAppConnectResponse } from '../src/app-connect/wallet'
import { MemoryChain } from './app-connect-chain'
import { IDENTITY_ID_BYTES, testPersona, testPrivateKey } from './fixtures'

const vectors = JSON.parse(readFileSync(new URL('../../../vendor/platform-auth/src/app-connect/vectors.json', import.meta.url), 'utf8'))

describe('sealing against the App Connect v2 vectors', () => {
  const { inputs, request, response } = vectors

  it('reproduces the published response byte for byte', async () => {
    const sealed = await sealAppConnectResponse({
      request: { appEphemeralPubKey: hexToBytes(request.appEphemeralPubKey) },
      ownerId: bs58.decode(inputs.ownerId),
      slots: inputs.slotPrivateKeys.map(hexToBytes),
      walletEphemeralPrivateKey: hexToBytes(inputs.walletEphemeralPrivateKey),
      nonce: hexToBytes(inputs.nonce),
    })
    expect(bytesToHex(sealed.appEphemeralPubKeyHash)).toBe(request.appEphemeralPubKeyHash)
    expect(bytesToHex(sealed.walletEphemeralPubKey)).toBe(response.walletEphemeralPubKey)
    expect(bytesToHex(sealed.encryptedPayload)).toBe(response.encryptedPayload)
  })

  it('bad-tag breaks exactly the tag', async () => {
    const sealed = await sealAppConnectResponse({
      request: { appEphemeralPubKey: hexToBytes(request.appEphemeralPubKey) },
      ownerId: bs58.decode(inputs.ownerId),
      slots: inputs.slotPrivateKeys.map(hexToBytes),
      walletEphemeralPrivateKey: hexToBytes(inputs.walletEphemeralPrivateKey),
      nonce: hexToBytes(inputs.nonce),
      badTag: true,
    })
    const published = hexToBytes(response.encryptedPayload)
    expect(bytesToHex(sealed.encryptedPayload.subarray(0, -1))).toBe(bytesToHex(published.subarray(0, -1)))
    await expect(openAppConnectPayload({
      appEphemeralPrivateKey: hexToBytes(inputs.appEphemeralPrivateKey),
      ownerId: bs58.decode(inputs.ownerId),
      walletEphemeralPubKey: sealed.walletEphemeralPubKey,
      encryptedPayload: sealed.encryptedPayload,
    })).rejects.toThrow(/does not decrypt/)
  })

  it('answers the published request URI end to end, and the app opens and verifies the answer', async () => {
    const { request: parsed } = parseAppConnectUri(request.uri)
    const chain = new MemoryChain(inputs.createdAt + 30_000)
    const owner = bs58.encode(new Uint8Array(32).fill(0xb1))
    chain.contracts.set(inputs.appId, { ownerId: owner, requiresIdentityEncryptionBoundedKey: 2 })
    chain.contracts.set(inputs.dashpayContractId, { ownerId: '11111111111111111111111111111111' })
    chain.groups.set(inputs.groupId, owner)
    const persona = testPersona()

    const result = await respondToAppConnect({ uri: request.uri, persona }, chain.ports())
    expect(result.callbackUrl).toBe(`https://yap.pr/connect?r=${request.appEphemeralPubKeyHash}&ac=ok`)
    const [candidate] = chain.candidates(hexToBytes(request.appEphemeralPubKeyHash))
    const slots = await openAppConnectPayload({
      appEphemeralPrivateKey: hexToBytes(inputs.appEphemeralPrivateKey),
      ownerId: persona.identityIdBytes,
      walletEphemeralPubKey: candidate.walletEphemeralPubKey,
      encryptedPayload: candidate.encryptedPayload,
    })
    expect(slots).toHaveLength(3)
    const verification = await verifyAppConnectCandidate({
      request: parsed,
      appEphemeralPrivateKey: hexToBytes(inputs.appEphemeralPrivateKey),
      candidate,
      identity: chain.identityPort(),
      now: chain.now,
    })
    expect(verification.ok).toBe(true)
  })
})

describe('App Connect key derivation', () => {
  const appEphemeralPubKey = hexToBytes(vectors.request.appEphemeralPubKey)
  const appId = bs58.decode(vectors.inputs.appId)
  const encoder = new TextEncoder()

  it('is the documented HKDF over keyId 1, written out independently', () => {
    const tag = sha256(sha256(appEphemeralPubKey))
    expect(bytesToHex(appConnectDerivationTag(appEphemeralPubKey))).toBe(bytesToHex(tag))
    const auth = hkdf(sha256, testPrivateKey(1), IDENTITY_ID_BYTES, concatBytes(encoder.encode('yappr-test-wallet/app-connect/auth'), tag, Uint8Array.of(1)), 32)
    expect(bytesToHex(deriveAppConnectAuthKey(testPrivateKey(1), IDENTITY_ID_BYTES, tag, 1))).toBe(bytesToHex(auth))
    const enc = hkdf(sha256, testPrivateKey(1), IDENTITY_ID_BYTES, concatBytes(encoder.encode('yappr-test-wallet/app-connect/enc'), appId, Uint8Array.of(1, 0, 0, 0, 0)), 32)
    expect(bytesToHex(deriveAppConnectEncryptionKey(testPrivateKey(1), IDENTITY_ID_BYTES, appId, 1, 0))).toBe(bytesToHex(enc))
  })

  it('gives a fresh key per request and binding, and one encryption key per (app, purpose, rotation)', () => {
    const tag = appConnectDerivationTag(appEphemeralPubKey)
    const otherTag = appConnectDerivationTag(hexToBytes(vectors.response.walletEphemeralPubKey))
    const keys = [
      deriveAppConnectAuthKey(testPrivateKey(1), IDENTITY_ID_BYTES, tag, 0),
      deriveAppConnectAuthKey(testPrivateKey(1), IDENTITY_ID_BYTES, tag, 1),
      deriveAppConnectAuthKey(testPrivateKey(1), IDENTITY_ID_BYTES, otherTag, 0),
      deriveAppConnectEncryptionKey(testPrivateKey(1), IDENTITY_ID_BYTES, appId, 1, 0),
      deriveAppConnectEncryptionKey(testPrivateKey(1), IDENTITY_ID_BYTES, appId, 2, 0),
      deriveAppConnectEncryptionKey(testPrivateKey(1), IDENTITY_ID_BYTES, appId, 1, 1),
    ].map(bytesToHex)
    expect(new Set(keys).size).toBe(keys.length)
    expect(bytesToHex(deriveAppConnectAuthKey(testPrivateKey(1), IDENTITY_ID_BYTES, tag, 0))).toBe(keys[0])
  })
})

describe('fault flags', () => {
  it('parses every flag and prints them back', () => {
    const list = [
      'wrong-owner', 'copy-response', 'unregistered-key', 'critical', 'foreign-group=CsPWxFwNvLPjACBCQBSXJLHAimU44DDFimzA2Jbxm9GK',
      'expired', 'budget=1000', 'bad-tag', 'extra-slot', 'spam=3', 'second-identity', 'omit-enc', 'omit-profile',
    ]
    const faults = parseFaults(list)
    expect(faults).toMatchObject({ wrongOwner: true, budget: 1000n, spam: 3, foreignGroup: 'CsPWxFwNvLPjACBCQBSXJLHAimU44DDFimzA2Jbxm9GK' })
    expect(describeFaults(faults).sort()).toEqual([...list].sort())
    expect(parseFaults(['unbound-key', 'expires-in=60'])).toMatchObject({ unboundKey: true, expiresInSeconds: 60 })
  })

  it.each([
    [['nope'], /unknown fault/],
    [['bad-tag', 'bad-tag'], /repeated/],
    [['bad-tag=1'], /takes no value/],
    [['budget'], /needs a value/],
    [['budget=0'], /between 1/],
    [['expires-in=-5'], /positive integer/],
    [['spam=51'], /at most 50/],
    [['foreign-group=0OIl'], /base58/],
    [['expired', 'expires-in=60'], /exclude/],
    [['unbound-key', 'unregistered-key'], /exclude/],
  ])('refuses %j', (list, message) => {
    expect(() => parseFaults(list)).toThrow(message)
  })
})

describe('grant state file', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('round-trips records per (identity, app), refuses another devnet, and holds no private key', async () => {
    dir = mkdtempSync(join(tmpdir(), 'app-connect-state-'))
    const path = join(dir, 'nested', 'state.json')
    const chain = new MemoryChain(1_791_676_800_000)
    const appId = bs58.encode(new Uint8Array(32).fill(0xa1))
    const owner = bs58.encode(new Uint8Array(32).fill(0xb1))
    chain.contracts.set(appId, { ownerId: owner, requiresIdentityEncryptionBoundedKey: 2 })
    chain.groups.set(bs58.encode(new Uint8Array(32).fill(0xa2)), owner)
    const ports = { ...chain.ports(), grants: fileGrantStore(path, 'sakura') }

    const { request } = parseAppConnectUri(vectors.request.uri)
    request.appId = new Uint8Array(32).fill(0xa1)
    request.authBindings = [{ ...request.authBindings[0], id: new Uint8Array(32).fill(0xa2) }]
    request.encBindings = [{ contractId: request.appId, purpose: 1 }]
    request.createdAt = chain.now
    const { buildAppConnectUri } = await import('../../../vendor/platform-auth/src/app-connect/request')
    const persona = testPersona()
    await respondToAppConnect({ uri: buildAppConnectUri(request, 'devnet'), persona }, ports)

    const record = fileGrantStore(path, 'sakura').get(persona.identityId, appId)
    expect(record.responses).toHaveLength(1)
    expect(Object.values(record.connections)[0].keys.map((key) => key.keyId)).toEqual([3])

    const text = readFileSync(path, 'utf8')
    const secrets = [testPrivateKey(0), testPrivateKey(1), testPrivateKey(2)].map(bytesToHex)
    const derived = deriveAppConnectAuthKey(testPrivateKey(1), persona.identityIdBytes, appConnectDerivationTag(request.appEphemeralPubKey), 0)
    for (const secret of [...secrets, bytesToHex(derived)]) expect(text).not.toContain(secret)

    expect(() => fileGrantStore(path, 'bonsia').get(persona.identityId, appId)).toThrow(/belongs to devnet sakura/)
    writeFileSync(path, '{"version":2}')
    expect(() => fileGrantStore(path, 'sakura').get(persona.identityId, appId)).toThrow(/not an App Connect state file/)
  })
})
