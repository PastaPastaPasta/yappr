/**
 * The 64-bit difference hash ("dHash") v10 posts and replies store beside
 * `mediaUrl` as `mediaFingerprint` (8 bytes). It survives re-encoding and
 * resizing, so a reader can tell "the gateway served a different picture"
 * from "the gateway served the same picture, re-compressed".
 *
 * The algorithm is pinned here, because a fingerprint written by one client is
 * compared by every other:
 *
 * 1. **Grayscale.** Each pixel becomes its Rec. 601 luma,
 *    `0.299 R + 0.587 G + 0.114 B`, on the 0–255 scale. Alpha is ignored: the
 *    browser path composites the image over opaque white first.
 * 2. **Resize to 9 × 8** (9 columns, 8 rows) by box averaging: output cell
 *    `(cx, cy)` is the mean luma of source columns
 *    `[floor(cx·W/9), max(floor((cx+1)·W/9), start+1))` and the rows likewise
 *    over `H/8`, clamped to the image. An image narrower than 9 or shorter than
 *    8 pixels repeats edge pixels rather than failing.
 * 3. **Compare horizontally adjacent cells.** In each row, for `x = 0..7`, the
 *    bit is 1 when the RIGHT cell is strictly brighter (`Y[x+1] > Y[x]`). That
 *    is 8 bits per row and 64 in all.
 * 4. **Pack big-endian.** Bits are taken row by row, left to right. The first
 *    bit is the most significant bit of byte 0, and the 64th is the least
 *    significant bit of byte 7, so byte `r` is row `r`.
 *
 * Steps 3 and 4 are {@link dHashFromLuma}, which must agree bit for bit with
 * the seeder's `dHashFromLuma` (`scripts/seed/media-hash.mjs`) and with
 * docs/SOCIAL_V10.md; `dhash-vectors.json` pins both.
 *
 * Two fingerprints of the same picture differ in a few bits at most. More than
 * {@link MEDIA_CHANGED_DISTANCE} differing bits means the served image is not
 * the one that was posted.
 */

export const DHASH_BYTES = 8

/** The grid an image is reduced to: 9 columns by 8 rows. */
export const DHASH_COLUMNS = 9
export const DHASH_ROWS = 8

const GRID_WIDTH = DHASH_COLUMNS
const GRID_HEIGHT = DHASH_ROWS

/**
 * Hamming distances above this mean the image changed; 12 or less is "the
 * same image, re-encoded", as docs/SOCIAL_V10.md pins it for every client.
 * Measured there: the same picture at half size differs by 6 bits, a
 * different picture by 24 (32 is the expectation for unrelated hashes).
 */
export const MEDIA_CHANGED_DISTANCE = 12

/** The [start, end) source range box-averaged into output cell `cell` of `cells`. */
function cellRange(cell: number, cells: number, size: number): [number, number] {
  const start = Math.min(Math.floor((cell * size) / cells), size - 1)
  const end = Math.min(Math.max(Math.floor(((cell + 1) * size) / cells), start + 1), size)
  return [start, end]
}

/** For each source index, the output cells whose range covers it (several when the image is smaller than the grid). */
function cellsCovering(cells: number, size: number): number[][] {
  const covering: number[][] = Array.from({ length: size }, () => [])
  for (let cell = 0; cell < cells; cell++) {
    const [start, end] = cellRange(cell, cells, size)
    for (let i = start; i < end; i++) covering[i].push(cell)
  }
  return covering
}

/**
 * An incremental dHash over an image fed in horizontal bands, top to bottom,
 * so a large photo never has to be decoded into one full-size buffer. Feeding
 * the whole image as one band gives exactly {@link dHashFromRgba}.
 */
export interface DHashAccumulator {
  /** Add `rows` full-width RGBA rows starting at source row `y`. */
  addRows(rgba: Uint8ClampedArray | Uint8Array, y: number, rows: number): void
  /** The 8 big-endian bytes, once every row has been added. */
  digest(): Uint8Array
}

