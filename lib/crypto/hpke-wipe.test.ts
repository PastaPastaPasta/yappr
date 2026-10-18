/**
 * LabeledExtract copies its input keying material (the DH output, the KEM's
 * shared secret, DeriveKeyPair's seed) into one labeled buffer: every such
 * buffer must be zero once a seal or an open returns. The concatenation is
 * observed, the HPKE itself is the real one.
 */
import { describe, expect, it, vi } from 'vitest'

/** Every labeled buffer, told apart when it is made (once wiped, its label is gone too). */
const made = vi.hoisted(() => [] as Uint8Array[])
const LABEL = vi.hoisted(() => new TextEncoder().encode('HPKE-v1'))

vi.mock('@/lib/bytes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bytes')>()
  return {
    ...actual,
    concatBytes: (...parts: Uint8Array[]) => {
      const out = actual.concatBytes(...parts)
      if (out.length > LABEL.length && LABEL.every((byte, index) => out[index] === byte)) made.push(out)
      return out
    },
  }
})

import { deriveKeyPair, openBase, sealBase } from './hpke'

describe('HPKE wipes the labeled copies of its secrets', () => {
  it('on a seal and an open', () => {
    const recipient = deriveKeyPair(new Uint8Array(32).fill(3))
    const info = new Uint8Array([1])
    const aad = new Uint8Array([2])
    made.length = 0
    const sealed = sealBase(recipient.publicKey, info, aad, new Uint8Array([7, 7, 7]))
    expect(Array.from(openBase(sealed.enc, recipient.privateKey, info, aad, sealed.ciphertext))).toEqual([7, 7, 7])

    // Some of them do hold a secret (the eae_prk and secret extracts), and all of them are wiped.
    expect(made.length).toBeGreaterThan(0)
    for (const bytes of made) expect(bytes.every((byte) => byte === 0)).toBe(true)
  })
})
