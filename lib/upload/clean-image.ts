import { stripFileMetadata } from '@/lib/media/strip-file-metadata'
import { ImageMetadataError } from '@/lib/media/strip-metadata'
import { UploadException, UploadErrorCode } from './errors'

/**
 * The checks every provider's `uploadImage` runs before sending anything: an
 * image type, at most `maxBytes`, and metadata (Exif, GPS, XMP...) stripped.
 * Returns the cleaned file, which is what must be uploaded; already-cleaned
 * files come back unchanged, so cleaning earlier (to hash the bytes) is safe.
 */
export async function cleanImageForUpload(file: File, maxBytes: number): Promise<File> {
  if (!file.type.startsWith('image/')) {
    throw new UploadException(UploadErrorCode.INVALID_FILE, 'Only image files are supported')
  }
  const tooLarge = () =>
    new UploadException(UploadErrorCode.INVALID_FILE, `Image must be under ${Math.floor(maxBytes / (1024 * 1024))}MB`)
  if (file.size > maxBytes) throw tooLarge()

  let cleaned: File
  try {
    cleaned = await stripFileMetadata(file)
  } catch (error) {
    if (error instanceof ImageMetadataError) {
      throw new UploadException(UploadErrorCode.INVALID_FILE, error.message, error)
    }
    throw error
  }
  // A re-encoded image can come out larger than it went in.
  if (cleaned.size > maxBytes) throw tooLarge()
  return cleaned
}
