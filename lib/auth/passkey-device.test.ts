import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { clearPasskeyCriticalKey, isPasskeyCriticalKey, keepOnlyPasskeyCriticalKey, markPasskeyCriticalKey, settlePasskeyCriticalMarks } from './passkey-device'

const wif = (label: string) => privateKeyToWif(sha256(new TextEncoder().encode(label)), 'testnet', true)
const PASSKEY_KEY = wif('passkey CRITICAL key')
const TYPED_KEY = wif('typed CRITICAL key')

describe('passkey CRITICAL-key marks', () => {
  it('hold back only the exact key a passkey gave, for that identity', () => {
    markPasskeyCriticalKey('alice', PASSKEY_KEY)
    expect(isPasskeyCriticalKey('alice', PASSKEY_KEY)).toBe(true)
    expect(isPasskeyCriticalKey('alice', TYPED_KEY)).toBe(false)
    expect(isPasskeyCriticalKey('bob', PASSKEY_KEY)).toBe(false)
    clearPasskeyCriticalKey('alice')
    expect(isPasskeyCriticalKey('alice', PASSKEY_KEY)).toBe(false)
  })

  it('fail safe for a key whose fingerprint cannot be taken', () => {
    markPasskeyCriticalKey('dave', 'not a key')
    expect(isPasskeyCriticalKey('dave', TYPED_KEY)).toBe(true)
    clearPasskeyCriticalKey('dave')
  })
})

describe('passkey CRITICAL-key marks across a key change', () => {
  it('keep the old key marked until the new key is stored', () => {
    markPasskeyCriticalKey('erin', PASSKEY_KEY)
    // A passkey sign-in with another CRITICAL key adds its mark before storing...
    const NEXT_KEY = wif('next passkey CRITICAL key')
    markPasskeyCriticalKey('erin', NEXT_KEY)
    // ...and if that store failed, the key still stored stays marked.
    expect(isPasskeyCriticalKey('erin', PASSKEY_KEY)).toBe(true)
    // Once it is stored, only it stays marked.
    keepOnlyPasskeyCriticalKey('erin', NEXT_KEY)
    expect(isPasskeyCriticalKey('erin', PASSKEY_KEY)).toBe(false)
    expect(isPasskeyCriticalKey('erin', NEXT_KEY)).toBe(true)
    // A typed key stored afterwards clears them.
    keepOnlyPasskeyCriticalKey('erin', null)
    expect(isPasskeyCriticalKey('erin', NEXT_KEY)).toBe(false)
  })
})

describe('passkey CRITICAL-key marks after a store', () => {
  it('change only when the store really holds the new key', () => {
    markPasskeyCriticalKey('fay', PASSKEY_KEY)
    // A typed key whose write was silently dropped: the passkey key is still stored, and stays marked.
    settlePasskeyCriticalMarks('fay', TYPED_KEY, PASSKEY_KEY, false)
    expect(isPasskeyCriticalKey('fay', PASSKEY_KEY)).toBe(true)
    settlePasskeyCriticalMarks('fay', TYPED_KEY, null, false)
    expect(isPasskeyCriticalKey('fay', PASSKEY_KEY)).toBe(true)
    // Once it really is stored, the marks go.
    settlePasskeyCriticalMarks('fay', TYPED_KEY, TYPED_KEY, false)
    expect(isPasskeyCriticalKey('fay', PASSKEY_KEY)).toBe(false)
  })
})
