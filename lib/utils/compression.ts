import { zlibSync, unzlibSync } from 'fflate'

export function compressContent(json: unknown): Uint8Array {
  const serialized = JSON.stringify(json)
  const encoded = new TextEncoder().encode(serialized)
  return zlibSync(encoded)
}

export function decompressContent(compressed: Uint8Array): unknown {
  try {
    const inflated = unzlibSync(compressed)
    const decoded = new TextDecoder().decode(inflated)
    return JSON.parse(decoded)
  } catch {
    throw new Error('Failed to decompress content: invalid or corrupted data')
  }
}

export function getCompressedSize(json: unknown): number {
  return compressContent(json).byteLength
}
