/**
 * The preorder and domain Yappr builds, as real wasm Documents against the DPNS
 * contract the network runs: v1 (protocol 14, mainnet; schemas copied from
 * dashpay/platform packages/dpns-contract/schema/v1 at v5.0.0-rc.4) and v3
 * (protocol 15, testnet; schema/v3 at v5.1.0), both in fixtures/. Each
 * serializes under the contract's types (`records.identity` a 32-byte
 * identifier, the preorder's hashes and v1's `preorderSalt` 32 bytes), the
 * preorder carries the fields its contract declares, and a signed domain
 * create carrying its contest fund decodes and re-encodes byte for byte.
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
import v1Schemas from './fixtures/dpns-contract-documents-v1.json'
import v3Schemas from './fixtures/dpns-contract-documents-v3.json'
import { preorderNameHash, preorderOwnerNameHash, saltedDomainHash } from './registration-journal'

const network = vi.hoisted(() => ({ version: 14 }))
vi.mock('@/lib/services/evo-sdk-service', () => ({ getEvoSdk: async () => ({ version: () => network.version }) }))
const { documentBuilderService } = await import('@/lib/services/document-builder-service')
const { domainDocumentData, dpnsPreorderLayout, preorderDocumentData } = await import('@/lib/services/dpns-registration')

const DPNS = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'
const OWNER_BYTES = new Uint8Array(32).fill(2)
const OWNER = bs58.encode(OWNER_BYTES)
const PRIVATE_KEY_HEX = '0101010101010101010101010101010101010101010101010101010101010101'
const SALT = new Uint8Array(32).map((_, i) => i + 1)

const contractAt = (documentSchemas: unknown, version: number) => DataContract.fromJSON({
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
} as never, true, new PlatformVersion(version))

const build = (type: 'preorder' | 'domain', data: Record<string, unknown>) =>
  documentBuilderService.buildDocumentForCreate(DPNS, type, OWNER, data, { entropy: new Uint8Array(32).fill(7), identityContractNonce: 3n })

const SYSTEM_FIELDS = { $createdAt: 'createdAt', $updatedAt: 'updatedAt', $transferredAt: 'transferredAt', $createdAtBlockHeight: 'createdAtBlockHeight' } as const

/** A document with the system fields its type requires (Drive sets them at execution), so it serializes. */
async function stored(schemas: Record<string, { required: string[] }>, type: 'preorder' | 'domain', data: Record<string, unknown>) {
  const document = await build(type, data)
  for (const field of schemas[type].required) {
    if (field in SYSTEM_FIELDS) document[SYSTEM_FIELDS[field as keyof typeof SYSTEM_FIELDS]] = 1n
  }
  return document
}

beforeAll(async () => {
  await ensureInitialized()
})

describe.each([
  { name: 'DPNS v1 (protocol 14)', version: 14, schemas: v1Schemas },
  { name: 'DPNS v3 (protocol 15)', version: 15, schemas: v3Schemas },
])('the DPNS documents Yappr builds: $name', ({ version, schemas }) => {
  let contract: DataContract
  const platformVersion = () => new PlatformVersion(version)
  const layout = dpnsPreorderLayout(schemas)
  beforeAll(() => {
    network.version = version
    contract = contractAt(schemas, version)
  })

  it('picks the preorder fields the contract declares', () => {
    const data = preorderDocumentData(layout, OWNER, 'a11ce', SALT)
    if (version === 14) {
      expect(layout).toEqual({ scheme: 'salted' })
      expect(data).toEqual({ saltedDomainHash: saltedDomainHash(SALT, 'a11ce') })
    } else {
      expect(layout).toEqual({ scheme: 'nameHash', ttlSeconds: 3600 })
      expect(data).toEqual({ nameHash: preorderNameHash('a11ce'), ownerNameHash: preorderOwnerNameHash(OWNER_BYTES, 'a11ce') })
    }
    expect(Object.keys(data).sort()).toEqual(Object.keys(schemas.preorder.properties).sort())
  })

  it('serializes the preorder under the contract, its hashes written whole', async () => {
    const data = preorderDocumentData(layout, OWNER, 'a11ce', SALT)
    const bytes = (await stored(schemas, 'preorder', data)).toBytes(contract, platformVersion())
    // The hashes are the type's only properties: the stored bytes end with them, in position order, unprefixed (a fixed 32).
    const properties = schemas.preorder.properties as Record<string, { position: number }>
    const inOrder = Object.keys(data).sort((a, b) => properties[a].position - properties[b].position)
    expect(bytesToHex(bytes).endsWith(inOrder.map((field) => bytesToHex(data[field])).join(''))).toBe(true)
  })

  it('serializes a domain under the contract, records.identity reading back as the owner', async () => {
    const domain = await stored(schemas, 'domain', domainDocumentData('Alice', 'a11ce', OWNER, layout, SALT))
    const bytes = domain.toBytes(contract, platformVersion())
    const back = Document.fromBytes(bytes, contract, 'domain', platformVersion()).toObject() as Record<string, unknown>
    expect(back).toMatchObject({ label: 'Alice', normalizedLabel: 'a11ce', parentDomainName: 'dash', normalizedParentDomainName: 'dash', subdomainRules: { allowSubdomains: false } })
    expect(bs58.encode((back.records as { identity: Uint8Array }).identity)).toBe(OWNER)
    if (version === 14) expect(bytesToHex(back.preorderSalt as Uint8Array)).toBe(bytesToHex(SALT))
    else expect(back.preorderSalt).toBeUndefined()
  })

  it('signs a contested domain create that carries its fund as the cap and round-trips exactly', async () => {
    const privateKey = PrivateKey.fromHex(PRIVATE_KEY_HEX, 'testnet')
    const signed = buildSignedCreateTransition({
      document: await build('domain', domainDocumentData('Alice', 'a11ce', OWNER, layout, SALT)),
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
    // Before v3 the salt goes out with the domain (what Drive hashes to find the preorder); from v3 it doesn't.
    expect(JSON.stringify(BatchTransition.fromStateTransition(StateTransition.fromBytes(bytes)).toJSON()).includes('preorderSalt')).toBe(version === 14)
  })
})

describe('dpnsPreorderLayout', () => {
  it('refuses a contract whose preorder it cannot build', () => {
    expect(() => dpnsPreorderLayout({ preorder: { properties: { somethingElse: {} } } })).toThrow()
  })
})
