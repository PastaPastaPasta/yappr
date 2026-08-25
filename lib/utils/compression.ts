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

export function splitIntoChunks(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    chunks.push(data.slice(offset, offset + chunkSize))
  }
  return chunks
}

export function joinChunks(chunks: (Uint8Array | null | undefined)[]): Uint8Array {
  // Stop at first absent chunk — gaps are not valid in ordered chunked data
  const contiguous: Uint8Array[] = []
  for (const c of chunks) {
    if (c == null || c.byteLength === 0) break
    contiguous.push(c)
  }
  if (contiguous.length === 0) return new Uint8Array(0)
  if (contiguous.length === 1) return contiguous[0]
  const totalLength = contiguous.reduce((sum, c) => sum + c.byteLength, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of contiguous) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}
