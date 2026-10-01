/**
 * The wallet side of `dash-st:` for the one transition Yappr hands off in 1.0:
 * an unsigned IdentityUpdate that adds the login-derived keys (spec §11.5),
 * signed with the identity's MASTER key (keyId 0). No network access here.
 */
import {
  IdentityPublicKey,
  IdentityUpdateTransition,
  PrivateKey,
  StateTransition,
} from '@dashevo/evo-sdk'
import { bytesToHex } from '@noble/hashes/utils.js'

/** wasm-dpp2 `StateTransition.actionType` of an identity update. */
const IDENTITY_UPDATE = 'IdentityUpdate'

/**
 * Decodes the transition carried by a `dash-st:` URI. The web
 * (`lib/services/identity-update-builder.ts`) sends
 * `IdentityUpdateTransition.toBytes()`, which lacks the StateTransition enum
 * tag that `StateTransition.toBytes()` writes, so both encodings are accepted.
 * The wasm decoders ignore trailing bytes, so a decoding only counts when it
 * re-encodes to exactly the input.
 */
export function decodeIdentityUpdate(transitionBytes: Uint8Array): StateTransition {
  const decoders: Array<() => { stateTransition: StateTransition; reencoded: Uint8Array }> = [
    () => {
      const inner = IdentityUpdateTransition.fromBytes(transitionBytes)
      return { stateTransition: inner.toStateTransition(), reencoded: inner.toBytes() }
    },
    () => {
      const stateTransition = StateTransition.fromBytes(transitionBytes)
      return { stateTransition, reencoded: stateTransition.toBytes() }
    },
  ]
  const input = bytesToHex(transitionBytes)
  for (const decode of decoders) {
    let decoded: ReturnType<typeof decode>
    try {
      decoded = decode()
    } catch {
      continue
    }
    if (bytesToHex(decoded.reencoded) === input && decoded.stateTransition.actionType === IDENTITY_UPDATE) {
      return decoded.stateTransition
    }
  }
  throw new Error('dash-st: payload is not an exactly-encoded IdentityUpdate transition')
}

/** What the 1.0 app may add: its login-derived auth (HIGH) and encryption (MEDIUM) keys. */
const ALLOWED_ADDITIONS = new Set(['AUTHENTICATION/HIGH', 'ENCRYPTION/MEDIUM'])

/**
 * The key ids an IdentityUpdate adds, refusing anything beyond
 * the 1.0 key registration: no disables (they would break the persona's pool
 * keys), and no added MASTER, CRITICAL or TRANSFER key.
 */
export function inspectIdentityUpdate(stateTransition: StateTransition): { addedKeyIds: number[] } {
  const update = IdentityUpdateTransition.fromStateTransition(stateTransition)
  try {
    if (update.publicKeyIdsToDisable.length > 0) {
      throw new Error(`dash-st: refusing to disable keys ${Array.from(update.publicKeyIdsToDisable).join(', ')}`)
    }
    const added = update.publicKeyIdsToAdd
    if (added.length === 0) throw new Error('dash-st: IdentityUpdate adds no keys')
    for (const key of added) {
      const kind = `${key.purpose}/${key.securityLevel}`.toUpperCase()
      if (!ALLOWED_ADDITIONS.has(kind)) throw new Error(`dash-st: refusing to add keyId ${key.keyId} (${kind})`)
    }
    return { addedKeyIds: added.map((key) => key.keyId) }
  } finally {
    update.free()
  }
}

/** DIP-30: the lower 40 bits of a nonce are its sequence number. */
export const NONCE_SEQUENCE_MASK = (BigInt(1) << BigInt(40)) - BigInt(1)

/** An IdentityUpdate whose nonce is not past the identity's current one would be refused. */
export function isStaleIdentityNonce(carried: bigint, current: bigint): boolean {
  return (carried & NONCE_SEQUENCE_MASK) <= (current & NONCE_SEQUENCE_MASK)
}

/** The pool MASTER key as an IdentityPublicKey (pool keys are full secp256k1 keys). */
export function masterIdentityPublicKey(publicKey: Uint8Array): IdentityPublicKey {
  return new IdentityPublicKey({
    keyId: 0,
    purpose: 'authentication',
    securityLevel: 'master',
    keyType: 'ecdsa_secp256k1',
    data: publicKey,
  })
}

/**
 * Signs `stateTransition` in place with the MASTER key. The caller has
 * already checked the transition is for the persona. Refuses a signing key
 * that is not keyId 0.
 */
export function signIdentityUpdate(
  stateTransition: StateTransition,
  masterPrivateKey: Uint8Array,
  masterPublicKey: IdentityPublicKey,
): void {
  if (masterPublicKey.keyId !== 0) {
    throw new Error(`dash-st: IdentityUpdate must be signed with keyId 0, not ${masterPublicKey.keyId}`)
  }
  // Throws when the key's purpose or level cannot sign this transition.
  stateTransition.verifyPublicKey(masterPublicKey)
  const privateKey = PrivateKey.fromBytes(masterPrivateKey, 'testnet')
  try {
    stateTransition.sign(privateKey, masterPublicKey)
  } finally {
    privateKey.free()
  }
}
