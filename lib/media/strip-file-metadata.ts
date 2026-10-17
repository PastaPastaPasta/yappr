/**
 * File-level wrapper around ./strip-metadata for everything that uploads an
 * image. JPEG, PNG, WebP and GIF are cleaned byte for byte. Other raster types
 * the browser can decode (AVIF, HEIC, BMP, TIFF...) carry metadata in
 * containers this does not parse, so they are re-drawn through a canvas and
 * uploaded as a fresh JPEG instead. SVG is refused: it is a document, not
 * pixels, and cannot be cleaned without changing what it is.
 */

import {
  ImageMetadataError,
  STRIPPABLE_MIME_TYPES,
  type StrippableImageFormat,
  detectImageFormat,
  stripImageMetadata,
} from './strip-metadata'

/** Quality of the JPEG a non-strippable image is re-encoded to. */
const REENCODE_QUALITY = 0.92

/**
 * Files this module produced. A File's bytes never change, so one found here
 * is already clean and is returned as is: the hook and the provider can both
 * clean the same upload without reading it twice, and the digest taken from
 * the first pass is guaranteed to describe the bytes the provider sends.
 */
const cleanedFiles = new WeakSet<File>()

/**
 * `file` with its metadata removed, under a neutral name; its type is that of
 * the bytes actually inside. Rejects with ImageMetadataError (its message is fit to
 * show the user) rather than ever handing back uncleaned bytes.
 */
export async function stripFileMetadata(file: File): Promise<File> {
  if (cleanedFiles.has(file)) return file
  const bytes = new Uint8Array(await file.arrayBuffer())
  const format = detectImageFormat(bytes)
  const cleaned = format
    ? new File([stripImageMetadata(bytes)], cleanName(format), { type: STRIPPABLE_MIME_TYPES[format] })
    : await reencodeFile(file)
  cleanedFiles.add(cleaned)
  return cleaned
}

async function reencodeFile(file: File): Promise<File> {
  if (file.type === 'image/svg+xml') throw new ImageMetadataError('unsupported')
  const claimsStrippable = Object.values(STRIPPABLE_MIME_TYPES).includes(file.type)
  const jpeg = await reencodeAsJpeg(file, claimsStrippable ? 'corrupt' : 'unsupported')
  return new File([stripImageMetadata(jpeg)], cleanName('jpeg'), { type: 'image/jpeg' })
}

/**
 * Draws the decoded image (upright, per its own orientation) over white, as
 * the dHash does, and encodes it as JPEG. A browser that cannot decode the
 * file rejects with `failure`.
 */
async function reencodeAsJpeg(file: File, failure: 'corrupt' | 'unsupported'): Promise<Uint8Array> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new ImageMetadataError(failure)
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new ImageMetadataError('unsupported')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', REENCODE_QUALITY))
    if (!blob) throw new ImageMetadataError('unsupported')
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    bitmap.close()
  }
}

/**
 * A neutral file name: a camera's `IMG_20261015_143201.jpg` gives away when
 * the photo was taken, and the name travels with the upload.
 */
function cleanName(format: StrippableImageFormat): string {
  return `image.${format === 'jpeg' ? 'jpg' : format}`
}
