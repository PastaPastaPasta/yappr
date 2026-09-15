import { describe, expect, it } from 'vitest'
import {
  AES_GCM_IV_LENGTH,
  MAX_KDF_ITERATIONS,
  MIN_KDF_ITERATIONS,
  aesGcmDecrypt,
  aesGcmEncrypt,
  aesGcmOpen,
  aesGcmSeal,
  deriveAesKeyFromPrivateKey,
  deriveKeyFromPasswordAndSalt,
  deriveKeyWithHkdf,
  importAesKey,
} from './aes-gcm'

const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i)
const PLAINTEXT = new TextEncoder().encode('hello, private feed')
const AAD = new TextEncoder().encode('yappr/test/v1')

describe('AES-GCM with IV prefix', () => {
  it('round-trips plaintext with a 12-byte IV prefix', async () => {
    const key = await deriveAesKeyFromPrivateKey(PRIVATE_KEY)
    const sealed = await aesGcmEncrypt(key, PLAINTEXT)
    expect(sealed.length).toBe(AES_GCM_IV_LENGTH + PLAINTEXT.length + 16)
    expect(await aesGcmDecrypt(key, sealed)).toEqual(PLAINTEXT)
  })

  it('produces a fresh IV per call', async () => {
    const key = await deriveAesKeyFromPrivateKey(PRIVATE_KEY)
    const a = await aesGcmEncrypt(key, PLAINTEXT)
    const b = await aesGcmEncrypt(key, PLAINTEXT)
    expect(a.slice(0, AES_GCM_IV_LENGTH)).not.toEqual(b.slice(0, AES_GCM_IV_LENGTH))
  })

  it('fails authentication on a tampered byte', async () => {
    const key = await deriveAesKeyFromPrivateKey(PRIVATE_KEY)
    const sealed = await aesGcmEncrypt(key, PLAINTEXT)
    sealed[sealed.length - 1] ^= 0x01
    await expect(aesGcmDecrypt(key, sealed)).rejects.toThrow()
  })

  it('fails with a different key', async () => {
    const key = await deriveAesKeyFromPrivateKey(PRIVATE_KEY)
    const other = await deriveAesKeyFromPrivateKey(PRIVATE_KEY.map((b) => b ^ 0xff))
    const sealed = await aesGcmEncrypt(key, PLAINTEXT)
    await expect(aesGcmDecrypt(other, sealed)).rejects.toThrow()
  })
})

describe('AES-GCM with separate IV and AAD', () => {
  it('round-trips and binds the AAD into the tag', async () => {
    const key = await importAesKey(PRIVATE_KEY)
    const { ciphertext, iv } = await aesGcmSeal(key, PLAINTEXT, { aad: AAD })
    expect(iv.length).toBe(AES_GCM_IV_LENGTH)
    expect(await aesGcmOpen(key, ciphertext, iv, AAD)).toEqual(PLAINTEXT)
    await expect(aesGcmOpen(key, ciphertext, iv)).rejects.toThrow()
    await expect(aesGcmOpen(key, ciphertext, iv, new Uint8Array([1]))).rejects.toThrow()
  })

  it('uses a caller-supplied IV verbatim', async () => {
    const key = await importAesKey(PRIVATE_KEY)
    const iv = Uint8Array.from({ length: AES_GCM_IV_LENGTH }, (_, i) => 100 + i)
    const sealed = await aesGcmSeal(key, PLAINTEXT, { iv })
    expect(sealed.iv).toBe(iv)
    expect(await aesGcmOpen(key, sealed.ciphertext, iv)).toEqual(PLAINTEXT)
  })

  it('is wire-compatible with the IV-prefixed form', async () => {
    const key = await importAesKey(PRIVATE_KEY)
    const prefixed = await aesGcmEncrypt(key, PLAINTEXT)
    expect(await aesGcmOpen(key, prefixed.slice(AES_GCM_IV_LENGTH), prefixed.slice(0, AES_GCM_IV_LENGTH))).toEqual(PLAINTEXT)
  })
})

describe('key derivation', () => {
  it('derives the same AES key from the same private key', async () => {
    const [a, b] = await Promise.all([deriveAesKeyFromPrivateKey(PRIVATE_KEY), deriveAesKeyFromPrivateKey(PRIVATE_KEY)])
    const sealed = await aesGcmEncrypt(a, PLAINTEXT)
    expect(await aesGcmDecrypt(b, sealed)).toEqual(PLAINTEXT)
  })

  it('HKDF is deterministic in ikm, salt and info', async () => {
    const salt = new TextEncoder().encode('salt')
    const info = new TextEncoder().encode('info')
    const a = await deriveKeyWithHkdf(PRIVATE_KEY, salt, info)
    const b = await deriveKeyWithHkdf(PRIVATE_KEY, salt, info)
    const c = await deriveKeyWithHkdf(PRIVATE_KEY, salt, new TextEncoder().encode('other'))
    const sealed = await aesGcmEncrypt(a, PLAINTEXT)
    expect(await aesGcmDecrypt(b, sealed)).toEqual(PLAINTEXT)
    await expect(aesGcmDecrypt(c, sealed)).rejects.toThrow()
  })

  it('rejects PBKDF2 iteration counts outside the allowed range', async () => {
    const salt = new Uint8Array(16)
    await expect(deriveKeyFromPasswordAndSalt('pw', salt, MIN_KDF_ITERATIONS - 1)).rejects.toThrow('Iterations')
    await expect(deriveKeyFromPasswordAndSalt('pw', salt, MAX_KDF_ITERATIONS + 1)).rejects.toThrow('Iterations')
  })
})
