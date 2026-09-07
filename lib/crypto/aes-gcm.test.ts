import { describe, expect, it } from 'vitest'
import { aesGcmDecrypt, aesGcmEncrypt, deriveAesKeyFromPrivateKey, deriveKeyFromPasswordAndSalt } from './aes-gcm'
import { MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS } from '../onchain-key-encryption'

const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i)
const PLAINTEXT = new TextEncoder().encode('hello, private feed')

describe('AES-GCM helpers', () => {
  it('round-trips plaintext with a 12-byte IV prefix', async () => {
    const key = await deriveAesKeyFromPrivateKey(PRIVATE_KEY)
    const sealed = await aesGcmEncrypt(key, PLAINTEXT)
    expect(sealed.length).toBe(12 + PLAINTEXT.length + 16)
    expect(await aesGcmDecrypt(key, sealed)).toEqual(PLAINTEXT)
  })

  it('produces a fresh IV per call', async () => {
    const key = await deriveAesKeyFromPrivateKey(PRIVATE_KEY)
    const a = await aesGcmEncrypt(key, PLAINTEXT)
    const b = await aesGcmEncrypt(key, PLAINTEXT)
    expect(a.slice(0, 12)).not.toEqual(b.slice(0, 12))
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

  it('derives the same key from the same private key', async () => {
    const [a, b] = await Promise.all([
      deriveAesKeyFromPrivateKey(PRIVATE_KEY),
      deriveAesKeyFromPrivateKey(PRIVATE_KEY),
    ])
    const sealed = await aesGcmEncrypt(a, PLAINTEXT)
    expect(await aesGcmDecrypt(b, sealed)).toEqual(PLAINTEXT)
  })

  it('rejects PBKDF2 iteration counts outside the allowed range', async () => {
    const salt = new Uint8Array(16)
    await expect(deriveKeyFromPasswordAndSalt('pw', salt, MIN_KDF_ITERATIONS - 1)).rejects.toThrow('Iterations')
    await expect(deriveKeyFromPasswordAndSalt('pw', salt, MAX_KDF_ITERATIONS + 1)).rejects.toThrow('Iterations')
  })
})
