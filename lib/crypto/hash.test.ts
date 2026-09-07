import { describe, expect, it } from 'vitest'
import { hash160 } from './hash'
import { bytesToHex } from './wif'

describe('hash160', () => {
  it('matches the known RIPEMD160(SHA256()) vector for empty input', () => {
    expect(bytesToHex(hash160(new Uint8Array(0)))).toBe('b472a266d0bd89c13706a4132ccfb16f7c3b9fcb')
  })

  it('matches the known vector for a compressed secp256k1 generator point', () => {
    // 02 || Gx — the pubkey of private key 1. Its hash160 is the well-known
    // address payload 751e76e8199196d454941c45d1b3a323f1433bd6.
    const pubkey = Uint8Array.from(
      Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
    )
    expect(bytesToHex(hash160(pubkey))).toBe('751e76e8199196d454941c45d1b3a323f1433bd6')
  })
})
