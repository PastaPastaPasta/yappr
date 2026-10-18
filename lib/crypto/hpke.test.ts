import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import { deriveKeyPair, openBase, sealBase } from './hpke'

/**
 * RFC 9180 Appendix A.2: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
 * ChaCha20Poly1305, base mode (A.2.1), sequence number 0.
 */
const A2 = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  ikmE: '909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b',
  pkEm: '1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a',
  skEm: 'f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600',
  ikmR: '1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df',
  pkRm: '4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a',
  skRm: '8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  aad: '436f756e742d30',
  ct: '1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28',
}

describe('HPKE (RFC 9180 A.2)', () => {
  it('derives the sender and recipient key pairs', () => {
    const e = deriveKeyPair(hexToBytes(A2.ikmE))
    const r = deriveKeyPair(hexToBytes(A2.ikmR))
    expect(bytesToHex(e.privateKey)).toBe(A2.skEm)
    expect(bytesToHex(e.publicKey)).toBe(A2.pkEm)
    expect(bytesToHex(r.privateKey)).toBe(A2.skRm)
    expect(bytesToHex(r.publicKey)).toBe(A2.pkRm)
  })

  it('seals sequence 0 to the RFC ciphertext', () => {
    const sealed = sealBase(hexToBytes(A2.pkRm), hexToBytes(A2.info), hexToBytes(A2.aad), hexToBytes(A2.pt), hexToBytes(A2.ikmE))
    expect(bytesToHex(sealed.enc)).toBe(A2.pkEm)
    expect(bytesToHex(sealed.ciphertext)).toBe(A2.ct)
  })

  it('opens the RFC ciphertext', () => {
    const opened = openBase(hexToBytes(A2.pkEm), hexToBytes(A2.skRm), hexToBytes(A2.info), hexToBytes(A2.aad), hexToBytes(A2.ct))
    expect(bytesToHex(opened)).toBe(A2.pt)
  })

  it('refuses a tampered ciphertext, aad or info', () => {
    const open = (over: { ct?: string; aad?: string; info?: string }) => openBase(
      hexToBytes(A2.pkEm), hexToBytes(A2.skRm), hexToBytes(over.info ?? A2.info), hexToBytes(over.aad ?? A2.aad), hexToBytes(over.ct ?? A2.ct),
    )
    expect(() => open({ ct: `${A2.ct.slice(0, -2)}29` })).toThrow()
    expect(() => open({ aad: '436f756e742d31' })).toThrow()
    expect(() => open({ info: `${A2.info}00` })).toThrow()
  })

  it('refuses a small-order public key (all-zero shared secret)', () => {
    const zeroPoint = new Uint8Array(32)
    // Either noble or the explicit check refuses it; it must never seal.
    expect(() => sealBase(zeroPoint, new Uint8Array(0), new Uint8Array(0), new Uint8Array(1))).toThrow()
  })

  it('draws a fresh ephemeral key per seal and leaves a supplied one alone', () => {
    const r = deriveKeyPair(hexToBytes(A2.ikmR))
    const a = sealBase(r.publicKey, new Uint8Array(0), new Uint8Array(0), new Uint8Array(16))
    const b = sealBase(r.publicKey, new Uint8Array(0), new Uint8Array(0), new Uint8Array(16))
    expect(bytesToHex(a.enc)).not.toBe(bytesToHex(b.enc))
    const ikm = hexToBytes(A2.ikmE)
    sealBase(r.publicKey, new Uint8Array(0), new Uint8Array(0), new Uint8Array(16), ikm)
    expect(bytesToHex(ikm)).toBe(A2.ikmE)
  })

  it('refuses key material shorter than 32 bytes', () => {
    expect(() => deriveKeyPair(new Uint8Array(31))).toThrow()
  })
})
