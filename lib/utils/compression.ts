import { zlibSync, unzlibSync } from 'fflate'

export function compressContent(json: unknown): Uint8Array {
  try {
    const serialized = JSON.stringify(json)
    const encoded = new TextEncoder().encode(serialized)
    return zlibSync(encoded)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown compression error'
    throw new Error(`Failed to compress content: ${message}`)
  }
}

export function decompressContent(compressed: Uint8Array): unknown | null {
  try {
    const inflated = unzlibSync(compressed)
    const decoded = new TextDecoder().decode(inflated)
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

export function getCompressedSize(json: unknown): number {
  return compressContent(json).byteLength
}
