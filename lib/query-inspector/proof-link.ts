/**
 * Deep links into the GroveDB proof visualizer
 * (https://github.com/dashpay/grovedb-proof-visualizer-widget).
 *
 * The visualizer reads proofs from the URL fragment (never sent to a server):
 * `#f=bytes&d=<base64url(gzip(raw proof bytes))>`, base64url without padding.
 */

import { hexToBytes } from './serialize'

export const PROOF_VISUALIZER_URL = 'https://dashpay.github.io/grovedb-proof-visualizer-widget/'

// Above ~50 KB of encoded payload some browsers refuse the URL; callers fall
// back to copying the proof hex and opening the visualizer for a manual paste.
const MAX_ENCODED_BYTES = 50_000

export async function buildVisualizerLink(grovedbProofHex: string): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const bytes = hexToBytes(grovedbProofHex)
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
    if (compressed.length > MAX_ENCODED_BYTES) return null
    return `${PROOF_VISUALIZER_URL}#f=bytes&d=${base64UrlEncode(compressed)}`
  } catch {
    return null
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
