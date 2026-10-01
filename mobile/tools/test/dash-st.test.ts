/**
 * `dash-st:` with the broadcast stubbed: an unsigned IdentityUpdate built the
 * way the web builds it (lib/services/identity-update-builder.ts) is parsed,
 * signed with MASTER keyId 0, and the signature verifies against that key.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import * as secp256k1 from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import bs58 from 'bs58'
import {
  IdentityPublicKeyInCreation,
  IdentityUpdateTransition,
  StateTransition,
  ensureInitialized,
} from '@dashevo/evo-sdk'
import {
  buildYapprStateTransitionUri,
  hash160,
} from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import { isStaleIdentityNonce, masterIdentityPublicKey } from '../src/dash-st'
import { respond, type ResponderPorts } from '../src/responder'
import { IDENTITY_ID, testPersona, testPrivateKey } from './fixtures'

const AUTH_KEY = new Uint8Array(32).fill(0x31)
const ENCRYPTION_KEY = new Uint8Array(32).fill(0x32)
const MASTER_PUBLIC_KEY = secp256k1.getPublicKey(testPrivateKey(0), true)

beforeAll(async () => {
  await ensureInitialized()
})

/** The unsigned transition of a first login: an auth (hash160, HIGH) and an encryption key. */
function unsignedUpdate(
  identityId = IDENTITY_ID,
  extra: { add?: IdentityPublicKeyInCreation[]; disable?: number[] } = {},
): IdentityUpdateTransition {
  return new IdentityUpdateTransition({
    identityId,
    revision: BigInt(2),
    nonce: BigInt(5),
    addPublicKeys: [
      new IdentityPublicKeyInCreation({
        keyId: 5,
        purpose: 'authentication',
        securityLevel: 'high',
        keyType: 'ecdsa_hash160',
        isReadOnly: false,
        data: hash160(secp256k1.getPublicKey(AUTH_KEY, true)),
        signature: new Uint8Array(0),
      }),
      new IdentityPublicKeyInCreation({
        keyId: 6,
        purpose: 'encryption',
        securityLevel: 'medium',
        keyType: 'ecdsa_secp256k1',
        isReadOnly: false,
        data: secp256k1.getPublicKey(ENCRYPTION_KEY, true),
        signature: new Uint8Array(0),
      }),
      ...(extra.add ?? []),
    ],
    disablePublicKeys: extra.disable ?? [],
  })
}

function capturingPorts() {
  const broadcasts: Uint8Array[] = []
  const ports: ResponderPorts = {
    findLoginKeyResponse: () => Promise.reject(new Error('not used')),
    writeLoginKeyResponse: () => Promise.reject(new Error('not used')),
    masterKey: async () => masterIdentityPublicKey(MASTER_PUBLIC_KEY),
    checkIdentityUpdate: async () => undefined,
    broadcast: async (stateTransition) => {
      broadcasts.push(stateTransition.toBytes())
      return { transitionHash: stateTransition.hash(false), confirmed: true }
    },
  }
  return { ports, broadcasts }
}

/** Recovers the signer of a Dash compact signature over sha256d(signable bytes). */
function recoverSigner(stateTransition: StateTransition): Uint8Array {
  const signature = stateTransition.signature!
  expect(signature).toHaveLength(65)
  const recovered = new Uint8Array(65)
  recovered[0] = signature[0] - 27 - 4 // compact header: 27 + 4 (compressed) + recovery id
  recovered.set(signature.slice(1), 1)
  const digest = sha256(sha256(stateTransition.getSignableBytes()))
  return secp256k1.recoverPublicKey(recovered, digest, { prehash: false })
}

