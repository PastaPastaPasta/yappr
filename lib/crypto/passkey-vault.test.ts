import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import {
  BundleFormat,
  VaultCryptoError,
  decodeBundle,
  encodeBundle,
  entryAad,
  hpkeInfo,
  openEntry,
  prfInput,
  recipientFromPrf,
  sealEntry,
  type SealedVaultEntry,
  type VaultBundle,
  type VaultKey,
} from './passkey-vault'

/** Test inputs are sha256 of labels; "PRF output" stands in for a real authenticator. */
const H = (label: string) => sha256(new TextEncoder().encode(label))

const contractId = H('test vector: vault contract id')
const ownerId = H('test vector: owner identity id')

const AUTH_HIGH: VaultKey = { purpose: 0, securityLevel: 2, keyType: 0, keyId: 2, privateKey: H('test vector: HIGH auth key') }
const MESSAGING: VaultKey = { purpose: 1, securityLevel: 3, keyType: 0, keyId: 6, privateKey: H('test vector: encryption key') }

/**
 * The design's v1 vector (docs/PASSKEY_VAULT.md), from the independent
 * prototype: a raw-key bundle with a HIGH sign-in key and a messaging key.
 */
const RAW = {
  credentialId: '68822693f2d21d39673258a62fc08dbfbb38744f',
  prfInput: '79617070722f706173736b65792d7661756c742f76312f707266fa2bc2b200af11d4d4dd2729b60599127d5832f2ef3eb004c9309a3c2980fa00',
  prfOutput: '387bc63059d4cd29b909e6fc4624b6875f9363e5e51e1a966c3060b3dd3a49e8',
  recipientSk: '3fa5cbc53c1620e6f9978b89ef5b14ca1c758393aa47f998084a38199e1e90a1',
  recipientKey: 'f025f799ad8a214af13fb0e3ac29a51780deef4a2bf700181f3e787caa42d81a',
  ephemeralIkm: '30eddaf9393d591ec746b547b445832cec1ca31c42688488e95d577f9d929afe',
  info: '79617070722f706173736b65792d7661756c742f763100fa2bc2b200af11d4d4dd2729b60599127d5832f2ef3eb004c9309a3c2980fa006b768e30fd4ad6f04f750159a4344d4c596f086eef5516a0187cfc010ea16579',
  aad: '7661756c74456e74727900011468822693f2d21d39673258a62fc08dbfbb38744ff025f799ad8a214af13fb0e3ac29a51780deef4a2bf700181f3e787caa42d81a00000002',
  bundle: '010200020000000002819462ac0a37da9dbc59ae82ed7e308d489e828080b6f9f8151183bb7a1a756c01030000000006b64ad618cc6d0027175787a5d901b0d61cf3d6e3d92bed45875cffbcd0111265',
  enc: '7baf4e67c9b049608cd7f6a0c4b00f53dcfe4f5ab74bbedc5860d451aa282b06',
  sealed: 'e967f4c860290fcd0e701db258dc2256d448aa68184d9a96648c50b2e20bf59bbe089c1665d2086b3501016520ce572010ba81faa7e1134ff6f6958452dffea3b8645e13442f8b16da3bd2a6b36756e1846c63804a5c2fdbf8a62a7a186f640a',
}

/**
 * An App Connect key ring (format 2), computed with the prototype's HPKE and
 * a hand-built bundle: the CRITICAL group key, the DashPay profile key
 * (ECDSA_HASH160) and the anchor's encryption key.
 */
