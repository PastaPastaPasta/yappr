/**
 * Fixed inputs for the DM v5 test vectors. Changing any of these changes
 * every vector, so leave them alone.
 */

import { getPublicKey } from '@/lib/crypto/keys'
import { bytesToHex, hexToBytes } from '@/lib/bytes'

const fill = (length: number, f: (i: number) => number) => Uint8Array.from({ length }, (_, i) => f(i))

export const ALICE_PRIV = fill(32, (i) => i + 1)
export const BOB_PRIV = fill(32, (i) => 0x40 + i)
export const CAROL_PRIV = fill(32, (i) => 0x80 + i)
export const ALICE_PUB = getPublicKey(ALICE_PRIV)
export const BOB_PUB = getPublicKey(BOB_PRIV)
export const CAROL_PUB = getPublicKey(CAROL_PRIV)

export const ALICE_ID = fill(32, () => 0xaa)
export const BOB_ID = fill(32, () => 0xbb)
export const CAROL_ID = fill(32, () => 0xcc)

/** A 32-byte key of `byte` repeated. */
export const key32 = (byte: number) => fill(32, () => byte)

export { bytesToHex as hex, hexToBytes as unhex }
