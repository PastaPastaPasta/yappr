import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it, vi } from 'vitest'
import type { MediaHashes } from './media-fingerprint'
import { uploadPostImage } from './post-image-upload'
import { stripFileMetadata } from './strip-file-metadata'
import { ImageMetadataError, stripImageMetadata } from './strip-metadata'

const GPS_JPEG = new Uint8Array(readFileSync(resolve(__dirname, '__fixtures__', 'gps.jpg')))
const STRIPPED = stripImageMetadata(GPS_JPEG)
const fileBytes = async (file: Blob) => new Uint8Array(await file.arrayBuffer())

describe('stripFileMetadata', () => {
  it('returns the stripped bytes under a neutral name', async () => {
    const cleaned = await stripFileMetadata(new File([GPS_JPEG], 'IMG_20261015_143201.jpg', { type: 'image/jpeg' }))
    expect(cleaned.name).toBe('image.jpg')
    expect(cleaned.type).toBe('image/jpeg')
    expect(await fileBytes(cleaned)).toEqual(STRIPPED)
  })

  it('types the file by its bytes, not its claimed type', async () => {
    const cleaned = await stripFileMetadata(new File([GPS_JPEG], 'photo.png', { type: 'image/png' }))
    expect(cleaned.type).toBe('image/jpeg')
  })

  it('hands back a file it already cleaned as is', async () => {
    const cleaned = await stripFileMetadata(new File([GPS_JPEG], 'a.jpg', { type: 'image/jpeg' }))
    expect(await stripFileMetadata(cleaned)).toBe(cleaned)
    // A fresh file with already-clean bytes is cleaned to the same bytes.
    const again = await stripFileMetadata(new File([STRIPPED], 'a.jpg', { type: 'image/jpeg' }))
    expect(await fileBytes(again)).toEqual(STRIPPED)
  })

  it('refuses SVG', async () => {
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'a.svg', { type: 'image/svg+xml' })
    await expect(stripFileMetadata(svg)).rejects.toBeInstanceOf(ImageMetadataError)
  })

  it('never passes through an image it cannot decode or clean', async () => {
    const heic = new File([new Uint8Array(64)], 'a.heic', { type: 'image/heic' })
    await expect(stripFileMetadata(heic)).rejects.toMatchObject({ reason: 'unsupported' })
    const brokenJpeg = new File([new Uint8Array(64)], 'a.jpg', { type: 'image/jpeg' })
    await expect(stripFileMetadata(brokenJpeg)).rejects.toMatchObject({ reason: 'corrupt' })
  })
})

describe('uploadPostImage', () => {
  const hashOf = async (file: Blob): Promise<MediaHashes> => ({
    mediaHash: sha256(await fileBytes(file)),
    mediaFingerprint: new Uint8Array(8),
  })

  it('uploads and hashes the same stripped file', async () => {
    const upload = vi.fn(async (file: File) => ({ cid: 'bafy', url: 'ipfs://bafy', size: file.size }))
    const computeHashes = vi.fn(hashOf)
    const result = await uploadPostImage(new File([GPS_JPEG], 'a.jpg', { type: 'image/jpeg' }), upload, computeHashes)

    const uploaded = upload.mock.calls[0][0]
    expect(computeHashes.mock.calls[0][0]).toBe(uploaded)
    expect(await fileBytes(uploaded)).toEqual(STRIPPED)
    expect(result.hashes?.mediaHash).toEqual(sha256(STRIPPED))
    expect(result.size).toBe(STRIPPED.length)
  })

  it('uploads the stripped file when the post carries no hashes', async () => {
    const upload = vi.fn(async (file: File) => ({ cid: 'bafy', url: 'ipfs://bafy', size: file.size }))
    const result = await uploadPostImage(new File([GPS_JPEG], 'a.jpg', { type: 'image/jpeg' }), upload, null)
    expect(await fileBytes(upload.mock.calls[0][0])).toEqual(STRIPPED)
    expect(result.hashes).toBeUndefined()
  })

  it('uploads nothing when the image cannot be cleaned', async () => {
    const upload = vi.fn(async () => ({ cid: 'bafy', url: 'ipfs://bafy' }))
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })
    await expect(uploadPostImage(svg, upload, hashOf)).rejects.toBeInstanceOf(ImageMetadataError)
    expect(upload).not.toHaveBeenCalled()
  })
})
