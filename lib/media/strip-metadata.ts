/**
 * Removes metadata (Exif, GPS, XMP, IPTC, comments, text chunks, embedded
 * thumbnails, trailing data) from an encoded image without re-encoding it, so
 * quality and animation are untouched and the output is a pure function of the
 * input: stripping already-stripped bytes returns the same bytes, which keeps
 * a digest taken before upload equal to the uploaded content.
 *
 * Each format keeps only what is needed to draw the picture as the author saw
 * it (colour profiles, transparency, animation, JPEG orientation) and drops
 * everything else, including chunks it does not recognise. Bytes that cannot be
 * parsed throw rather than pass through.
 */

export type StrippableImageFormat = 'jpeg' | 'png' | 'webp' | 'gif'

export type ImageMetadataErrorReason = 'unsupported' | 'corrupt'

const MESSAGES: Record<ImageMetadataErrorReason, string> = {
  unsupported: 'This image type isn’t supported. Try a JPEG, PNG, WebP or GIF.',
  corrupt: 'This image couldn’t be read. It may be damaged, so try another file.',
}

/** Why an image could not be cleaned; `message` is fit to show the user. */
export class ImageMetadataError extends Error {
  readonly reason: ImageMetadataErrorReason

  constructor(reason: ImageMetadataErrorReason) {
    super(MESSAGES[reason])
    this.name = 'ImageMetadataError'
    this.reason = reason
  }
}

/** The MIME type each strippable format is uploaded as. */
export const STRIPPABLE_MIME_TYPES: Record<StrippableImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The format of an encoded image, sniffed from its bytes; null when it is none of the strippable ones. */
export function detectImageFormat(bytes: Uint8Array): StrippableImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp'
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'gif'
  return null
}

/**
 * The image with its metadata removed. The format is sniffed from the bytes,
 * not taken from a file name or MIME type. Throws ImageMetadataError for a
 * format it cannot clean (`unsupported`) or bytes it cannot parse (`corrupt`).
 */
export function stripImageMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const format = detectImageFormat(bytes)
  switch (format) {
    case 'jpeg':
      return stripJpeg(bytes)
    case 'png':
      return stripPng(bytes)
    case 'webp':
      return stripWebp(bytes)
    case 'gif':
      return stripGif(bytes)
    case null:
      throw new ImageMetadataError('unsupported')
  }
}

// --- shared helpers ---------------------------------------------------------

function corrupt(): never {
  throw new ImageMetadataError('corrupt')
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false
  return prefix.every((value, i) => bytes[at + i] === value)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = ''
  for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

function asciiBytes(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0))
}

function readU16BE(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1]
}

function readU32BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}

function readU32LE(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
}

/** Accumulates output slices and joins them once. */
class ByteSink {
  private readonly parts: Uint8Array[] = []
  private length = 0

  push(part: Uint8Array | readonly number[]): void {
    const bytes = part instanceof Uint8Array ? part : Uint8Array.from(part)
    this.parts.push(bytes)
    this.length += bytes.length
  }

  bytes(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const part of this.parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }
}

// --- JPEG -------------------------------------------------------------------

const SOI = 0xd8
const EOI = 0xd9
const SOS = 0xda
const APP0 = 0xe0
const APP1 = 0xe1
const APP2 = 0xe2
const APP14 = 0xee
const COM = 0xfe
const EXIF_HEADER = [...asciiBytes('Exif'), 0, 0]
const JFIF_HEADER = [...asciiBytes('JFIF'), 0]
const ICC_HEADER = [...asciiBytes('ICC_PROFILE'), 0]
const ADOBE_HEADER = asciiBytes('Adobe')
const ORIENTATION_TAG = 0x0112

/** Markers with no length field: TEM, RST0-7, SOI, EOI. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)
}

/**
 * Keeps the coding segments (tables, frame and scan headers, restart
 * intervals), a JFIF header without its thumbnail, ICC profiles (APP2) and the
 * Adobe colour-transform marker (APP14, needed to decode CMYK/YCCK). Drops
 * every other APPn (Exif, XMP, IPTC, MPF, maker data) and comments, plus
 * anything after EOI (motion-photo videos, MPF secondary images, vendor
 * trailers). The entropy-coded data of every scan is copied verbatim. An Exif
 * orientation other than 1 is re-emitted as an Exif segment holding that one
 * tag, so photos still display upright.
 */
