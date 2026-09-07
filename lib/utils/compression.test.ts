import { describe, expect, it } from 'vitest'
import { compressContent, decompressContent, getCompressedSize, joinChunks, splitIntoChunks } from './compression'

describe('compression', () => {
  it('round-trips JSON content', () => {
    const doc = { blocks: [{ type: 'paragraph', text: 'x'.repeat(2000) }], n: 1 }
    const packed = compressContent(doc)
    expect(packed.byteLength).toBeLessThan(JSON.stringify(doc).length)
    expect(decompressContent(packed)).toEqual(doc)
    expect(getCompressedSize(doc)).toBe(packed.byteLength)
  })

  it('returns null for corrupt input instead of throwing', () => {
    expect(decompressContent(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('throws on unserializable input', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => compressContent(cyclic)).toThrow('Failed to compress')
  })
})

describe('chunking', () => {
  const data = Uint8Array.from({ length: 10 }, (_, i) => i)

  it('splits into fixed-size chunks with a short tail', () => {
    const chunks = splitIntoChunks(data, 4)
    expect(chunks.map((c) => Array.from(c))).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]])
  })

  it('joins chunks back into the original', () => {
    expect(joinChunks(splitIntoChunks(data, 3))).toEqual(data)
  })

  it('stops at the first missing chunk', () => {
    const [a, , c] = splitIntoChunks(data, 4)
    expect(Array.from(joinChunks([a, null, c]))).toEqual([0, 1, 2, 3])
    expect(Array.from(joinChunks([a, new Uint8Array(0), c]))).toEqual([0, 1, 2, 3])
  })

  it('handles empty and single-chunk input', () => {
    expect(joinChunks([]).byteLength).toBe(0)
    expect(joinChunks([undefined])).toEqual(new Uint8Array(0))
    expect(joinChunks([data])).toBe(data)
  })
})