export function createDHashAccumulator(width: number, height: number): DHashAccumulator {
  if (width < 1 || height < 1) throw new Error(`dHash: invalid image size ${width}x${height}`)
  const rowCells = cellsCovering(GRID_HEIGHT, height)
  const colCells = cellsCovering(GRID_WIDTH, width)
  const sums = new Float64Array(GRID_WIDTH * GRID_HEIGHT)
  let rowsAdded = 0

  return {
    addRows(rgba, y, rows) {
      if (y !== rowsAdded || rows < 1 || y + rows > height || rgba.length < rows * width * 4) {
        throw new Error(`dHash: expected ${width}x${rows} RGBA rows at ${rowsAdded}, got ${rgba.length} bytes at ${y}`)
      }
      for (let r = 0; r < rows; r++) {
        const cys = rowCells[y + r]
        for (let x = 0; x < width; x++) {
          const i = (r * width + x) * 4
          const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
          for (const cy of cys) {
            for (const cx of colCells[x]) sums[cy * GRID_WIDTH + cx] += luma
          }
        }
      }
      rowsAdded += rows
    },
    digest() {
      if (rowsAdded !== height) throw new Error(`dHash: ${rowsAdded} of ${height} rows added`)
      const grid = new Float64Array(GRID_WIDTH * GRID_HEIGHT)
      for (let cy = 0; cy < GRID_HEIGHT; cy++) {
        const [y0, y1] = cellRange(cy, GRID_HEIGHT, height)
        for (let cx = 0; cx < GRID_WIDTH; cx++) {
          const [x0, x1] = cellRange(cx, GRID_WIDTH, width)
          grid[cy * GRID_WIDTH + cx] = sums[cy * GRID_WIDTH + cx] / ((y1 - y0) * (x1 - x0))
        }
      }
      return dHashFromLuma(grid)
    },
  }
}

/**
 * Steps 3 and 4 alone: the 8 big-endian bytes of a 9 × 8 luma grid (72 values,
 * row-major, top row first).
 */
export function dHashFromLuma(grid: ArrayLike<number>): Uint8Array {
  if (grid.length !== GRID_WIDTH * GRID_HEIGHT) {
    throw new Error(`dHash: needs a ${GRID_WIDTH}x${GRID_HEIGHT} luma grid, got ${grid.length} values`)
  }
  const hash = new Uint8Array(DHASH_BYTES)
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let x = 0; x < GRID_WIDTH - 1; x++) {
      const at = row * GRID_WIDTH + x
      if (grid[at + 1] > grid[at]) hash[row] |= 0x80 >> x
    }
  }
  return hash
}

/**
 * The dHash of an RGBA pixel buffer (`ImageData.data` layout: 4 bytes per
 * pixel, rows top to bottom), as 8 big-endian bytes.
 */
export function dHashFromRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  if (width < 1 || height < 1 || rgba.length < width * height * 4) {
    throw new Error(`dHash: ${width}x${height} needs ${width * height * 4} RGBA bytes, got ${rgba.length}`)
  }
  const accumulator = createDHashAccumulator(width, height)
  accumulator.addRows(rgba, 0, height)
  return accumulator.digest()
}

/**
 * The dHash of an image already resized to 9x8 (RGBA, as a canvas's
 * `getImageData` returns it), for callers that let the canvas do step 2, such
 * as the DashPay avatar digest (`image-digest.ts`). Alpha is ignored.
 */
export function dHashFromImageData(image: Pick<ImageData, 'width' | 'height' | 'data'>): Uint8Array {
  if (image.width !== DHASH_COLUMNS || image.height !== DHASH_ROWS) {
    throw new Error(`dHash needs a ${DHASH_COLUMNS}x${DHASH_ROWS} image, got ${image.width}x${image.height}`)
  }
  return dHashFromRgba(image.data, image.width, image.height)
}

/** The number of differing bits between two equal-length fingerprints. */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error(`hammingDistance: lengths differ (${a.length} vs ${b.length})`)
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i]
    while (x) {
      distance += x & 1
      x >>= 1
    }
  }
  return distance
}

/** True when the served image's fingerprint is too far from the posted one to be the same picture. */
export function mediaFingerprintChanged(posted: Uint8Array, served: Uint8Array): boolean {
  return hammingDistance(posted, served) > MEDIA_CHANGED_DISTANCE
}
