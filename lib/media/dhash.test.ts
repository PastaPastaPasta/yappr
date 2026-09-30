import { describe, expect, it } from 'vitest'
import { DHASH_COLUMNS, DHASH_ROWS, dHashFromImageData, dHashFromLuma } from './dhash'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const grid = (at: (i: number) => number) => Array.from({ length: DHASH_COLUMNS * DHASH_ROWS }, (_, i) => at(i))

/** A 9x8 RGBA image whose every pixel is the gray `level(i)`. */
function grayImage(level: (i: number) => number) {
  const data = new Uint8ClampedArray(DHASH_COLUMNS * DHASH_ROWS * 4)
  for (let i = 0; i < DHASH_COLUMNS * DHASH_ROWS; i++) {
    data.set([level(i), level(i), level(i), 255], i * 4)
  }
  return { width: DHASH_COLUMNS, height: DHASH_ROWS, data }
}

// The same vectors `run-seeder.mjs --self-test` pins for scripts/seed/media-hash.mjs.
describe('dHash (docs/SOCIAL_V10.md, pinned)', () => {
  it('sets every bit for a left-to-right ramp and none for a flat or falling grid', () => {
    expect(hex(dHashFromLuma(grid((i) => i % 9)))).toBe('ffffffffffffffff')
    expect(hex(dHashFromLuma(grid(() => 7)))).toBe('0000000000000000')
    expect(hex(dHashFromLuma(grid((i) => 9 - (i % 9))))).toBe('0000000000000000')
  })

  it('packs row r into byte r, its first pair the most significant bit', () => {
    expect(hex(dHashFromLuma(grid((i) => (i === 1 ? 1 : 0))))).toBe('8000000000000000')
    expect(hex(dHashFromLuma(grid((i) => (i === 7 * 9 + 8 ? 1 : 0))))).toBe('0000000000000001')
  })

  it('refuses a grid of the wrong size', () => {
    expect(() => dHashFromLuma(new Array(64).fill(0))).toThrow(/9x8/)
  })

  it('hashes RGBA image data by BT.601 luma, ignoring alpha', () => {
    expect(hex(dHashFromImageData(grayImage((i) => (i % 9) * 20)))).toBe('ffffffffffffffff')
    // Pure green is brighter than pure red under BT.601 (0.587 > 0.299).
    const data = new Uint8ClampedArray(DHASH_COLUMNS * DHASH_ROWS * 4)
    for (let i = 0; i < DHASH_COLUMNS * DHASH_ROWS; i++) {
      data.set(i % 9 === 1 ? [0, 255, 0, 0] : [255, 0, 0, 255], i * 4)
    }
    expect(hex(dHashFromImageData({ width: DHASH_COLUMNS, height: DHASH_ROWS, data }))).toBe('8080808080808080')
  })

  it('refuses image data that was not resized to 9x8', () => {
    expect(() => dHashFromImageData({ width: 8, height: 8, data: new Uint8ClampedArray(256) })).toThrow(/9x8 image/)
  })
})
