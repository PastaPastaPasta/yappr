import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ImageMetadataError, detectImageFormat, stripImageMetadata } from './strip-metadata'

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, '__fixtures__', name)))

/**
 * `plain.jpg` is a real 16x16 baseline JPEG from ffmpeg (JFIF + a COM). `gps.jpg`
 * is the same image with what a phone and an editor add: an Exif APP1 (little-
 * endian; Make, Orientation 6, DateTime and a GPS IFD with latitude and
 * longitude), an XMP APP1 repeating the location, an ICC APP2, an IPTC APP13, an
 * Adobe APP14, a location comment, and data after EOI.
 */
const PLAIN_JPEG = fixture('plain.jpg')
const GPS_JPEG = fixture('gps.jpg')
const PLAIN_WEBP = fixture('plain.webp')

const bytes = (...parts: Array<Uint8Array | number[] | string>): Uint8Array => {
  const arrays = parts.map((part) =>
    typeof part === 'string' ? new TextEncoder().encode(part) : part instanceof Uint8Array ? part : Uint8Array.from(part)
  )
  const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of arrays) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function indexOf(haystack: Uint8Array, needle: Uint8Array | string): number {
  const target = typeof needle === 'string' ? new TextEncoder().encode(needle) : needle
  outer: for (let i = 0; i + target.length <= haystack.length; i++) {
    for (let j = 0; j < target.length; j++) if (haystack[i + j] !== target[j]) continue outer
    return i
  }
  return -1
}

const u16be = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const u32be = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const u32le = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]

// --- JPEG -------------------------------------------------------------------

interface JpegSegment {
  marker: number
  payload: Uint8Array
}

/** The segments before the first SOS, and the offset of that SOS. */
function jpegHeader(jpeg: Uint8Array): { segments: JpegSegment[]; sos: number } {
  const segments: JpegSegment[] = []
  let pos = 2
  while (jpeg[pos + 1] !== 0xda) {
    const length = (jpeg[pos + 2] << 8) | jpeg[pos + 3]
    segments.push({ marker: jpeg[pos + 1], payload: jpeg.subarray(pos + 4, pos + 2 + length) })
    pos += 2 + length
  }
  return { segments, sos: pos }
}

/** Orientation from an Exif APP1 payload, as a viewer would read it. */
function exifOrientation(payload: Uint8Array): number | null {
  const tiff = payload.subarray(6)
  const little = tiff[0] === 0x49
  const u16 = (at: number) => (little ? tiff[at] | (tiff[at + 1] << 8) : (tiff[at] << 8) | tiff[at + 1])
  const ifd = little
    ? tiff[4] | (tiff[5] << 8) | (tiff[6] << 16) | (tiff[7] << 24)
    : (tiff[4] << 24) | (tiff[5] << 16) | (tiff[6] << 8) | tiff[7]
  for (let i = 0; i < u16(ifd); i++) {
    const entry = ifd + 2 + i * 12
    if (u16(entry) === 0x0112) return u16(entry + 8)
  }
  return null
}

const isExif = (segment: JpegSegment) =>
  segment.marker === 0xe1 && new TextDecoder().decode(segment.payload.subarray(0, 4)) === 'Exif'

const jpegSegment = (marker: number, payload: Uint8Array | number[] | string) => {
  const body = bytes(payload)
  return bytes([0xff, marker, ...u16be(body.length + 2)], body)
}

/** A big-endian Exif block with IFD0 holding just Orientation. */
const exifWithOrientation = (orientation: number) =>
  bytes('Exif\0\0', [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0])

