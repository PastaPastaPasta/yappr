import { describe, expect, it } from 'vitest'
import { bytesToBase64, bytesToHex } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { IDENTITY_GAP_LIMIT, type Dip13Key, type Dip13Wallet } from '@/lib/crypto/dip13'
import { hash160 } from '@/lib/crypto/hash'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  PHRASE_HOLDS_NO_CRITICAL_KEY,
  criticalKeyFromPhrase,
  criticalKeyFromPrivateKey,
  looksLikeRecoveryPhrase,
} from './critical-key-input'

const priv = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + seed) % 251 + 1)
const key = (id: number, privateKey: Uint8Array, securityLevel: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: KeyType.ECDSA_SECP256K1,
  purpose: KeyPurpose.AUTHENTICATION,
  securityLevel,
  data: bytesToBase64(getPublicKey(privateKey)),
  ...extra,
})

describe('looksLikeRecoveryPhrase', () => {
  it('reads twelve words or more as a phrase, anything else as a key', () => {
    expect(looksLikeRecoveryPhrase(' abandon '.repeat(12))).toBe(true)
    expect(looksLikeRecoveryPhrase(Array(24).fill('zoo').join('\n'))).toBe(true)
    expect(looksLikeRecoveryPhrase(privateKeyToWif(priv(1), 'testnet', true))).toBe(false)
    expect(looksLikeRecoveryPhrase('one two three')).toBe(false)
  })
})

describe('criticalKeyFromPrivateKey', () => {
  const keys = [key(1, priv(1), SecurityLevel.CRITICAL), key(2, priv(2), SecurityLevel.HIGH), key(3, priv(3), SecurityLevel.CRITICAL, { disabledAt: 9 })]

  it('accepts the CRITICAL key as WIF or hex, as a compressed WIF', () => {
    const wif = privateKeyToWif(priv(1), 'testnet', true)
    expect(criticalKeyFromPrivateKey(`  ${wif} `, keys, 'testnet')).toEqual({ ok: true, wif })
    expect(criticalKeyFromPrivateKey(bytesToHex(priv(1)), keys, 'testnet')).toEqual({ ok: true, wif })
    expect(criticalKeyFromPrivateKey(`0x${bytesToHex(priv(1))}`, keys, 'testnet')).toEqual({ ok: true, wif })
  })

  it('names a HIGH key as another of the account\'s keys', () => {
    const result = criticalKeyFromPrivateKey(privateKeyToWif(priv(2), 'testnet', true), keys, 'testnet')
    expect(result).toEqual({ ok: false, error: expect.stringContaining('another of this account') })
  })

  it('refuses a disabled CRITICAL key as turned off', () => {
    const result = criticalKeyFromPrivateKey(privateKeyToWif(priv(3), 'testnet', true), keys, 'testnet')
    expect(result).toEqual({ ok: false, error: expect.stringContaining('turned off') })
  })

  it('refuses another identity\'s key, a key for another network, and garbage', () => {
    expect(criticalKeyFromPrivateKey(privateKeyToWif(priv(9), 'testnet', true), keys, 'testnet'))
      .toEqual({ ok: false, error: expect.stringContaining('doesn\'t belong') })
    expect(criticalKeyFromPrivateKey(privateKeyToWif(priv(1), 'mainnet', true), keys, 'testnet'))
      .toEqual({ ok: false, error: expect.stringContaining('different network') })
    expect(criticalKeyFromPrivateKey('not a key', keys, 'testnet').ok).toBe(false)
  })
})

describe('criticalKeyFromPhrase', () => {
  /** A stand-in wallet: the key at identity index i, key index k is a hash of the two. */
  const derivedAt = (identityIndex: number, keyIndex: number) => sha256(new TextEncoder().encode(`${identityIndex}/${keyIndex}`))
  const derivations: string[] = []
  const wallet: Dip13Wallet = {
    derive(path: string): Dip13Key {
      derivations.push(path)
      const [, , , , , , identity, keyPart] = path.split('/')
      const privateKey = derivedAt(parseInt(identity, 10), parseInt(keyPart, 10))
      return { privateKey, publicKey: getPublicKey(privateKey) }
    },
  }
  /** The phrase's identities on chain: identity indexes 0 to `last`, found by their MASTER key's hash. */
  const chainUpTo = (last: number) => {
    const used = new Set(Array.from({ length: last + 1 }, (_, i) => bytesToHex(hash160(getPublicKey(derivedAt(i, 0))))))
    const lookups: string[] = []
    const lookup = async (hash: Uint8Array) => {
      lookups.push(bytesToHex(hash))
      return used.has(bytesToHex(hash)) ? 'SomeIdentity' : null
    }
    return { lookup, lookups }
  }

  it('derives the account\'s CRITICAL key at its identity index (DIP-13, key index = key id), without a read for index 0', async () => {
    const keys = [key(0, derivedAt(0, 0), SecurityLevel.MASTER), key(1, derivedAt(0, 1), SecurityLevel.CRITICAL), key(2, derivedAt(0, 2), SecurityLevel.HIGH)]
    const { lookup, lookups } = chainUpTo(0)
    expect(await criticalKeyFromPhrase(wallet, keys, 'testnet', lookup)).toEqual({ ok: true, wif: privateKeyToWif(derivedAt(0, 1), 'testnet', true) })
    expect(derivations.at(-1)).toBe('m/9\'/1\'/5\'/0\'/0\'/0\'/1\'')
    expect(lookups).toEqual([])
  })

  it('finds an account past identity index 31, walking the phrase\'s identities as sign-in does', async () => {
    const keys = [key(0, derivedAt(40, 0), SecurityLevel.MASTER), key(1, derivedAt(40, 1), SecurityLevel.CRITICAL)]
    const { lookup } = chainUpTo(40)
    expect(await criticalKeyFromPhrase(wallet, keys, 'testnet', lookup)).toEqual({ ok: true, wif: privateKeyToWif(derivedAt(40, 1), 'testnet', true) })
  })

  it('stops after the gap limit of unused identity indexes, and says so', async () => {
    const notThePhrase = [key(1, priv(7), SecurityLevel.CRITICAL), key(2, derivedAt(0, 2), SecurityLevel.HIGH)]
    const { lookup, lookups } = chainUpTo(1)
    expect(await criticalKeyFromPhrase(wallet, notThePhrase, 'testnet', lookup)).toEqual({ ok: false, error: PHRASE_HOLDS_NO_CRITICAL_KEY })
    expect(lookups).toHaveLength(2 + IDENTITY_GAP_LIMIT)
    const disabled = [key(1, derivedAt(0, 1), SecurityLevel.CRITICAL, { disabledAt: 3 })]
    expect(await criticalKeyFromPhrase(wallet, disabled, 'testnet', lookup)).toEqual({ ok: false, error: PHRASE_HOLDS_NO_CRITICAL_KEY })
  })

  it('throws when an identity cannot be read, rather than calling the phrase wrong', async () => {
    const keys = [key(1, priv(7), SecurityLevel.CRITICAL)]
    await expect(criticalKeyFromPhrase(wallet, keys, 'testnet', async () => { throw new Error('unreachable') })).rejects.toThrow('unreachable')
  })
})
