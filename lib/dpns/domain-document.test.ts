/**
 * The preorder and domain Yappr builds, as real wasm Documents against the DPNS
 * contract (its v1 document schemas, copied from dashpay/platform
 * packages/dpns-contract/schema/v1 at v5.0.0-rc.4 into fixtures/): they
 * serialize under the contract's types (`records.identity` a 32-byte
 * identifier, `preorderSalt` and `saltedDomainHash` 32 bytes), and a signed
 * domain create carrying its contest fund decodes and re-encodes byte for byte.
 * Offline: no network, no chain writes.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BatchTransition,
  DataContract,
  Document,
  DocumentCreateTransition,
  IdentityPublicKey,
  PlatformVersion,
  PrefundedVotingBalance,
  PrivateKey,
  StateTransition,
  ensureInitialized,
} from '@dashevo/evo-sdk'
import bs58 from 'bs58'
import { bytesToHex } from '@/lib/bytes'
import { buildSignedCreateTransition } from '@/lib/manual-batch'
import documentSchemas from './fixtures/dpns-contract-documents-v1.json'
import { saltedDomainHash } from './registration-journal'

vi.mock('@/lib/services/evo-sdk-service', () => ({ getEvoSdk: async () => ({}) }))
const { documentBuilderService } = await import('@/lib/services/document-builder-service')
const { domainDocumentData } = await import('@/lib/services/dpns-registration')

const DPNS = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'
const OWNER = bs58.encode(new Uint8Array(32).fill(2))
const PRIVATE_KEY_HEX = '0101010101010101010101010101010101010101010101010101010101010101'
const SALT = new Uint8Array(32).map((_, i) => i + 1)

let contract: DataContract
beforeAll(async () => {
  await ensureInitialized()
  contract = DataContract.fromJSON({
    $formatVersion: '1',
    id: DPNS,
    ownerId: '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF',
    version: 1,
    config: {
      $formatVersion: '1',
      canBeDeleted: false,
      readonly: false,
      keepsHistory: false,
      documentsKeepHistoryContractDefault: false,
      documentsMutableContractDefault: true,
      documentsCanBeDeletedContractDefault: true,
      requiresIdentityEncryptionBoundedKey: null,
      requiresIdentityDecryptionBoundedKey: null,
      sizedIntegerTypes: true,
    },
    documentSchemas,
    schemaDefs: null,
    groups: {},
    tokens: {},
    keywords: [],
    description: null,
  } as never, true, PlatformVersion.latest())
})

const build = (type: 'preorder' | 'domain', data: Record<string, unknown>) =>
  documentBuilderService.buildDocumentForCreate(DPNS, type, OWNER, data, { entropy: new Uint8Array(32).fill(7), identityContractNonce: 3n })

/** A domain with the timestamps its type requires (Drive sets them at execution), so it serializes. */
async function storedDomain(data: Record<string, unknown>) {
  const document = await build('domain', data)
  document.createdAt = 1n
  document.updatedAt = 1n
  document.transferredAt = 1n
  return document
}

describe('the DPNS documents Yappr builds', () => {
  it('serializes a preorder under the contract, its 32-byte salted hash written whole', async () => {
    const hash = saltedDomainHash(SALT, 'a11ce')
    const bytes = (await build('preorder', { saltedDomainHash: hash })).toBytes(contract, PlatformVersion.latest())
    // The hash is the type's only property: the stored bytes end with it, unprefixed (a fixed 32).
    expect(bytesToHex(bytes).endsWith(bytesToHex(hash))).toBe(true)
  })

  it('serializes a domain under the contract, records.identity reading back as the owner', async () => {
    const domain = await storedDomain(domainDocumentData('Alice', 'a11ce', OWNER, SALT))
    const bytes = domain.toBytes(contract, PlatformVersion.latest())
    const back = Document.fromBytes(bytes, contract, 'domain', PlatformVersion.latest()).toObject() as Record<string, unknown>
    expect(back).toMatchObject({ label: 'Alice', normalizedLabel: 'a11ce', parentDomainName: 'dash', normalizedParentDomainName: 'dash', subdomainRules: { allowSubdomains: false } })
    expect(bs58.encode((back.records as { identity: Uint8Array }).identity)).toBe(OWNER)
    expect(bytesToHex(back.preorderSalt as Uint8Array)).toBe(bytesToHex(SALT))
  })

  it('signs a contested domain create that carries its fund and round-trips exactly', async () => {
    const privateKey = PrivateKey.fromHex(PRIVATE_KEY_HEX, 'testnet')
    const signed = buildSignedCreateTransition({
      document: await build('domain', domainDocumentData('Alice', 'a11ce', OWNER, SALT)),
      ownerId: OWNER,
      identityContractNonce: 3n,
      prefundedVotingBalance: new PrefundedVotingBalance({ indexName: 'parentNameAndLabel', credits: 10_000_000_000n }),
      privateKey,
      identityKey: new IdentityPublicKey({ keyId: 1, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_secp256k1', data: privateKey.getPublicKey().toBytes() }),
    })
    const bytes = signed.toBytes()
    expect(bytesToHex(StateTransition.fromBytes(bytes).toBytes())).toBe(bytesToHex(bytes))
    const [batched] = BatchTransition.fromStateTransition(StateTransition.fromBytes(bytes)).transitions
    const create = DocumentCreateTransition.fromDocumentTransition(batched.toTransition() as never)
    expect(create.prefundedVotingBalance?.credits).toBe(10_000_000_000n)
    // The salt goes out with the domain: what Drive hashes to find the preorder.
    expect(JSON.stringify(BatchTransition.fromStateTransition(StateTransition.fromBytes(bytes)).toJSON())).toContain('preorderSalt')
  })
})