const RING = {
  credentialId: 'e2b9adaf79bb4b1982a17a143c4ea844cd8f329c524bc953c807e5e8430de348',
  prfOutput: 'f8449c57a6b3009084290a4a906cbea2af72781b4b3acfa37fcc157f2a912c2c',
  recipientKey: '59d33f0d132b5036f05cfd72262b784f403bc610611e6562a8a79da4760bc326',
  ephemeralIkm: 'a69a781cfc8bc13f019b6e56556ab67542dfa478d7008ee7a22bd547b3f2bd02',
  aad: '7661756c74456e747279000120e2b9adaf79bb4b1982a17a143c4ea844cd8f329c524bc953c807e5e8430de34859d33f0d132b5036f05cfd72262b784f403bc610611e6562a8a79da4760bc32600000007',
  bundle: '0203000100000000071daa6fb6c6d1be6e7c70a0cdfd7810b6f62ad4e04066bcc0dcf1750f7db6f7560002020000000853652d68e339fb2c0b5661e0489075259a3414d8e943832f9b1ded0b432584a701030000000009fcc1b65f8a7190fb5b26ecb4c397dd15ef9c7bcca4179b3f76e6047c00fe604f0000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  enc: 'e3574544df37f6dc5b18a3c384cbd59d7b8b073f2a001c3bcc25ac7a6e85d02d',
  sealed: 'ae9aa24062af9e21df934690960f7b542f7fb9c31091796490428add088821b1f14e7001dea399cc901cca5ca6af2f40da04686b5e3ebc1e7dd5b991b2fb31976f695576cc7c2481d1d5638bd3bad1221571306bb975f7ea5217083fe392cf3dd0289521be6ac8a70dd0c089be0b8a4c99fbfafa9682a12ccc691aa91909e3e0d66269d3fb7869abbb9e950bf26db118cb227274e938e9dee242ff04f231d4ee68464e5c983ca51dccab4e92f4c2a7db',
}

const RING_KEYS: VaultKey[] = [
  { purpose: 0, securityLevel: 1, keyType: 0, keyId: 7, privateKey: H('test vector: App Connect group key') },
  { purpose: 0, securityLevel: 2, keyType: 2, keyId: 8, privateKey: H('test vector: App Connect DashPay profile key') },
  { purpose: 1, securityLevel: 3, keyType: 0, keyId: 9, privateKey: H('test vector: App Connect anchor encryption key') },
]

const copyKeys = (keys: VaultKey[]) => keys.map((key) => ({ ...key, privateKey: key.privateKey.slice() }))
const rawBundle = (keys: VaultKey[] = [AUTH_HIGH, MESSAGING]): VaultBundle => ({ format: BundleFormat.RAW_KEY, keys: copyKeys(keys) })
const ringBundle = (keys: VaultKey[] = RING_KEYS): VaultBundle => ({ format: BundleFormat.KEY_RING, keys: copyKeys(keys) })

function sealRaw(): SealedVaultEntry {
  return sealEntry({
    contractId, ownerId,
    credentialId: hexToBytes(RAW.credentialId),
    recipientKey: hexToBytes(RAW.recipientKey),
    bundle: rawBundle(),
    ephemeralIkm: hexToBytes(RAW.ephemeralIkm),
  })
}

function open(entry: SealedVaultEntry, over: { prf?: Uint8Array; contract?: Uint8Array; owner?: Uint8Array } = {}) {
  return openEntry({ contractId: over.contract ?? contractId, ownerId: over.owner ?? ownerId, entry, prfOutput: over.prf ?? hexToBytes(RAW.prfOutput) })
}

const flip = (bytes: Uint8Array, index: number) => {
  const copy = bytes.slice()
  copy[index] ^= 1
  return copy
}

describe('passkey vault v1: raw-key vector', () => {
  it('builds the PRF input, recipient, info and aad', () => {
    expect(bytesToHex(prfInput(contractId))).toBe(RAW.prfInput)
    const recipient = recipientFromPrf(hexToBytes(RAW.prfOutput))
    expect(bytesToHex(recipient.privateKey)).toBe(RAW.recipientSk)
    expect(bytesToHex(recipient.publicKey)).toBe(RAW.recipientKey)
    expect(bytesToHex(hpkeInfo(contractId, ownerId))).toBe(RAW.info)
    expect(bytesToHex(entryAad({ version: 1, credentialId: hexToBytes(RAW.credentialId), recipientKey: hexToBytes(RAW.recipientKey), authKeyId: 2 }))).toBe(RAW.aad)
  })

  it('encodes the bundle and seals it to the vector', () => {
    expect(bytesToHex(encodeBundle(rawBundle()))).toBe(RAW.bundle)
    const entry = sealRaw()
    expect(entry.authKeyId).toBe(2)
    expect(bytesToHex(entry.enc)).toBe(RAW.enc)
    expect(bytesToHex(entry.sealed)).toBe(RAW.sealed)
  })

  it('opens the vector back to both keys', () => {
    const bundle = open(sealRaw())
    expect(bundle.format).toBe(BundleFormat.RAW_KEY)
    expect(bundle.keys.map((key) => key.keyId)).toEqual([2, 6])
    expect(bytesToHex(bundle.keys[0].privateKey)).toBe(bytesToHex(AUTH_HIGH.privateKey))
    expect(bytesToHex(bundle.keys[1].privateKey)).toBe(bytesToHex(MESSAGING.privateKey))
  })

  it('pads a one-key bundle to the same 96-byte ciphertext, freshly each time', () => {
    const seal = () => sealEntry({ contractId, ownerId, credentialId: hexToBytes(RAW.credentialId), recipientKey: hexToBytes(RAW.recipientKey), bundle: rawBundle([AUTH_HIGH]) })
    const a = seal()
    const b = seal()
    expect(a.sealed.length).toBe(96)
    expect(bytesToHex(a.sealed)).not.toBe(bytesToHex(b.sealed))
    expect(open(a).keys).toHaveLength(1)
  })
})

