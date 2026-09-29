/**
 * The 64-bit difference hash (dHash) that v10 stores beside an image URL:
 * DashPay's `avatarFingerprint` and the social contract's `mediaFingerprint`
 * (docs/SOCIAL_V10.md, "The media fingerprint (pinned)"). The seeder
 * (`scripts/seed/media-hash.mjs`) computes it the same way, bit for bit:
 *
 *   1. decode the image (EXIF orientation applied) and resize it to exactly
 *      9 columns x 8 rows;
 *   2. convert each pixel to luma with BT.601: Y = 0.299 R + 0.587 G + 0.114 B;
 *   3. for each row, top to bottom, and each of its 8 adjacent pairs, left to
 *      right, the bit is 1 when the RIGHT pixel is brighter (Y[x+1] > Y[x]);
 *   4. pack the 64 bits row-major, most significant bit first: byte r is row r.
 */

export const DHASH_COLUMNS = 9
export const DHASH_ROWS = 8

/** BT.601 luma of one 8-bit RGB pixel. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** The 8-byte dHash of a 9x8 luma grid (row-major, 72 values). */
export function dHashFromLuma(grid: ArrayLike<number>): Uint8Array {
  if (grid.length !== DHASH_COLUMNS * DHASH_ROWS) {
    throw new Error(`dHash needs a ${DHASH_COLUMNS}x${DHASH_ROWS} grid, got ${grid.length} values`)
  }
  const out = new Uint8Array(DHASH_ROWS)
  for (let row = 0; row < DHASH_ROWS; row++) {
    let byte = 0
    for (let x = 0; x < DHASH_COLUMNS - 1; x++) {
      const at = row * DHASH_COLUMNS + x
      byte = (byte << 1) | (grid[at + 1] > grid[at] ? 1 : 0)
    }
    out[row] = byte
  }
  return out
}

/**
 * The dHash of an image already resized to 9x8 (RGBA, as a canvas's
 * `getImageData` returns it). Alpha is ignored, as the seeder ignores it.
 */
export function dHashFromImageData(image: Pick<ImageData, 'width' | 'height' | 'data'>): Uint8Array {
  if (image.width !== DHASH_COLUMNS || image.height !== DHASH_ROWS) {
    throw new Error(`dHash needs a ${DHASH_COLUMNS}x${DHASH_ROWS} image, got ${image.width}x${image.height}`)
  }
  const grid = new Array<number>(DHASH_COLUMNS * DHASH_ROWS)
  for (let i = 0; i < grid.length; i++) {
    const at = i * 4
    grid[i] = luma(image.data[at], image.data[at + 1], image.data[at + 2])
  }
  return dHashFromLuma(grid)
}
