/**
 * `dm.unlock` with a typed key (PRD DM-02) on an identity that holds two
 * ENCRYPTION keys: only the one messages use (`findEncryptionKey`, the one
 * peers encrypt to) may unlock them (SR-07).
 */
import bs58 from 'bs58'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToHex } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { ALICE_ID, ALICE_PRIV, BOB_PRIV } from '@/lib/dm/test-fixtures'

const alice = bs58.encode(ALICE_ID)

/** Alice's identity: an auth key, then two encryption keys (ids 4 and 5). */
const identity = vi.hoisted(() => ({ publicKeys: [] as unknown[] }))
vi.mock('@/lib/services/identity-service', async (load) => {
  const actual = await load<typeof import('@/lib/services/identity-service')>()
  const getIdentity = async (id: string) => ({ id, balance: 0, revision: 1, publicKeys: identity.publicKeys })
  return { ...actual, identityService: Object.assign(Object.create(actual.identityService), { getIdentity }) }
})

// Node has no browser secret store: record what would be stored.
const storeEncryptionKey = vi.hoisted(() => vi.fn())
vi.mock('@/lib/secure-storage', async (load) => ({ ...await load<object>(), storeEncryptionKey }))

const { createEngineStorage, installEngineStorage } = await import('../../src/shims/storage')
installEngineStorage(createEngineStorage())
const { createDmModule } = await import('../../src/api/dm')
const { createTicketStore } = await import('../../src/writes/tickets')

const encryptionKey = (id: number, priv: Uint8Array) => ({ id, purpose: 1, type: 0, securityLevel: 2, data: getPublicKey(priv) })
identity.publicKeys = [
  { id: 0, purpose: 0, type: 0, securityLevel: 0, data: getPublicKey(BOB_PRIV.map(b => b ^ 1)) },
  encryptionKey(4, ALICE_PRIV),
  encryptionKey(5, BOB_PRIV),
]

function unlocker() {
  const storage = { getItem: () => null, setItem: () => undefined }
  const tickets = createTicketStore({ storage, emit: () => undefined, currentIdentity: () => alice, documentExists: async () => true })
  const dm = createDmModule({
    emit: () => undefined,
    tickets,
    backend: 'v5',
    v5Source: { engineFor: () => null, release: () => undefined },
    viewer: () => alice,
  })
  return dm.api
}

describe('dm.unlock with a typed key on an identity with two encryption keys', () => {
  beforeEach(() => storeEncryptionKey.mockClear())

  it('refuses the key messages do not use, and stores nothing', async () => {
    const dm = unlocker()
    await expect(dm.unlock({ key: bytesToHex(BOB_PRIV) })).rejects.toMatchObject({ code: 'KEY_INVALID', message: expect.stringContaining('key 4') })
    expect(storeEncryptionKey).not.toHaveBeenCalled()
  })

  it('unlocks with the key messages use', async () => {
    const dm = unlocker()
    expect(await dm.unlock({ key: bytesToHex(ALICE_PRIV) })).toMatchObject({ unlocked: true })
    expect(storeEncryptionKey).toHaveBeenCalledWith(alice, bytesToHex(ALICE_PRIV))
  })
})
