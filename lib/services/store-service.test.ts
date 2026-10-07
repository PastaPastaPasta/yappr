import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, query, updateDocument } = vi.hoisted(() => ({ get: vi.fn(), query: vi.fn(), updateDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get, query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }));
import { storeService } from './store-service';

const paymentUris = [{ scheme: 'dash:', uri: 'dash:Xabc', label: 'Main' }];
const contactMethods = [{ platform: 'email', handle: 'shop@example.com' }];
const raw = {
  $id: 'store', $ownerId: 'owner', $revision: 3, $createdAt: 1700000000000,
  name: 'Anvil', status: 'active', description: 'Coffee',
  paymentUris: JSON.stringify(paymentUris), contactMethods: JSON.stringify(contactMethods),
};

beforeEach(() => {
  storeService.clearCache();
  get.mockReset().mockResolvedValue(raw);
  query.mockReset().mockResolvedValue(new Map([['store', raw]]));
  updateDocument.mockReset().mockImplementation(async (_contract, _type, id, owner, data, revision) => ({
    success: true,
    document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data },
  }));
});

describe('store replacements re-encode the parsed JSON fields (docs/SOCIAL_V9.md TODO 20)', () => {
  it('an update that names neither re-sends paymentUris and contactMethods as JSON strings', async () => {
    await storeService.updateStore('store', 'owner', { description: 'Coffee and tea' });
    expect(updateDocument.mock.calls[0][4]).toMatchObject({
      description: 'Coffee and tea',
      paymentUris: JSON.stringify(paymentUris),
      contactMethods: JSON.stringify(contactMethods),
    });
  });

  it('removing every contact link writes an empty JSON list, not a parsed array', async () => {
    await storeService.updateStore('store', 'owner', { contactMethods: [] });
    const replacement = updateDocument.mock.calls[0][4];
    expect(replacement.contactMethods).toBe('[]');
    expect(replacement.paymentUris).toBe(JSON.stringify(paymentUris));
  });
});

describe('store edits can clear optional fields (QA D-10)', () => {
  it('a blanked description, location and logo leave the replacement', async () => {
    get.mockResolvedValue({ ...raw, location: 'Portland', logoUrl: 'https://example.com/logo.png' });
    await storeService.updateStore('store', 'owner', { name: 'Anvil', description: undefined, location: undefined, logoUrl: undefined });
    const replacement = updateDocument.mock.calls[0][4];
    expect(replacement).not.toHaveProperty('description');
    expect(replacement).not.toHaveProperty('location');
    expect(replacement).not.toHaveProperty('logoUrl');
    expect(replacement).toMatchObject({ name: 'Anvil', status: 'active', paymentUris: JSON.stringify(paymentUris) });
  });
});

describe('checkout reads the live store status past the cache (QA D-25)', () => {
  it('sees a store closed after checkout first loaded it', async () => {
    expect((await storeService.getById('store'))?.status).toBe('active');
    get.mockResolvedValue({ ...raw, status: 'closed' });
    query.mockResolvedValue(new Map([['store', { ...raw, status: 'closed' }]]));
    expect((await storeService.getById('store'))?.status).toBe('active');
    expect((await storeService.getCurrent('store'))?.status).toBe('closed');
  });

  it('a failed read throws instead of looking like a missing store', async () => {
    query.mockRejectedValue(new Error('offline'));
    await expect(storeService.getCurrent('store')).rejects.toThrow('offline');
  });
});

describe('newest active stores for discovery', () => {
  /** `total` stores in owner order, every third paused, created later as the id grows. */
  const stores = (total: number) => async ({ limit, startAfter }: { limit: number; startAfter?: string }) => {
    const first = startAfter ? Number(startAfter.slice(1)) + 1 : 0
    const docs = Array.from({ length: Math.max(0, Math.min(limit, total - first)) }, (_, i) => {
      const n = first + i
      return [`s${n}`, { $id: `s${n}`, $ownerId: `o${n}`, $createdAt: 1_000 + n, name: `Store ${n}`, status: n % 3 === 0 ? 'paused' : 'active' }] as const
    })
    return new Map(docs)
  }

  it('reads every store, keeps the active ones and returns the newest, a full page', async () => {
    query.mockReset().mockImplementation(stores(250))
    const { stores: newest, complete } = await storeService.getNewestActiveStores(50)
    expect(complete).toBe(true)
    expect(newest).toHaveLength(50)
    expect(newest.every(store => store.status === 'active')).toBe(true)
    // s249 is paused (every third), so the newest active store is s248.
    expect(newest[0].id).toBe('s248')
    expect(query.mock.calls[0][0]).toMatchObject({ orderBy: [['$ownerId', 'asc']], limit: 100 })
  })
})

describe('storefront v6: categories and indexed discovery', () => {
  const loadV6 = async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v6')
    const { storeService: service } = await import('./store-service')
    vi.unstubAllEnvs()
    return service
  }

  it('reads the newest active stores as ONE byStatus page, complete, no scan or status filter', async () => {
    const service = await loadV6()
    query.mockResolvedValue(new Map([['s1', { ...raw, $id: 's1', category: 'books' }]]))
    const { stores, complete } = await service.getNewestActiveStores(20)
    expect(complete).toBe(true)
    expect(stores.map((store) => [store.id, store.category])).toEqual([['s1', 'books']])
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toMatchObject({ where: [['status', '==', 'active']], orderBy: [['status', 'asc'], ['$createdAt', 'desc']], limit: 20 })
  })

  it('reads one category through byCategory', async () => {
    const service = await loadV6()
    query.mockResolvedValue(new Map())
    await service.getNewestActiveStoresInCategory('books', 10)
    expect(query.mock.calls[0][0]).toMatchObject({
      where: [['status', '==', 'active'], ['category', '==', 'books']],
      orderBy: [['status', 'asc'], ['category', 'asc'], ['$createdAt', 'desc']],
      limit: 10,
    })
  })

  it('keeps the category through an edit that does not name it', async () => {
    get.mockResolvedValue({ ...raw, category: 'books' })
    await storeService.updateStore('store', 'owner', { description: 'Rare books' })
    expect(updateDocument.mock.calls[0][4]).toMatchObject({ category: 'books', description: 'Rare books' })
  })
})
