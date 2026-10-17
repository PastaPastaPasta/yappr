import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { stripImageMetadata } from '@/lib/media/strip-metadata'
import { cleanImageForUpload } from './clean-image'
import { UploadErrorCode, UploadException } from './errors'
import { PinataProvider } from './providers/pinata/pinata-provider'
import { StorachaProvider } from './providers/storacha/storacha-provider'

const GPS_JPEG = new Uint8Array(readFileSync(resolve(__dirname, '../media/__fixtures__/gps.jpg')))
const STRIPPED = stripImageMetadata(GPS_JPEG)
const photo = () => new File([GPS_JPEG], 'IMG_0001.jpg', { type: 'image/jpeg' })
const fileBytes = async (file: Blob) => new Uint8Array(await file.arrayBuffer())
const MB = 1024 * 1024

describe('cleanImageForUpload', () => {
  it('returns the stripped image', async () => {
    expect(await fileBytes(await cleanImageForUpload(photo(), MB))).toEqual(STRIPPED)
  })

  it('returns an already-cleaned file itself, so an earlier digest still matches', async () => {
    const cleaned = await cleanImageForUpload(photo(), MB)
    expect(await cleanImageForUpload(cleaned, MB)).toBe(cleaned)
  })

  it('rejects non-images, oversized images and images it cannot clean as invalid files', async () => {
    const text = new File(['hello'], 'a.txt', { type: 'text/plain' })
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })
    for (const [file, maxBytes] of [[text, MB], [photo(), 100], [svg, MB]] as const) {
      const error = await cleanImageForUpload(file, maxBytes).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(UploadException)
      expect((error as UploadException).code).toBe(UploadErrorCode.INVALID_FILE)
    }
  })
})

describe('provider uploadImage', () => {
  it('Pinata sends the stripped bytes', async () => {
    const send = vi.fn(async (file: File) => ({ cid: `cid-${file.size}` }))
    const provider = new PinataProvider()
    // Stand in for a connected SDK client.
    Object.assign(provider, { client: { upload: { public: { file: send } } }, status: 'connected' })
    const result = await provider.uploadImage(photo())
    expect(await fileBytes(send.mock.calls[0][0])).toEqual(STRIPPED)
    expect(result.size).toBe(STRIPPED.length)
  })

  it('Storacha sends the stripped bytes', async () => {
    const send = vi.fn(async (file: Blob) => ({ toString: () => `cid-${file.size}` }))
    const provider = new StorachaProvider()
    Object.assign(provider, { client: { uploadFile: send }, status: 'connected' })
    const result = await provider.uploadImage(photo())
    expect(await fileBytes(send.mock.calls[0][0])).toEqual(STRIPPED)
    expect(result.cid).toBe(`cid-${STRIPPED.length}`)
  })
})
