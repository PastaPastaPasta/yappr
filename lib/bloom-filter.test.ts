import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { BloomFilter, bloomFilterFromBase64, bloomFilterToBase64 } from './bloom-filter'

function identifier(seed: number): string {
  // Distinct 32-byte ids: the seed occupies the first four bytes so no two
  // seeds below 2^32 can collide, the rest is deterministic filler.
  const bytes = new Uint8Array(32)
  new DataView(bytes.buffer).setUint32(0, seed)
  for (let i = 4; i < 32; i++) bytes[i] = (seed + i * 17) & 0xff
  return bs58.encode(bytes)
}

describe('BloomFilter', () => {
  it('starts empty', () => {
    const filter = new BloomFilter()
    expect(filter.isEmpty()).toBe(true)
    expect(filter.itemCount).toBe(0)
    expect(filter.estimateFalsePositiveRate()).toBe(0)
  })

  it('never yields a false negative', () => {
    const filter = new BloomFilter()
    const ids = Array.from({ length: 500 }, (_, i) => identifier(i))
    for (const id of ids) filter.add(id)
    expect(filter.itemCount).toBe(500)
    for (const id of ids) expect(filter.mightContain(id)).toBe(true)
  })

  it('keeps the false positive rate low at the design load', () => {
    const filter = new BloomFilter()
    for (let i = 0; i < 1000; i++) filter.add(identifier(i))
    let hits = 0
    for (let i = 1000; i < 3000; i++) if (filter.mightContain(identifier(i))) hits++
    expect(hits / 2000).toBeLessThan(0.01)
    expect(filter.estimateFalsePositiveRate()).toBeLessThan(0.01)
  })

  it('accepts raw bytes and base58 interchangeably', () => {
    const filter = new BloomFilter()
    const id = identifier(42)
    filter.add(bs58.decode(id))
    expect(filter.mightContain(id)).toBe(true)
  })

  it('round-trips through serialize()', () => {
    const filter = new BloomFilter()
    filter.add(identifier(1))
    const copy = new BloomFilter(filter.serialize(), filter.itemCount)
    expect(copy.mightContain(identifier(1))).toBe(true)
    expect(copy.itemCount).toBe(1)
    expect(copy.serialize()).toEqual(filter.serialize())
  })

  it('round-trips through base64', () => {
    const filter = new BloomFilter()
    filter.add(identifier(7))
    const restored = bloomFilterFromBase64(bloomFilterToBase64(filter), 1)
    expect(restored.mightContain(identifier(7))).toBe(true)
    expect(restored.serialize()).toEqual(filter.serialize())
  })

  it('pads or truncates foreign data to the fixed size', () => {
    const short = new BloomFilter(new Uint8Array([0xff]))
    expect(short.serialize().length).toBe(BloomFilter.sizeBytes)
    const long = new BloomFilter(new Uint8Array(BloomFilter.sizeBytes + 10).fill(1))
    expect(long.serialize().length).toBe(BloomFilter.sizeBytes)
  })

  it('merges as a union', () => {
    const a = new BloomFilter()
    const b = new BloomFilter()
    a.add(identifier(1))
    b.add(identifier(2))
    const merged = BloomFilter.merge([a, b])
    expect(merged.mightContain(identifier(1))).toBe(true)
    expect(merged.mightContain(identifier(2))).toBe(true)
    expect(merged.itemCount).toBe(2)
    expect(a.mightContain(identifier(2))).toBe(false)
  })
})
