import { afterEach, describe, expect, it } from 'vitest'
import * as secp256k1 from '@noble/secp256k1'
import { bytesToHex } from '@/lib/bytes'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { deriveCharterKey, forgetCharterKeys, heldCharterKey, holdCharterKey, keyMatches, readPrivateKeyInput } from './charter-keys'

const MASTER = new Uint8Array(32).fill(7)
const ID = '8dLEE3uH5S81Y3CL4zQdDGeXuyo8icn6YiJUPkpFo4GV'

afterEach(() => forgetCharterKeys())

describe('charter keys made from the MASTER key', () => {
  it('gives the same key for the same master, identity and role, and a different one otherwise', () => {
    const leader = deriveCharterKey(MASTER, ID, 'leader')
    expect(deriveCharterKey(MASTER, ID, 'leader')).toEqual(leader)
    expect(secp256k1.utils.isValidSecretKey(leader)).toBe(true)
    expect(deriveCharterKey(MASTER, ID, 'member')).not.toEqual(leader)
    expect(deriveCharterKey(MASTER, 'GwLJpB3EJr9yatYFsT9GEbQPrJ2GxVXYrqLHH3zVFk9n', 'leader')).not.toEqual(leader)
    expect(deriveCharterKey(new Uint8Array(32).fill(8), ID, 'leader')).not.toEqual(leader)
    // Never the master key itself.
    expect(leader).not.toEqual(MASTER)
  })

  it('pins the derivation, so a key made in one browser is the same in another', () => {
    expect(bytesToHex(deriveCharterKey(MASTER, ID, 'leader'))).toBe('8a6e893599d19e65ee118057f0d14b5bdb68b255d3f44deb0d26e92dfa139151')
    expect(bytesToHex(deriveCharterKey(MASTER, ID, 'member'))).toBe('13be3a684ac0dfe11b6b005fffbf22c94ab53634b72a339013ca27955485ddac')
  })

  it('refuses a master key that is not 32 bytes', () => {
    expect(() => deriveCharterKey(new Uint8Array(31), ID, 'leader')).toThrow('32 bytes')
  })
})

describe('reading a typed key', () => {
  it('reads a WIF, 64 hex digits, or the release CLI key file', () => {
    const wif = privateKeyToWif(MASTER, 'testnet')
    expect(readPrivateKeyInput(` ${wif} `)).toEqual(MASTER)
    expect(readPrivateKeyInput(bytesToHex(MASTER))).toEqual(MASTER)
    expect(readPrivateKeyInput(JSON.stringify({ identityId: ID, identityKeys: [{ id: 9, privateKeyWif: wif }] }))).toEqual(MASTER)
  })

  it('says plainly when there is no key in it', () => {
    expect(() => readPrivateKeyInput('hello')).toThrow('not a private key')
    expect(() => readPrivateKeyInput('{"identityKeys":[]}')).toThrow('holds no key')
    expect(() => readPrivateKeyInput('{not json')).toThrow('could not be read')
  })

  it('matches a private key to a compressed public key', () => {
    const key = deriveCharterKey(MASTER, ID, 'member')
    expect(keyMatches(key, secp256k1.getPublicKey(key, true))).toBe(true)
    expect(keyMatches(MASTER, secp256k1.getPublicKey(key, true))).toBe(false)
    expect(keyMatches(new Uint8Array(32), secp256k1.getPublicKey(key, true))).toBe(false)
  })
})

describe('keys held in this tab', () => {
  it('holds a copy per identity and role, and forgets it', () => {
    const key = deriveCharterKey(MASTER, ID, 'leader')
    holdCharterKey(ID, 'leader', key)
    key.fill(0)
    expect(heldCharterKey(ID, 'leader')).toEqual(deriveCharterKey(MASTER, ID, 'leader'))
    expect(heldCharterKey(ID, 'member')).toBeNull()
    holdCharterKey('other', 'member', MASTER)
    forgetCharterKeys(ID)
    expect(heldCharterKey(ID, 'leader')).toBeNull()
    expect(heldCharterKey('other', 'member')).not.toBeNull()
    forgetCharterKeys()
    expect(heldCharterKey('other', 'member')).toBeNull()
  })
})