function stripJpeg(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const kept: Uint8Array[] = []
  let orientation = 1
  let sawExif = false
  let firstKeptIsJfif = false
  let sawScan = false
  let pos = 2

  for (;;) {
    // Decoders skip stray bytes between segments (with a warning); they are dropped here too.
    while (pos < bytes.length && bytes[pos] !== 0xff) pos++
    // Fill bytes: any number of 0xFF may precede a marker.
    while (pos < bytes.length && bytes[pos] === 0xff) pos++
    if (pos >= bytes.length) corrupt()
    const marker = bytes[pos]
    const markerStart = pos - 1
    pos++
    if (marker === 0x00 || marker === SOI) corrupt()

    if (marker === EOI) {
      kept.push(Uint8Array.of(0xff, EOI))
      break
    }
    if (isStandaloneMarker(marker)) {
      kept.push(Uint8Array.of(0xff, marker))
      continue
    }

    if (pos + 2 > bytes.length) corrupt()
    const length = readU16BE(bytes, pos)
    if (length < 2 || pos + length > bytes.length) corrupt()
    const payloadStart = pos + 2
    const payloadEnd = pos + length
    const payload = bytes.subarray(payloadStart, payloadEnd)
    pos = payloadEnd

    if (marker === SOS) {
      sawScan = true
      kept.push(bytes.subarray(markerStart, payloadEnd))
      const scanEnd = findScanEnd(bytes, pos)
      kept.push(bytes.subarray(pos, scanEnd))
      pos = scanEnd
      // A file cut off inside its last scan still decodes up to the cut; keep it as is.
      if (pos >= bytes.length) break
      continue
    }

    if (marker === APP0) {
      const jfif = jfifWithoutThumbnail(payload)
      if (jfif) {
        if (kept.length === 0) firstKeptIsJfif = true
        kept.push(jfif)
      }
      continue
    }
    if (marker === APP1) {
      if (!sawExif && startsWith(payload, EXIF_HEADER)) {
        sawExif = true
        orientation = readExifOrientation(payload.subarray(EXIF_HEADER.length))
      }
      continue
    }
    if (marker === APP2) {
      if (startsWith(payload, ICC_HEADER)) kept.push(bytes.subarray(markerStart, payloadEnd))
      continue
    }
    if (marker === APP14) {
      if (startsWith(payload, ADOBE_HEADER)) kept.push(bytes.subarray(markerStart, payloadEnd))
      continue
    }
    if ((marker > APP2 && marker <= 0xef) || marker === COM) continue

    kept.push(bytes.subarray(markerStart, payloadEnd))
  }

  if (!sawScan) corrupt()
  // The orientation segment goes where Exif belongs: straight after SOI, or
  // after a leading JFIF header (which must itself come first).
  if (orientation !== 1) kept.splice(firstKeptIsJfif ? 1 : 0, 0, exifOrientationSegment(orientation))
  const out = new ByteSink()
  out.push([0xff, SOI])
  kept.forEach((segment) => out.push(segment))
  return out.bytes()
}

/**
 * The end of a scan's entropy-coded data starting at `pos`: the first 0xFF
 * that begins a real marker, i.e. is not a stuffed 0xFF00 or a restart marker.
 */
function findScanEnd(bytes: Uint8Array, pos: number): number {
  let i = pos
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    let next = i + 1
    while (next < bytes.length && bytes[next] === 0xff) next++
    if (next >= bytes.length) return bytes.length
    const marker = bytes[next]
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      i = next + 1
      continue
    }
    return i
  }
  return bytes.length
}

/** The JFIF APP0 segment rewritten with no thumbnail, or null when `payload` is not JFIF. */
function jfifWithoutThumbnail(payload: Uint8Array): Uint8Array | null {
  // "JFIF\0", version (2), units (1), X/Y density (2+2), thumbnail width/height (1+1).
  if (!startsWith(payload, JFIF_HEADER) || payload.length < 14) return null
  const segment = new Uint8Array(18)
  segment.set([0xff, APP0, 0x00, 16])
  segment.set(payload.subarray(0, 12), 4)
  // Thumbnail width and height stay 0: an embedded thumbnail can show the uncropped original.
  return segment
}

