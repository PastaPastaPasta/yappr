import { describe, expect, it } from 'vitest'
import { dHashFromLuma as seederDHashFromLuma } from '../../scripts/seed/media-hash.mjs'
import { DHASH_BYTES, DHASH_COLUMNS, DHASH_ROWS, MEDIA_CHANGED_DISTANCE, createDHashAccumulator, dHashFromImageData, dHashFromLuma, dHashFromRgba, hammingDistance, mediaFingerprintChanged } from './dhash'
import pinned from './dhash-vectors.json'

/** An RGBA buffer whose pixel (x, y) is the gray level `shade(x, y)`. */
function grayImage(width: number, height: number, shade: (x: number, y: number) => number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const value = shade(x, y)
      rgba[i] = value
      rgba[i + 1] = value
      rgba[i + 2] = value
      rgba[i + 3] = 255
    }
  }
  return rgba
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

describe('dHashFromLuma (the pinned vectors)', () => {
  it.each(pinned.vectors)('$name → $dhash', ({ luma, dhash }) => {
    expect(hex(dHashFromLuma(luma))).toBe(dhash)
  })

  it.each(pinned.vectors)('the seeder agrees: $name', ({ luma, dhash }) => {
    expect(hex(seederDHashFromLuma(luma))).toBe(dhash)
  })

  it('agrees with the seeder on arbitrary grids, ties included', () => {
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 6
    for (let round = 0; round < 200; round++) {
      const grid = Array.from({ length: 72 }, () => next() * 50)
      expect(hex(dHashFromLuma(grid))).toBe(hex(seederDHashFromLuma(grid)))
    }
  })

  it('rejects a grid that is not 9x8', () => {
    expect(() => dHashFromLuma(new Array(71).fill(0))).toThrow(/9x8/)
  })
})

describe('dHashFromRgba', () => {
  it('produces 8 bytes', () => {
    expect(dHashFromRgba(grayImage(9, 8, () => 0), 9, 8)).toHaveLength(DHASH_BYTES)
  })

  it('sets every bit when brightness rises left to right, and none when it falls', () => {
    expect(hex(dHashFromRgba(grayImage(9, 8, (x) => x * 20), 9, 8))).toBe('ffffffffffffffff')
    expect(hex(dHashFromRgba(grayImage(9, 8, (x) => 255 - x * 20), 9, 8))).toBe('0000000000000000')
  })

  it('sets no bit on a flat image (strictly brighter only)', () => {
    expect(hex(dHashFromRgba(grayImage(64, 64, () => 128), 64, 64))).toBe('0000000000000000')
  })

  it('packs rows big-endian, first bit into the MSB of byte 0', () => {
    // Only row 0's cell 1 is brighter than its left neighbour.
    const rgba = grayImage(9, 8, (x, y) => (y === 0 && x === 1 ? 200 : 100))
    expect(hex(dHashFromRgba(rgba, 9, 8))).toBe('8000000000000000')
    // Only the last comparison of the last row (cell 8 vs 7 of row 7).
    const last = grayImage(9, 8, (x, y) => (y === 7 && x === 8 ? 200 : 100))
    expect(hex(dHashFromRgba(last, 9, 8))).toBe('0000000000000001')
  })

  it('uses Rec. 601 luma, so a green pixel outweighs a blue one', () => {
    const rgba = new Uint8ClampedArray(9 * 8 * 4)
    for (let p = 0; p < 72; p++) {
      const x = p % 9
      rgba[p * 4 + (x % 2 === 0 ? 1 : 2)] = 255 // even columns green, odd blue
      rgba[p * 4 + 3] = 255
    }
    // Each odd pair (blue 29.1 → green 149.7) rises; each even pair falls.
    expect(hex(dHashFromRgba(rgba, 9, 8))).toBe('5555555555555555')
  })

  it('box-averages larger images down to 9x8', () => {
    // A 90x80 left-to-right rising ramp in 10px steps hashes like the 9x8 one.
    const big = grayImage(90, 80, (x) => Math.floor(x / 10) * 20)
    expect(hex(dHashFromRgba(big, 90, 80))).toBe('ffffffffffffffff')
  })

  it('is stable under a small uniform brightness change', () => {
    const shade = (x: number, y: number) => ((x * 37 + y * 91) % 200) + 20
    const a = dHashFromRgba(grayImage(180, 160, shade), 180, 160)
    const b = dHashFromRgba(grayImage(180, 160, (x, y) => shade(x, y) + 10), 180, 160)
    expect(hammingDistance(a, b)).toBe(0)
  })

  it('handles images smaller than the grid by repeating edge pixels', () => {
    expect(dHashFromRgba(grayImage(1, 1, () => 50), 1, 1)).toEqual(new Uint8Array(8))
    expect(hex(dHashFromRgba(grayImage(3, 2, (x) => 200 - x * 50), 3, 2))).toMatch(/^[0-9a-f]{16}$/)
  })

  it('rejects a buffer too short for its dimensions', () => {
    expect(() => dHashFromRgba(new Uint8ClampedArray(10), 9, 8)).toThrow(/RGBA bytes/)
  })
})

describe('createDHashAccumulator', () => {
  it('gives the one-buffer hash when fed in bands, including bands straddling cells', () => {
    const width = 37
    const height = 29
    const shade = (x: number, y: number) => ((x * 53 + y * 17 + x * y) % 250)
    const whole = grayImage(width, height, shade)
    for (const band of [1, 3, 7, 29]) {
      const accumulator = createDHashAccumulator(width, height)
      for (let y = 0; y < height; y += band) {
        const rows = Math.min(band, height - y)
        accumulator.addRows(whole.subarray(y * width * 4, (y + rows) * width * 4), y, rows)
      }
      expect(hex(accumulator.digest())).toBe(hex(dHashFromRgba(whole, width, height)))
    }
  })

  it('refuses out-of-order bands and an early digest', () => {
    const accumulator = createDHashAccumulator(9, 8)
    expect(() => accumulator.addRows(new Uint8ClampedArray(9 * 4), 1, 1)).toThrow(/expected/)
    expect(() => accumulator.digest()).toThrow(/0 of 8 rows/)
  })
})

describe('hammingDistance and mediaFingerprintChanged', () => {
  const zero = new Uint8Array(8)
  const withBits = (count: number) => {
    const out = new Uint8Array(8)
    for (let i = 0; i < count; i++) out[i >> 3] |= 0x80 >> (i & 7)
    return out
  }

  it('counts differing bits', () => {
    expect(hammingDistance(zero, zero)).toBe(0)
    expect(hammingDistance(zero, withBits(1))).toBe(1)
    expect(hammingDistance(zero, new Uint8Array(8).fill(0xff))).toBe(64)
  })

  it('treats more than MEDIA_CHANGED_DISTANCE bits as a changed image', () => {
    expect(MEDIA_CHANGED_DISTANCE).toBe(10)
    expect(mediaFingerprintChanged(zero, withBits(10))).toBe(false)
    expect(mediaFingerprintChanged(zero, withBits(11))).toBe(true)
  })

  it('rejects fingerprints of different lengths', () => {
    expect(() => hammingDistance(zero, new Uint8Array(4))).toThrow(/lengths differ/)
  })
})

const grid = (at: (i: number) => number) => Array.from({ length: DHASH_COLUMNS * DHASH_ROWS }, (_, i) => at(i))

/** A 9x8 RGBA image whose every pixel is the gray `level(i)`. */
function grayImage9x8(level: (i: number) => number) {
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
    expect(hex(dHashFromImageData(grayImage9x8((i) => (i % 9) * 20)))).toBe('ffffffffffffffff')
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
