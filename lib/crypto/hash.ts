import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'

/**
 * RIPEMD160(SHA256(data)) - used for address/key matching
 */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data))
}
