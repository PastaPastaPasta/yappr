/**
 * session.* on testnet, read only: the public-key-hash lookup sign-in relies
 * on, and the key checks that reject before anything is stored. Nothing here
 * signs or writes: the only keys used are freshly generated ones no identity
 * holds. Sign-in proper runs on sakura (test/contract/write).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import * as secp256k1 from '@noble/secp256k1'
import { connectEngine } from './engine'
import { hash160 } from '@/lib/crypto/hash'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { normalizeBytes, bytesToHex } from '@/lib/bytes'
import { identityService } from '@/lib/services/identity-service'

const engine = connectEngine().api

const ECDSA_SECP256K1 = 0

describe('session reads on testnet', () => {
  let knownIdentity = ''

  beforeAll(async () => {
    await engine.engine.boot()
    // A real, active identity: the author of the newest For You post.
    const page = await engine.feed.home({ tab: 'forYou' })
    knownIdentity = page.items[0]?.author.id ?? ''
    expect(knownIdentity).not.toBe('')
  })

  it('starts signed out with no accounts', async () => {
    expect(await engine.session.current()).toBeNull()
    expect(await engine.session.accounts()).toEqual([])
    expect(await engine.writes.list()).toEqual([])
  })

  it('finds an identity from the hash of one of its public keys (identities.byPublicKeyHash)', async () => {
    const identity = await identityService.getIdentity(knownIdentity)
    const keys = (identity?.publicKeys ?? [])
      .map(key => ({ type: Number(key.type), data: normalizeBytes(key.data) }))
      .filter(key => key.type === ECDSA_SECP256K1 && key.data?.length === 33)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys.slice(0, 2)) {
      expect(await identityService.getIdentityIdByPublicKeyHash(hash160(key.data as Uint8Array)), bytesToHex(hash160(key.data as Uint8Array))).toBe(knownIdentity)
    }
  })

  it('says no identity uses a key nobody holds, across the bridge, without signing in', async () => {
    const fresh = secp256k1.utils.randomSecretKey()
    await expect(engine.session.checkKey({ key: bytesToHex(fresh) })).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND', message: 'No identity uses this key' })
    await expect(engine.session.signInWithKey({ key: privateKeyToWif(fresh, 'testnet') })).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' })
    expect(await engine.session.current()).toBeNull()
  })

  it('rejects a key for another network before any lookup', async () => {
    const mainnet = privateKeyToWif(secp256k1.utils.randomSecretKey(), 'mainnet')
    await expect(engine.session.checkKey({ key: mainnet })).rejects.toMatchObject({ code: 'KEY_WRONG_NETWORK' })
    await expect(engine.session.checkKey({ key: 'not a key' })).rejects.toMatchObject({ code: 'KEY_INVALID' })
  })

  it('serves the settings lib reads', async () => {
    expect(await engine.settings.get()).toMatchObject({ sensitiveContentMode: 'blur', feedLanguage: 'en', payWith: 'yapp' })
  })
})