describe('passkey vault v1: App Connect key-ring vector', () => {
  it('encodes and seals the key ring to the vector', () => {
    expect(bytesToHex(encodeBundle(ringBundle()))).toBe(RING.bundle)
    expect(bytesToHex(entryAad({ version: 1, credentialId: hexToBytes(RING.credentialId), recipientKey: hexToBytes(RING.recipientKey), authKeyId: 7 }))).toBe(RING.aad)
    expect(bytesToHex(recipientFromPrf(hexToBytes(RING.prfOutput)).publicKey)).toBe(RING.recipientKey)
    const entry = sealEntry({ contractId, ownerId, credentialId: hexToBytes(RING.credentialId), recipientKey: hexToBytes(RING.recipientKey), bundle: ringBundle(), ephemeralIkm: hexToBytes(RING.ephemeralIkm) })
    expect(bytesToHex(entry.enc)).toBe(RING.enc)
    expect(bytesToHex(entry.sealed)).toBe(RING.sealed)
    expect(entry.sealed.length).toBe(176)
  })

  it('opens the vector back to the group, profile and encryption keys', () => {
    const entry = { version: 1, credentialId: hexToBytes(RING.credentialId), recipientKey: hexToBytes(RING.recipientKey), authKeyId: 7, enc: hexToBytes(RING.enc), sealed: hexToBytes(RING.sealed) }
    const bundle = open(entry, { prf: hexToBytes(RING.prfOutput) })
    expect(bundle.format).toBe(BundleFormat.KEY_RING)
    expect(bundle.keys.map((key) => [key.keyId, key.securityLevel, key.keyType])).toEqual([[7, 1, 0], [8, 2, 2], [9, 3, 0]])
  })
})

