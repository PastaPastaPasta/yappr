import * as secp256k1 from '@noble/secp256k1'

/**
 * The x-coordinate of the secp256k1 ECDH shared point. Both sides compute the
 * same 32 bytes: ECDH(aPriv, bPub) == ECDH(bPriv, aPub). Callers must run this
 * through a KDF before using it as a key.
 */
export function ecdhSharedX(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  // Compressed output is 0x02/0x03 || x; the x-coordinate is bytes 1..33.
  return secp256k1.getSharedSecret(privateKey, publicKey, true).slice(1, 33)
}