describe('stripImageMetadata: JPEG', () => {
  const stripped = stripImageMetadata(GPS_JPEG)
  const { segments, sos } = jpegHeader(stripped)

  it('the fixture really carries Exif with GPS, XMP, IPTC and a trailer', () => {
    const header = jpegHeader(GPS_JPEG)
    const exif = header.segments.find(isExif)
    expect(exif && exifOrientation(exif.payload)).toBe(6)
    expect(indexOf(GPS_JPEG, Uint8Array.of(0x25, 0x88))).toBeGreaterThan(-1)
    for (const text of ['http://ns.adobe.com/xap/1.0/', 'Photoshop 3.0', 'shot at', 'TRAILER', '2026:10:16']) {
      expect(indexOf(GPS_JPEG, text)).toBeGreaterThan(-1)
    }
  })

  it('removes Exif, GPS, XMP, IPTC, comments and trailing data', () => {
    expect(indexOf(stripped, Uint8Array.of(0x25, 0x88))).toBe(-1) // GPS IFD pointer tag, little-endian
    expect(indexOf(stripped, Uint8Array.of(0x88, 0x25))).toBe(-1) // ...and big-endian
    for (const text of ['http://ns.adobe.com/xap', 'Photoshop', '8BIM', 'shot at', 'TRAILER', 'Yappr', '2026:10:16', 'Lavc']) {
      expect(indexOf(stripped, text)).toBe(-1)
    }
    const markers = segments.map((segment) => segment.marker)
    expect(markers).not.toContain(0xed) // APP13 IPTC
    expect(markers).not.toContain(0xfe) // COM
    expect(stripped.subarray(stripped.length - 2)).toEqual(Uint8Array.of(0xff, 0xd9))
  })

  it('keeps orientation in a minimal Exif segment right after the JFIF header', () => {
    expect(segments[0].marker).toBe(0xe0)
    expect(new TextDecoder().decode(segments[0].payload.subarray(0, 5))).toBe('JFIF\0')
    const exifSegments = segments.filter((segment) => segment.marker === 0xe1)
    expect(exifSegments).toHaveLength(1)
    expect(segments[1]).toEqual({ marker: 0xe1, payload: exifWithOrientation(6) })
    expect(exifOrientation(segments[1].payload)).toBe(6)
  })

  it('keeps the ICC profile, the Adobe marker and every coding segment', () => {
    const markers = segments.map((segment) => segment.marker)
    expect(markers).toEqual([0xe0, 0xe1, 0xe2, 0xee, 0xdb, 0xc4, 0xc0])
    expect(new TextDecoder().decode(segments[2].payload.subarray(0, 11))).toBe('ICC_PROFILE')
  })

  it('copies the scan data byte for byte', () => {
    const original = jpegHeader(PLAIN_JPEG)
    expect(stripped.subarray(sos)).toEqual(PLAIN_JPEG.subarray(original.sos))
  })

  it('is idempotent', () => {
    expect(stripImageMetadata(stripped)).toEqual(stripped)
  })

  it('writes no Exif at all when the photo is already upright', () => {
    const upright = bytes(GPS_JPEG.subarray(0, 20), jpegSegment(0xe1, exifWithOrientation(1)), GPS_JPEG.subarray(20))
    const out = stripImageMetadata(upright)
    expect(jpegHeader(out).segments.some(isExif)).toBe(false)
  })

  it('places orientation straight after SOI when there is no JFIF header', () => {
    const { sos: plainSos } = jpegHeader(PLAIN_JPEG)
    const exifFirst = bytes([0xff, 0xd8], jpegSegment(0xe1, exifWithOrientation(8)), PLAIN_JPEG.subarray(plainSos))
    const out = stripImageMetadata(exifFirst)
    expect(jpegHeader(out).segments).toEqual([{ marker: 0xe1, payload: exifWithOrientation(8) }])
    expect(stripImageMetadata(out)).toEqual(out)
  })

  it('drops a JFIF thumbnail', () => {
    const jfifWithThumb = bytes('JFIF\0', [1, 2, 0, 0, 1, 0, 1, 1, 1], [0xaa, 0xbb, 0xcc])
    const { sos: plainSos } = jpegHeader(PLAIN_JPEG)
    const out = stripImageMetadata(bytes([0xff, 0xd8], jpegSegment(0xe0, jfifWithThumb), PLAIN_JPEG.subarray(plainSos)))
    expect(jpegHeader(out).segments[0].payload).toEqual(bytes('JFIF\0', [1, 2, 0, 0, 1, 0, 1, 0, 0]))
  })

  it('walks every scan of a multi-scan image, dropping metadata between scans', () => {
    // Entropy data with a stuffed 0xFF00, a restart marker and fill bytes before the next marker.
    const scan1 = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd7, 0x78]
    const scan2 = [0x9a, 0xff, 0x00, 0xbc]
    const sosHeader = jpegSegment(0xda, [1, 1, 0, 0, 63, 0])
    const jpeg = bytes(
      [0xff, 0xd8],
      jpegSegment(0xc2, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
      jpegSegment(0xc4, [0x00, ...new Array<number>(16).fill(0)]),
      sosHeader, scan1, [0xff, 0xff],
      jpegSegment(0xe1, bytes('Exif\0\0', 'GPS between scans')),
      jpegSegment(0xfe, 'comment between scans'),
      jpegSegment(0xc4, [0x10, ...new Array<number>(16).fill(0)]),
      sosHeader, scan2,
      [0xff, 0xd9],
    )
    const out = stripImageMetadata(jpeg)
    expect(out).toEqual(bytes(
      [0xff, 0xd8],
      jpegSegment(0xc2, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
      jpegSegment(0xc4, [0x00, ...new Array<number>(16).fill(0)]),
      sosHeader, scan1,
      jpegSegment(0xc4, [0x10, ...new Array<number>(16).fill(0)]),
      sosHeader, scan2,
      [0xff, 0xd9],
    ))
    expect(stripImageMetadata(out)).toEqual(out)
  })

  it('keeps a file cut off inside its last scan as it is', () => {
    const truncated = GPS_JPEG.subarray(0, GPS_JPEG.length - 'TRAILER-motion-photo-video-with-gps'.length - 10)
    const out = stripImageMetadata(truncated)
    expect(out.subarray(jpegHeader(out).sos)).toEqual(truncated.subarray(jpegHeader(truncated).sos))
  })

  it('rejects a JPEG it cannot parse', () => {
    expect(() => stripImageMetadata(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toThrow(ImageMetadataError)
    expect(() => stripImageMetadata(GPS_JPEG.subarray(0, 40))).toThrow(/couldn’t be read/)
  })
})

// --- PNG --------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngChunk(type: string, data: Uint8Array | number[] | string): Uint8Array {
  const typeAndData = bytes(type, data)
  return bytes(u32be(typeAndData.length - 4), typeAndData, u32be(crc32(typeAndData)))
}

function pngChunks(png: Uint8Array): Array<{ type: string; crcValid: boolean }> {
  const chunks = []
  let pos = 8
  while (pos < png.length) {
    const length = (png[pos] << 24) | (png[pos + 1] << 16) | (png[pos + 2] << 8) | png[pos + 3]
    const typeAndData = png.subarray(pos + 4, pos + 8 + length)
    const crc = ((png[pos + 8 + length] << 24) | (png[pos + 9 + length] << 16) | (png[pos + 10 + length] << 8) | png[pos + 11 + length]) >>> 0
    chunks.push({ type: new TextDecoder().decode(typeAndData.subarray(0, 4)), crcValid: crc === crc32(typeAndData) })
    pos += 12 + length
  }
  return chunks
}

describe('stripImageMetadata: PNG', () => {
  // 1x1 RGB, one black pixel.
  const ihdr = pngChunk('IHDR', bytes(u32be(1), u32be(1), [8, 2, 0, 0, 0]))
  const idat = pngChunk('IDAT', deflateSync(Uint8Array.of(0, 0, 0, 0)))
  const exif = bytes('MM', [0, 42, 0, 0, 0, 8, 0, 1, 0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0])
  const png = bytes(
    PNG_SIGNATURE,
    ihdr,
    pngChunk('sRGB', [0]),
    pngChunk('gAMA', u32be(45455)),
    pngChunk('eXIf', exif),
    pngChunk('tEXt', 'Comment\0taken at home'),
    pngChunk('zTXt', bytes('Author\0', [0], deflateSync(new TextEncoder().encode('Alice')))),
    pngChunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>GPS</x:xmpmeta>'),
    pngChunk('tIME', [0x07, 0xea, 10, 16, 12, 0, 0]),
    pngChunk('prVt', 'private vendor data'),
    idat,
    pngChunk('IEND', ''),
    'trailing bytes',
  )

  it('the fixture is a valid PNG with metadata chunks', () => {
    expect(pngChunks(png.subarray(0, png.length - 'trailing bytes'.length)).every((chunk) => chunk.crcValid)).toBe(true)
  })

  it('drops eXIf, text, time and unknown ancillary chunks and keeps colour chunks', () => {
    const out = stripImageMetadata(png)
    expect(pngChunks(out)).toEqual(
      ['IHDR', 'sRGB', 'gAMA', 'IDAT', 'IEND'].map((type) => ({ type, crcValid: true }))
    )
    expect(indexOf(out, 'taken at home')).toBe(-1)
    expect(out).toEqual(bytes(PNG_SIGNATURE, ihdr, pngChunk('sRGB', [0]), pngChunk('gAMA', u32be(45455)), idat, pngChunk('IEND', '')))
    expect(stripImageMetadata(out)).toEqual(out)
  })

  it('keeps a non-default orientation in an orientation-only eXIf where the eXIf was', () => {
    const oriented = bytes(
      PNG_SIGNATURE, ihdr,
      pngChunk('eXIf', bytes('MM', [0, 42, 0, 0, 0, 8, 0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 38, 0, 0, 0, 0])),
      idat, pngChunk('IEND', ''),
    )
    const out = stripImageMetadata(oriented)
    expect(pngChunks(out)).toEqual(['IHDR', 'eXIf', 'IDAT', 'IEND'].map((type) => ({ type, crcValid: true })))
    expect(out).toEqual(bytes(PNG_SIGNATURE, ihdr, pngChunk('eXIf', exifWithOrientation(6).subarray(6)), idat, pngChunk('IEND', '')))
    expect(stripImageMetadata(out)).toEqual(out)
  })

  it('rejects a PNG without IHDR first or cut short', () => {
    expect(() => stripImageMetadata(bytes(PNG_SIGNATURE, idat, pngChunk('IEND', '')))).toThrow(ImageMetadataError)
    expect(() => stripImageMetadata(png.subarray(0, 60))).toThrow(ImageMetadataError)
  })
})

// --- WebP -------------------------------------------------------------------

function riffChunk(fourcc: string, data: Uint8Array | number[] | string): Uint8Array {
  const body = bytes(data)
  return bytes(fourcc, u32le(body.length), body, body.length % 2 ? [0] : [])
}

const riff = (...chunks: Uint8Array[]) => {
  const body = bytes('WEBP', ...chunks)
  return bytes('RIFF', u32le(body.length), body)
}

function webpChunks(webp: Uint8Array): string[] {
  const fourccs = []
  let pos = 12
  while (pos < webp.length) {
    const size = webp[pos + 4] | (webp[pos + 5] << 8) | (webp[pos + 6] << 16) | (webp[pos + 7] << 24)
    fourccs.push(new TextDecoder().decode(webp.subarray(pos, pos + 4)))
    pos += 8 + size + (size % 2)
  }
  return fourccs
}

describe('stripImageMetadata: WebP', () => {
  // The VP8L chunk of the real 8x8 lossless fixture.
  const vp8l = PLAIN_WEBP.subarray(12)
  // Flags: ICC (0x20) | EXIF (0x08) | XMP (0x04); canvas 8x8 (stored minus one).
  const vp8x = (flags: number) => riffChunk('VP8X', [flags, 0, 0, 0, 7, 0, 0, 7, 0, 0])
  const iccp = riffChunk('ICCP', 'fake icc')
  const webp = riff(vp8x(0x2c), iccp, vp8l, riffChunk('EXIF', 'Exif\0\0GPS 40.7N'), riffChunk('XMP ', '<x:xmpmeta>GPS</x:xmpmeta>'))

  it('drops EXIF and XMP, clears their flags and fixes the RIFF size', () => {
    expect(webpChunks(webp)).toEqual(['VP8X', 'ICCP', 'VP8L', 'EXIF', 'XMP '])
    const out = stripImageMetadata(webp)
    expect(webpChunks(out)).toEqual(['VP8X', 'ICCP', 'VP8L'])
    expect(out).toEqual(riff(vp8x(0x20), iccp, vp8l))
    expect(out[20]).toBe(0x20)
    expect(out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24)).toBe(out.length - 8)
    expect(indexOf(out, 'GPS')).toBe(-1)
    expect(stripImageMetadata(out)).toEqual(out)
  })

  it('keeps a non-default orientation in an orientation-only EXIF chunk, flagged in VP8X', () => {
    const oriented = riff(vp8x(0x2c), iccp, vp8l, riffChunk('EXIF', bytes(exifWithOrientation(8), 'GPS 40.7N')), riffChunk('XMP ', '<x:xmpmeta>GPS</x:xmpmeta>'))
    const out = stripImageMetadata(oriented)
    expect(webpChunks(out)).toEqual(['VP8X', 'ICCP', 'VP8L', 'EXIF'])
    expect(out).toEqual(riff(vp8x(0x28), iccp, vp8l, riffChunk('EXIF', exifWithOrientation(8).subarray(6))))
    expect(indexOf(out, 'GPS')).toBe(-1)
    expect(stripImageMetadata(out)).toEqual(out)
  })

  it('leaves a simple WebP with no metadata unchanged', () => {
    expect(stripImageMetadata(PLAIN_WEBP)).toEqual(PLAIN_WEBP)
  })

  it('drops data past the RIFF size and rejects a RIFF size past the end', () => {
    expect(stripImageMetadata(bytes(PLAIN_WEBP, 'appended'))).toEqual(PLAIN_WEBP)
    expect(() => stripImageMetadata(PLAIN_WEBP.subarray(0, 40))).toThrow(ImageMetadataError)
  })
})

// --- GIF --------------------------------------------------------------------

describe('stripImageMetadata: GIF', () => {
  const header = bytes('GIF89a', [1, 0, 1, 0, 0x80, 0, 0], [0, 0, 0, 255, 255, 255])
  const netscape = bytes([0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0])
  const comment = bytes([0x21, 0xfe, 13], 'shot at home!', [0])
  // XMP as Adobe writes it: raw packet bytes, then the 258-byte "magic trailer".
  const magicTrailer = [1, ...Array.from({ length: 256 }, (_, i) => 255 - i), 0]
  const xmp = bytes([0x21, 0xff, 11], 'XMP DataXMP', '<x:xmpmeta>GPS 40.7N</x:xmpmeta>', magicTrailer)
  const graphicControl = [0x21, 0xf9, 4, 0, 0, 0, 0, 0]
  const image = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]
  const gif = bytes(header, netscape, comment, xmp, graphicControl, image, [0x3b], 'trailing')

  it('drops comments, XMP and trailing data and keeps looping and frames', () => {
    const out = stripImageMetadata(gif)
    expect(out).toEqual(bytes(header, netscape, graphicControl, image, [0x3b]))
    expect(stripImageMetadata(out)).toEqual(out)
  })

  it('closes a GIF that ends without its trailer after an image, as browsers do', () => {
    expect(stripImageMetadata(bytes(header, comment, image))).toEqual(bytes(header, image, [0x3b]))
  })

  it('rejects a GIF that ends before any image', () => {
    expect(() => stripImageMetadata(bytes(header, comment))).toThrow(ImageMetadataError)
  })
})

describe('detectImageFormat', () => {
  it('sniffs the format from the bytes', () => {
    expect(detectImageFormat(GPS_JPEG)).toBe('jpeg')
    expect(detectImageFormat(PLAIN_WEBP)).toBe('webp')
    expect(detectImageFormat(bytes('GIF87a'))).toBe('gif')
    expect(detectImageFormat(bytes(PNG_SIGNATURE))).toBe('png')
    expect(detectImageFormat(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })

  it('refuses formats it cannot clean', () => {
    const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(() => stripImageMetadata(svg)).toThrow(ImageMetadataError)
    try {
      stripImageMetadata(svg)
    } catch (error) {
      expect((error as ImageMetadataError).reason).toBe('unsupported')
    }
  })
})
