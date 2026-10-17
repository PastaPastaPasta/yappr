import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { clearPasskeyCriticalKey, isPasskeyCriticalKey, markPasskeyCriticalKey, unmarkPasskeyCriticalKey } from './passkey-device'

const wif = (label: string) => privateKeyToWif(sha256(new TextEncoder().encode(label)), 'testnet', true)
const PASSKEY_KEY = wif('passkey CRITICAL key')
const TYPED_KEY = wif('typed CRITICAL key')

describe('passkey CRITICAL-key marks', () => {
  it('hold back only the exact key a passkey gave', () => {
    markPasskeyCriticalKey('alice', PASSKEY_KEY)
    expect(isPasskeyCriticalKey('alice', PASSKEY_KEY)).toBe(true)
    expect(isPasskeyCriticalKey('alice', TYPED_KEY)).toBe(false)
    expect(isPasskeyCriticalKey('bob', PASSKEY_KEY)).toBe(false)
    clearPasskeyCriticalKey('alice')
    expect(isPasskeyCriticalKey('alice', PASSKEY_KEY)).toBe(false)
  })

  it('let a superseded sign-in remove its own mark, never a winner\'s', () => {
    const winner = markPasskeyCriticalKey('carol', PASSKEY_KEY)
    const loser = markPasskeyCriticalKey('carol', PASSKEY_KEY)
    unmarkPasskeyCriticalKey('carol', loser)
    expect(isPasskeyCriticalKey('carol', PASSKEY_KEY)).toBe(true)
    unmarkPasskeyCriticalKey('carol', winner)
    expect(isPasskeyCriticalKey('carol', PASSKEY_KEY)).toBe(false)
  })

  it('fail safe for a key whose fingerprint cannot be taken', () => {
    markPasskeyCriticalKey('dave', 'not a key')
    expect(isPasskeyCriticalKey('dave', TYPED_KEY)).toBe(true)
    clearPasskeyCriticalKey('dave')
  })
})