describe('passkey vault v1: refusals', () => {
  const entry = sealRaw()
  const expectRefused = (fn: () => unknown, message: RegExp) => expect(fn).toThrow(message)

  it('refuses another passkey before decrypting', () => {
    expectRefused(() => open(entry, { prf: H('another PRF output') }), /does not open this entry/)
  })

  it('fails the tag for another identity, contract, credential or key id', () => {
    expectRefused(() => open(entry, { owner: H('another owner') }), /does not decrypt/)
    expectRefused(() => open(entry, { contract: H('another contract') }), /does not decrypt/)
    expectRefused(() => open({ ...entry, credentialId: H('another credential').slice(0, 20) }), /does not decrypt/)
    expectRefused(() => open({ ...entry, authKeyId: 3 }), /does not decrypt/)
  })

  it('fails on a flipped ciphertext or encapsulated key', () => {
    expectRefused(() => open({ ...entry, sealed: flip(entry.sealed, 40) }), /does not decrypt/)
    expect(() => open({ ...entry, enc: flip(entry.enc, 5) })).toThrow(VaultCryptoError)
  })

  it('refuses an unknown entry version', () => {
    expectRefused(() => open({ ...entry, version: 2 }), /unknown entry version/)
  })

  it('never seals a MASTER or TRANSFER key, or a messaging key at another level', () => {
    expectRefused(() => encodeBundle(rawBundle([{ ...AUTH_HIGH, securityLevel: 0 }])), /may not be stored/)
    expectRefused(() => encodeBundle(rawBundle([{ ...AUTH_HIGH, purpose: 3, securityLevel: 1 }])), /slot 0/)
    expectRefused(() => encodeBundle(rawBundle([AUTH_HIGH, { ...MESSAGING, purpose: 3 }])), /may not be stored/)
    expectRefused(() => encodeBundle(rawBundle([AUTH_HIGH, { ...MESSAGING, securityLevel: 2 }])), /may not be stored/)
    expectRefused(() => encodeBundle(ringBundle([RING_KEYS[0], { ...RING_KEYS[1], securityLevel: 0 }])), /may not be stored/)
  })

  it('takes a CRITICAL sign-in key at the codec (the service allows it only for moderators)', () => {
    expect(open(sealEntry({ contractId, ownerId, credentialId: hexToBytes(RAW.credentialId), recipientKey: hexToBytes(RAW.recipientKey), bundle: rawBundle([{ ...AUTH_HIGH, securityLevel: 1 }]) })).keys[0].securityLevel).toBe(1)
  })

  it('keeps slot 0 the sign-in key, one sign-in key per raw bundle, no repeats, within the size', () => {
    expectRefused(() => encodeBundle(rawBundle([MESSAGING])), /slot 0/)
    expectRefused(() => encodeBundle(rawBundle([AUTH_HIGH, { ...AUTH_HIGH, keyId: 3 }])), /one sign-in key/)
    expectRefused(() => encodeBundle(rawBundle([AUTH_HIGH, { ...MESSAGING, keyId: 2 }])), /appears twice/)
    expectRefused(() => encodeBundle(rawBundle([AUTH_HIGH, MESSAGING, { ...MESSAGING, keyId: 9 }])), /1 to 2 keys/)
    expectRefused(() => encodeBundle(ringBundle([...RING_KEYS, { ...RING_KEYS[2], keyId: 10 }, { ...RING_KEYS[2], keyId: 11 }])), /1 to 4 keys/)
    expectRefused(() => encodeBundle(rawBundle([{ ...AUTH_HIGH, privateKey: new Uint8Array(31) }])), /32 bytes/)
    expectRefused(() => encodeBundle(rawBundle([AUTH_HIGH, { ...MESSAGING, purpose: 2 }])), /may not be stored/)
  })

  it('decodes nothing with a bad format, padding or slot 0', () => {
    const bundle = encodeBundle(rawBundle())
    expectRefused(() => decodeBundle(bundle, 6), /slot 0 is not/)
    // A two-key raw bundle fills its 80 bytes; a one-key bundle has 39 bytes of padding.
    expectRefused(() => decodeBundle(flip(encodeBundle(rawBundle([AUTH_HIGH])), 79), 2), /padding/)
    const relabelled = bundle.slice()
    relabelled[0] = 9
    expectRefused(() => decodeBundle(relabelled, 2), /unknown bundle format/)
    expectRefused(() => decodeBundle(bundle.slice(0, 79), 2), /unknown bundle format/)
  })

  it('opens a forged bundle sealed to the right recipient: only the chain check can refuse it', () => {
    // Anyone can encrypt to a public recipient key, so an opened bundle proves nothing on its own.
    const forged = sealEntry({ contractId, ownerId, credentialId: hexToBytes(RAW.credentialId), recipientKey: hexToBytes(RAW.recipientKey), bundle: rawBundle([{ ...AUTH_HIGH, privateKey: H('attacker key') }]) })
    expect(bytesToHex(open(forged).keys[0].privateKey)).toBe(bytesToHex(H('attacker key')))
  })

  it('refuses a credential id outside 16 to 255 bytes', () => {
    expectRefused(() => entryAad({ version: 1, credentialId: new Uint8Array(15), recipientKey: new Uint8Array(32), authKeyId: 1 }), /16 to 255/)
    expectRefused(() => entryAad({ version: 1, credentialId: new Uint8Array(256), recipientKey: new Uint8Array(32), authKeyId: 1 }), /16 to 255/)
  })
})