/** Orientation (1-8) from an Exif TIFF block; 1 when absent or unreadable. */
function readExifOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1
  const order = ascii(tiff, 0, 2)
  if (order !== 'II' && order !== 'MM') return 1
  const little = order === 'II'
  const u16 = (at: number) => (little ? tiff[at] | (tiff[at + 1] << 8) : readU16BE(tiff, at))
  const u32 = (at: number) => (little ? readU32LE(tiff, at) : readU32BE(tiff, at))
  if (u16(2) !== 42) return 1
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > tiff.length) return 1
    if (u16(entry) !== ORIENTATION_TAG) continue
    // SHORT, one value, stored in the first two bytes of the value field.
    if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) return 1
    const value = u16(entry + 8)
    return value >= 1 && value <= 8 ? value : 1
  }
  return 1
}

/** A big-endian TIFF (Exif) block whose IFD0 holds only the Orientation tag. */
function orientationTiff(orientation: number): number[] {
  return [
    // TIFF header: big-endian, magic 42, IFD0 at offset 8.
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    // One entry: Orientation, SHORT, count 1, value.
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    // No next IFD.
    0x00, 0x00, 0x00, 0x00,
  ]
}

/** A big-endian Exif APP1 segment whose IFD0 holds only the Orientation tag. */
function exifOrientationSegment(orientation: number): Uint8Array {
  return Uint8Array.from([0xff, APP1, 0x00, 34, ...EXIF_HEADER, ...orientationTiff(orientation)])
}

/** Orientation from a PNG eXIf or WebP EXIF payload: raw TIFF, or (as some writers do) prefixed `Exif\0\0`. */
function payloadOrientation(payload: Uint8Array): number {
  return readExifOrientation(startsWith(payload, EXIF_HEADER) ? payload.subarray(EXIF_HEADER.length) : payload)
}

// --- PNG --------------------------------------------------------------------

/**
 * Ancillary chunks that only affect how the picture is drawn: colour
 * management, transparency, physical size, significant bits, background,
 * palette histograms and APNG animation. Every other ancillary chunk (eXIf,
 * tEXt, zTXt, iTXt, tIME and anything unrecognised) is dropped. Critical chunks
 * are always kept, since the image cannot be decoded without them.
 */
const PNG_KEPT_ANCILLARY = new Set([
  'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI',
  'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT',
])

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

/** A PNG chunk: length, type, data and CRC-32 over type and data. */
function pngChunk(type: string, data: number[]): number[] {
  const typeAndData = [...asciiBytes(type), ...data]
  let crc = 0xffffffff
  for (const byte of typeAndData) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  crc = (crc ^ 0xffffffff) >>> 0
  const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
  return [...u32(data.length), ...typeAndData, ...u32(crc)]
}

function stripPng(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new ByteSink()
  out.push(bytes.subarray(0, PNG_SIGNATURE.length))
  let pos = PNG_SIGNATURE.length
  let first = true
  let sawExif = false

  for (;;) {
    if (pos + 12 > bytes.length) corrupt()
    const length = readU32BE(bytes, pos)
    const type = ascii(bytes, pos + 4, 4)
    const end = pos + 12 + length
    if (!/^[A-Za-z]{4}$/.test(type) || end > bytes.length) corrupt()
    if (first && type !== 'IHDR') corrupt()
    first = false

    const critical = type.charCodeAt(0) < 0x61
    if (critical || PNG_KEPT_ANCILLARY.has(type)) out.push(bytes.subarray(pos, end))
    else if (type === 'eXIf' && !sawExif) {
      // Keep only the orientation, where the eXIf was (before IDAT), so the picture still shows upright.
      sawExif = true
      const orientation = payloadOrientation(bytes.subarray(pos + 8, pos + 8 + length))
      if (orientation !== 1) out.push(pngChunk('eXIf', orientationTiff(orientation)))
    }
    pos = end
    // Anything after IEND is not part of the image.
    if (type === 'IEND') break
  }
  return out.bytes()
}

// --- WebP -------------------------------------------------------------------

/** Chunks that make up the picture; EXIF, XMP and unknown chunks are dropped. */
const WEBP_KEPT_CHUNKS = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP'])
const VP8X_EXIF_FLAG = 0x08
const VP8X_XMP_FLAG = 0x04

