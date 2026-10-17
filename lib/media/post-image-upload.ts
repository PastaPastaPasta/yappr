import type { UploadResult } from '@/lib/upload/types'
import type { MediaHashes } from './media-fingerprint'
import { stripFileMetadata } from './strip-file-metadata'

/**
 * Upload a post image with its metadata stripped. When the post must carry the
 * image's sha256 and dHash beside its URL, `computeHashes` runs over the very
 * File that is uploaded, so the digest matches the content behind the CID.
 */
export async function uploadPostImage(
  file: File,
  upload: (file: File) => Promise<UploadResult>,
  computeHashes: ((file: Blob) => Promise<MediaHashes>) | null
): Promise<UploadResult> {
  const cleaned = await stripFileMetadata(file)
  if (!computeHashes) return upload(cleaned)
  const [result, hashes] = await Promise.all([upload(cleaned), computeHashes(cleaned)])
  return { ...result, hashes }
}
