import { describe, expect, it } from 'vitest'
import { memoryStorage } from '@/lib/test-storage'
import { purgeRetiredSecrets } from './retired-secrets'

describe('purgeRetiredSecrets', () => {
  it('removes every retired vault data key under the prefix and nothing else', () => {
    const storage = memoryStorage()
    storage.setItem('devnet:yappr_secure_avd_alice', '"dek"')
    storage.setItem('devnet:yappr_secure_avd_bob', '"dek"')
    storage.setItem('devnet:yappr_secure_pk_alice', '"wif"')
    storage.setItem('devnet:yappr_secure_ek_alice', '"wif"')
    // Another deployment's scope is its own build's to clean.
    storage.setItem('testing:yappr_secure_avd_alice', '"dek"')

    purgeRetiredSecrets(storage, 'devnet:yappr_secure_')

    expect(storage.getItem('devnet:yappr_secure_avd_alice')).toBeNull()
    expect(storage.getItem('devnet:yappr_secure_avd_bob')).toBeNull()
    expect(storage.getItem('devnet:yappr_secure_pk_alice')).toBe('"wif"')
    expect(storage.getItem('devnet:yappr_secure_ek_alice')).toBe('"wif"')
    expect(storage.getItem('testing:yappr_secure_avd_alice')).toBe('"dek"')
  })
})
