/**
 * dm.* over lib's real DM v5 registry (`getDmEngine` / `stopDmEngine` in
 * lib/services/dm-v5/index.ts), with only the chain adapter swapped for the
 * in-memory test chain: the engine for an identity comes from the stored
 * encryption key, a new key replaces it, and releasing the old one must
 * never stop its replacement.
 */
import bs58 from 'bs58'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ALICE_ID, ALICE_PRIV, CAROL_PRIV } from '@/lib/dm/test-fixtures'

vi.mock('@/lib/services/dm-v5/sdk-chain', async () => {
  const { MemoryChain, MemoryLedger } = await import('@/lib/services/dm-v5/test-chain')
  const ledger = new MemoryLedger()
  ledger.time = Date.now()
  return { SdkDmChain: class extends MemoryChain { constructor(me: Uint8Array) { super(ledger, me) } } }
})

// DM v5 on (read when lib/constants loads), then the WebView globals lib's registry needs.
process.env.NEXT_PUBLIC_DM_TOPOLOGY = 'v5'
process.env.NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID = bs58.encode(new Uint8Array(32).fill(7))
const { createEngineStorage, installEngineStorage } = await import('../../src/shims/storage')
installEngineStorage(createEngineStorage())
const events = new EventTarget()
Object.assign(globalThis, {
  window: globalThis,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
})
const { storeEncryptionKey } = await import('@/lib/secure-storage')
const { privateKeyToWif } = await import('@/lib/crypto/wif')
const { keyNetwork } = await import('@/lib/constants')
const { currentDmEngine } = await import('@/lib/services/dm-v5')
const { createDmModule } = await import('../../src/api/dm')
const { createTicketStore } = await import('../../src/writes/tickets')

const alice = bs58.encode(ALICE_ID)
const storage = new Map<string, string>()
const dm = createDmModule({
  emit: () => undefined,
  tickets: createTicketStore({
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) } },
    emit: () => undefined,
    currentIdentity: () => alice,
    documentExists: async () => true,
  }),
  backend: 'v5',
  viewer: () => alice,
  authors: async () => new Map(),
  coalesceMs: 0,
})

afterAll(() => dm.hooks.stop())

describe('dm over lib\'s DM v5 registry', () => {
  it('keeps the engine lib made for a new key, instead of stopping it and making another on every call', async () => {
    storeEncryptionKey(alice, privateKeyToWif(ALICE_PRIV, keyNetwork(), true))
    dm.hooks.sessionChanged({ session: { identityId: alice, network: 'testnet', username: null, credits: 0n, hasEncryptionKey: true, method: 'key' }, reason: 'signed-in' })
    const first = currentDmEngine(alice)
    expect(first).not.toBeNull()
    await vi.waitFor(async () => expect((await dm.api.status()).ready).toBe(true))

    // Another encryption key (as `dm.unlock` with a rotated key stores): lib replaces the engine.
    storeEncryptionKey(alice, privateKeyToWif(CAROL_PRIV, keyNetwork(), true))
    expect((await dm.api.status()).locked).toBe(false)
    const second = currentDmEngine(alice)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    // Releasing the old engine left the new one running: the next call keeps it.
    await dm.api.status()
    expect(currentDmEngine(alice)).toBe(second)

    await dm.hooks.stop()
    expect(currentDmEngine(alice)).toBeNull()
  })
})