describe('dash-st: IdentityUpdate', () => {
  it('parses the web encoding, signs with MASTER keyId 0, and the signature verifies', async () => {
    const unsigned = unsignedUpdate()
    const unsignedSignable = bytesToHex(unsigned.toStateTransition().getSignableBytes())
    const uri = buildYapprStateTransitionUri(unsigned.toBytes(), 'devnet')
    const { ports, broadcasts } = capturingPorts()

    const result = await respond({ uri, persona: testPersona() }, ports)

    expect(result).toMatchObject({
      kind: 'dash-st',
      identityId: IDENTITY_ID,
      signaturePublicKeyId: 0,
      addedKeyIds: [5, 6],
      confirmed: true,
    })
    expect(broadcasts).toHaveLength(1)
    const signed = StateTransition.fromBytes(broadcasts[0])
    expect(signed.actionType).toBe('IdentityUpdate')
    expect(signed.signaturePublicKeyId).toBe(0)
    // The wallet signed exactly what the app built…
    expect(bytesToHex(signed.getSignableBytes())).toBe(unsignedSignable)
    // …with the MASTER key.
    expect(bytesToHex(recoverSigner(signed))).toBe(bytesToHex(MASTER_PUBLIC_KEY))
  })

  it('also accepts a StateTransition-encoded payload', async () => {
    const uri = buildYapprStateTransitionUri(unsignedUpdate().toStateTransition().toBytes(), 'devnet')
    const { ports, broadcasts } = capturingPorts()
    await respond({ uri, persona: testPersona() }, ports)
    expect(bytesToHex(recoverSigner(StateTransition.fromBytes(broadcasts[0])))).toBe(bytesToHex(MASTER_PUBLIC_KEY))
  })

  it("refuses to sign another identity's update", async () => {
    const other = bs58.encode(new Uint8Array(32).fill(0x43))
    const uri = buildYapprStateTransitionUri(unsignedUpdate(other).toBytes(), 'devnet')
    const { ports, broadcasts } = capturingPorts()
    await expect(respond({ uri, persona: testPersona() }, ports)).rejects.toThrow(/not the persona/)
    expect(broadcasts).toHaveLength(0)
  })

  it('refuses a payload that is not an IdentityUpdate, or has trailing bytes', async () => {
    const { ports, broadcasts } = capturingPorts()
    const garbage = buildYapprStateTransitionUri(new Uint8Array(40).fill(7), 'devnet')
    await expect(respond({ uri: garbage, persona: testPersona() }, ports)).rejects.toThrow(/IdentityUpdate/)
    const bytes = unsignedUpdate().toBytes()
    const padded = new Uint8Array(bytes.length + 1)
    padded.set(bytes)
    const trailing = buildYapprStateTransitionUri(padded, 'devnet')
    await expect(respond({ uri: trailing, persona: testPersona() }, ports)).rejects.toThrow(/IdentityUpdate/)
    expect(broadcasts).toHaveLength(0)
  })

  it('refuses a transition for another network', async () => {
    const uri = buildYapprStateTransitionUri(unsignedUpdate().toBytes(), 'testnet')
    const { ports, broadcasts } = capturingPorts()
    await expect(respond({ uri, persona: testPersona() }, ports)).rejects.toThrow(/testnet/)
    expect(broadcasts).toHaveLength(0)
  })

  it('refuses a signing key other than keyId 0', async () => {
    const uri = buildYapprStateTransitionUri(unsignedUpdate().toBytes(), 'devnet')
    const { ports } = capturingPorts()
    ports.masterKey = async () => {
      const key = masterIdentityPublicKey(MASTER_PUBLIC_KEY)
      key.keyId = 1
      return key
    }
    await expect(respond({ uri, persona: testPersona() }, ports)).rejects.toThrow(/keyId 0/)
  })

  it('refuses anything beyond the 1.0 key registration: disables, or MASTER/CRITICAL/TRANSFER additions', async () => {
    const { ports, broadcasts } = capturingPorts()
    const disabling = buildYapprStateTransitionUri(unsignedUpdate(IDENTITY_ID, { disable: [2] }).toBytes(), 'devnet')
    await expect(respond({ uri: disabling, persona: testPersona() }, ports)).rejects.toThrow(/refusing to disable keys 2/)
    const master = new IdentityPublicKeyInCreation({
      keyId: 7,
      purpose: 'authentication',
      securityLevel: 'master',
      keyType: 'ecdsa_secp256k1',
      isReadOnly: false,
      data: secp256k1.getPublicKey(new Uint8Array(32).fill(0x33), true),
      signature: new Uint8Array(0),
    })
    const adding = buildYapprStateTransitionUri(unsignedUpdate(IDENTITY_ID, { add: [master] }).toBytes(), 'devnet')
    await expect(respond({ uri: adding, persona: testPersona() }, ports)).rejects.toThrow(/refusing to add keyId 7 \(AUTHENTICATION\/MASTER\)/)
    expect(broadcasts).toHaveLength(0)
  })

  it('refuses a k= signing key other than MASTER (spec §11.5)', async () => {
    const { ports, broadcasts } = capturingPorts()
    const uri = `${buildYapprStateTransitionUri(unsignedUpdate().toBytes(), 'devnet')}&k=2`
    await expect(respond({ uri, persona: testPersona() }, ports)).rejects.toThrow(/k=2/)
    expect(broadcasts).toHaveLength(0)
  })

  it('treats a nonce at or below the identity nonce as stale, on the sequence bits only', () => {
    expect(isStaleIdentityNonce(BigInt(1), BigInt(0))).toBe(false)
    expect(isStaleIdentityNonce(BigInt(3), BigInt(3))).toBe(true)
    expect(isStaleIdentityNonce(BigInt(2), BigInt(3))).toBe(true)
    // Upper 24 bits are the missing-revision bitset, not part of the sequence.
    expect(isStaleIdentityNonce(BigInt(4), (BigInt(1) << BigInt(40)) | BigInt(3))).toBe(false)
  })
})