function stripWebp(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const riffEnd = 8 + readU32LE(bytes, 4)
  if (riffEnd > bytes.length || riffEnd < 12) corrupt()
  const chunks: Uint8Array[] = []
  let pos = 12
  let vp8x: Uint8Array | null = null
  let orientation: number | null = null

  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) corrupt()
    const fourcc = ascii(bytes, pos, 4)
    const size = readU32LE(bytes, pos + 4)
    const end = pos + 8 + size + (size & 1)
    // The pad byte of an odd-sized final chunk is sometimes missing; accept the unpadded end.
    if (pos + 8 + size > riffEnd) corrupt()
    const chunkEnd = Math.min(end, riffEnd)
    if (WEBP_KEPT_CHUNKS.has(fourcc)) {
      const chunk = new Uint8Array(8 + size + (size & 1))
      chunk.set(bytes.subarray(pos, chunkEnd))
      if (fourcc === 'VP8X') {
        if (size < 10) corrupt()
        chunk[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG)
        vp8x = chunk
      }
      chunks.push(chunk)
    } else if (fourcc === 'EXIF' && orientation === null) {
      orientation = payloadOrientation(bytes.subarray(pos + 8, pos + 8 + size))
    }
    pos = chunkEnd
  }
  if (chunks.length === 0) corrupt()
  // Keep only the orientation (an extended WebP's EXIF chunk goes last), so the picture still shows upright.
  if (vp8x && orientation !== null && orientation !== 1) {
    const tiff = orientationTiff(orientation)
    chunks.push(Uint8Array.from([...asciiBytes('EXIF'), tiff.length, 0, 0, 0, ...tiff]))
    vp8x[8] |= VP8X_EXIF_FLAG
  }

  const body = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const riffSize = 4 + body
  const out = new ByteSink()
  out.push([
    ...asciiBytes('RIFF'),
    riffSize & 0xff, (riffSize >>> 8) & 0xff, (riffSize >>> 16) & 0xff, (riffSize >>> 24) & 0xff,
    ...asciiBytes('WEBP'),
  ])
  chunks.forEach((chunk) => out.push(chunk))
  return out.bytes()
}

// --- GIF --------------------------------------------------------------------

/** Application extensions that change how the image plays or looks: looping and an ICC profile. */
const GIF_KEPT_APPLICATIONS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012'])
const GIF_EXTENSION = 0x21
const GIF_IMAGE = 0x2c
const GIF_TRAILER = 0x3b
const GIF_GRAPHIC_CONTROL = 0xf9
const GIF_PLAIN_TEXT = 0x01
const GIF_APPLICATION = 0xff

/** The end of a chain of data sub-blocks starting at `pos` (just past its 0 terminator). */
function skipSubBlocks(bytes: Uint8Array, pos: number): number {
  let i = pos
  for (;;) {
    if (i >= bytes.length) corrupt()
    const size = bytes[i]
    i += 1 + size
    if (size === 0) return i
  }
}

/**
 * Keeps the header, colour tables, images, graphic control and plain-text
 * extensions, and the looping/ICC application extensions. Drops comments, XMP
 * and every other application extension, and anything after the trailer.
 */
function stripGif(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.length < 13) corrupt()
  const screenFlags = bytes[10]
  let pos = 13 + (screenFlags & 0x80 ? 3 * (1 << ((screenFlags & 0x07) + 1)) : 0)
  if (pos > bytes.length) corrupt()
  const out = new ByteSink()
  out.push(bytes.subarray(0, pos))

  let sawImage = false
  for (;;) {
    // Encoders that stop before the trailer are common and browsers show their
    // images, so the end of the file closes it once there is an image.
    if (pos >= bytes.length && !sawImage) corrupt()
    const introducer = pos < bytes.length ? bytes[pos] : GIF_TRAILER
    if (introducer === GIF_TRAILER) {
      out.push([GIF_TRAILER])
      break
    }
    if (introducer === GIF_IMAGE) {
      if (pos + 10 > bytes.length) corrupt()
      const flags = bytes[pos + 9]
      const dataStart = pos + 10 + (flags & 0x80 ? 3 * (1 << ((flags & 0x07) + 1)) : 0)
      // LZW minimum code size, then the image data sub-blocks.
      const end = skipSubBlocks(bytes, dataStart + 1)
      out.push(bytes.subarray(pos, end))
      pos = end
      sawImage = true
      continue
    }
    if (introducer !== GIF_EXTENSION || pos + 2 > bytes.length) corrupt()
    const label = bytes[pos + 1]
    const end = skipSubBlocks(bytes, pos + 2)
    const keep =
      label === GIF_GRAPHIC_CONTROL ||
      label === GIF_PLAIN_TEXT ||
      (label === GIF_APPLICATION && bytes[pos + 2] === 11 && GIF_KEPT_APPLICATIONS.has(ascii(bytes, pos + 3, 11)))
    if (keep) out.push(bytes.subarray(pos, end))
    pos = end
  }
  return out.bytes()
}
