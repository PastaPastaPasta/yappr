/**
 * The media hashes a v10 post or reply carries beside `mediaUrl`
 * (docs/SOCIAL_V10.md, "Media"): `mediaHash` is the sha256 of the exact bytes
 * at the URL, `mediaFingerprint` the 64-bit difference hash (dHash) of the
 * decoded image. Both are required whenever `mediaUrl` is set, and neither may
 * appear without it (dependentRequired, 10101). Social v13 (docs/SOCIAL_V13.md)
 * keeps both per item, concatenated as one 40-byte `mediaDigests` entry (sha256
 * then dHash) beside `mediaUrls` and `mediaKinds`; `SOCIAL_SHAPES.media`
 * (scripts/social-shapes.mjs) lays them out for the configured cut.
 *
 * The dHash is pinned here so the seeder, the batteries and the client
 * (`lib/media/dhash.ts`, a later PR) use the same parameters (resamplers differ
 * slightly between decoders, so fingerprints of the same image agree to within a
 * few bits, which the client's Hamming threshold absorbs; they are not
 * guaranteed identical):
 *
 *   1. decode the image (EXIF orientation applied) and resize it to exactly
 *      9 columns x 8 rows;
 *   2. convert each pixel to luma with BT.601: Y = 0.299 R + 0.587 G + 0.114 B;
 *   3. for each row, top to bottom, and each of its 8 adjacent pairs, left to
 *      right, the bit is 1 when the RIGHT pixel is brighter (Y[x+1] > Y[x]);
 *   4. pack the 64 bits row-major, most significant bit first: byte r is row r.
 *
 * `dHashFromLuma` is the pure part (a 72-entry luma grid in, 8 bytes out) and
 * is what `run-seeder.mjs --self-test` pins. Decoding an image in node needs a codec the repo
 * does not depend on, so `mediaFieldsFor` resizes with macOS `sips` when it is
 * present and otherwise derives a stable stand-in fingerprint from the sha256
 * (`decoded: false`). A stand-in is still 8 bytes, so it is valid on chain, but
 * the client's near-duplicate check cannot match it against the image: the
 * seeder counts stand-ins loudly and `--require-dhash` refuses them.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DHASH_COLUMNS = 9;
const DHASH_ROWS = 8;

/** BT.601 luma of one 8-bit RGB pixel. */
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** The 8-byte dHash of a 9x8 luma grid (row-major, 72 values). */
export function dHashFromLuma(grid) {
  if (grid.length !== DHASH_COLUMNS * DHASH_ROWS) throw new Error(`dHash needs a ${DHASH_COLUMNS}x${DHASH_ROWS} grid, got ${grid.length} values`);
  const out = new Uint8Array(DHASH_ROWS);
  for (let row = 0; row < DHASH_ROWS; row++) {
    let byte = 0;
    for (let x = 0; x < DHASH_COLUMNS - 1; x++) {
      const at = row * DHASH_COLUMNS + x;
      byte = (byte << 1) | (grid[at + 1] > grid[at] ? 1 : 0);
    }
    out[row] = byte;
  }
  return out;
}

/**
 * The luma grid of a 24-bit BMP of exactly 9x8 pixels (what `sips -z 8 9 -s
 * format bmp` writes: bottom-up rows padded to 4 bytes, BGR order unless the
 * height is negative, which sips uses for top-down).
 */
function lumaFromBmp9x8(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, false) !== 0x424d) throw new Error('not a BMP');
  const offset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const height = view.getInt32(22, true);
  const bits = view.getUint16(28, true);
  if (width !== DHASH_COLUMNS || Math.abs(height) !== DHASH_ROWS || (bits !== 24 && bits !== 32)) {
    throw new Error(`expected a ${DHASH_COLUMNS}x${DHASH_ROWS} 24/32-bit BMP, got ${width}x${height} at ${bits} bits`);
  }
  const bytesPerPixel = bits / 8;
  const stride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  const grid = new Array(DHASH_COLUMNS * DHASH_ROWS);
  for (let row = 0; row < DHASH_ROWS; row++) {
    const stored = height < 0 ? row : DHASH_ROWS - 1 - row;
    for (let x = 0; x < DHASH_COLUMNS; x++) {
      const at = offset + stored * stride + x * bytesPerPixel;
      grid[row * DHASH_COLUMNS + x] = luma(bytes[at + 2], bytes[at + 1], bytes[at]);
    }
  }
  return grid;
}

/** dHash of image bytes via macOS `sips`, or null when sips is unavailable or refuses the image. */
function dHashWithSips(imageBytes) {
  const dir = mkdtempSync(join(tmpdir(), 'yappr-dhash-'));
  try {
    const input = join(dir, 'in');
    const output = join(dir, 'out.bmp');
    writeFileSync(input, imageBytes);
    execFileSync('sips', ['-z', String(DHASH_ROWS), String(DHASH_COLUMNS), '-s', 'format', 'bmp', input, '--out', output], { stdio: 'ignore' });
    return dHashFromLuma(lumaFromBmp9x8(readFileSync(output)));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A stable 8-byte stand-in when the image cannot be decoded: the first 8 bytes of sha256("dhash-standin" || sha256). */
function standInFingerprint(sha256Bytes) {
  return new Uint8Array(createHash('sha256').update('dhash-standin').update(sha256Bytes).digest().subarray(0, 8));
}

/**
 * `{ mediaHash, mediaFingerprint, decoded }` for the bytes at `url`.
 * `fetchBytes(url)` is injectable for tests. A URL whose bytes change between
 * fetches (picsum seeds are stable; a CDN may not be) makes the stored hash
 * stale, which the client shows as "re-encoded" or a warning, never as a
 * refusal: consensus does not fetch the URL.
 */
export async function mediaFieldsFor(url, { fetchBytes = defaultFetch, log = () => {} } = {}) {
  const bytes = await fetchBytes(url);
  const mediaHash = new Uint8Array(createHash('sha256').update(bytes).digest());
  const decoded = dHashWithSips(bytes);
  if (!decoded) log(`media ${url}: no local image decoder (sips); using a stand-in fingerprint`);
  return { mediaHash, mediaFingerprint: decoded ?? standInFingerprint(mediaHash), decoded: decoded !== null };
}

async function defaultFetch(url) {
  if (url.startsWith('ipfs://')) url = `https://ipfs.io/ipfs/${url.slice('ipfs://'.length)}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
