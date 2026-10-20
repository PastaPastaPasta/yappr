import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: sdk }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }));
import { BaseDocumentService } from './document-service';

class DocumentService extends BaseDocumentService<{ id: string }> {
  constructor() { super('document', 'contract'); }
  transformDocument(doc: Record<string, unknown>) { return { id: String(doc.$id) }; }
}

beforeEach(() => {
  sdk.query.mockReset();
  sdk.get.mockReset();
});

describe('strict document hydration', () => {
  it('exposes single-document read failures without caching them as missing', async () => {
    const service = new DocumentService();
    sdk.get.mockRejectedValueOnce(new Error('DAPI unavailable')).mockResolvedValueOnce({ $id: 'post' });
    await expect(service.getOrThrow('post')).rejects.toThrow('DAPI unavailable');
    await expect(service.getOrThrow('post')).resolves.toEqual({ id: 'post' });
    expect(sdk.get).toHaveBeenCalledTimes(2);
  });

  it('returns null for a successful single-document absence proof', async () => {
    sdk.get.mockResolvedValue(null);
    await expect(new DocumentService().getOrThrow('missing')).resolves.toBeNull();
  });

  it('retries a failed batch with individual reads and preserves proven absence', async () => {
    sdk.query.mockRejectedValue(new Error('batch offline'));
    sdk.get.mockImplementation(async (_contract, _type, id) => id === 'missing' ? null : { $id: id });
    expect(await new DocumentService().getMany(['found', 'missing'], { throwOnError: true })).toEqual([{ id: 'found' }]);
    expect(sdk.get).toHaveBeenCalledTimes(2);
  });

  it('rejects partial individual failures and retries failed ids after recovery', async () => {
    const service = new DocumentService();
    sdk.query.mockRejectedValue(new Error('batch offline'));
    sdk.get.mockImplementation(async (_contract, _type, id) => {
      if (id === 'offline') throw new Error('individual offline');
      return { $id: id };
    });
    await expect(service.getMany(['found', 'offline'], { throwOnError: true })).rejects.toThrow('individual offline');
    sdk.query.mockResolvedValue(new Map([['offline', { $id: 'offline' }]]));
    expect(await service.getMany(['found', 'offline'], { throwOnError: true })).toHaveLength(2);
    expect(sdk.query.mock.calls[1][0].where).toEqual([['$id', 'in', ['offline']]]);
  });

  it('keeps the default fail-soft behavior for other callers', async () => {
    sdk.query.mockRejectedValue(new Error('batch offline'));
    sdk.get.mockRejectedValue(new Error('individual offline'));
    expect(await new DocumentService().getMany(['offline'])).toEqual([]);
  });

  it('does not cache a late batch after a sibling failure ended the read fence', async () => {
    const service = new DocumentService();
    const transformed = vi.spyOn(service, 'transformDocument');
    let finishBatch: (docs: Map<string, Record<string, unknown>>) => void = () => undefined;
    const pending = new Promise<Map<string, Record<string, unknown>>>((resolve) => { finishBatch = resolve; });
    sdk.query.mockRejectedValueOnce(new Error('batch offline')).mockReturnValueOnce(pending).mockResolvedValue(new Map());
    sdk.get.mockRejectedValue(new Error('individual offline'));
    const ids = [...Array.from({ length: 100 }, (_, i) => `offline-${i}`), 'last'];
    await expect(service.getMany(ids, { throwOnError: true })).rejects.toThrow('individual offline');
    service.clearCache('last');
    finishBatch(new Map([['last', { $id: 'last' }]]));
    await vi.waitFor(() => expect(transformed).toHaveBeenCalledWith({ $id: 'last' }));
    expect(await service.getMany(['last'], { throwOnError: true })).toEqual([]);
    expect(sdk.query).toHaveBeenCalledTimes(3);
  });

  it('reads by-id lookups asked for together as one $id-in query, keeping proven absence', async () => {
    const service = new DocumentService();
    sdk.query.mockResolvedValue(new Map([['a', { $id: 'a' }], ['b', { $id: 'b' }]]));
    const reads = await Promise.all([service.getOrThrow('a'), service.getOrThrow('b'), service.getOrThrow('a'), service.getOrThrow('gone')]);
    expect(reads).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'a' }, null]);
    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(sdk.query.mock.calls[0][0]).toMatchObject({ where: [['$id', 'in', ['a', 'b', 'gone']]], limit: 3 });
    expect(sdk.get).not.toHaveBeenCalled();
    // Found documents are cached like single reads.
    await expect(service.getOrThrow('b')).resolves.toEqual({ id: 'b' });
    expect(sdk.query).toHaveBeenCalledTimes(1);
  });

  it('falls back to by-id reads when a coalesced read fails, so each caller gets its own answer', async () => {
    const service = new DocumentService();
    sdk.query.mockRejectedValue(new Error('batch offline'));
    sdk.get.mockImplementation(async (_contract, _type, id) => {
      if (id === 'offline') throw new Error('individual offline');
      return id === 'missing' ? null : { $id: id };
    });
    const [found, missing, offline] = await Promise.allSettled([service.getOrThrow('found'), service.getOrThrow('missing'), service.getOrThrow('offline')]);
    expect(found).toEqual({ status: 'fulfilled', value: { id: 'found' } });
    expect(missing).toEqual({ status: 'fulfilled', value: null });
    expect(offline).toMatchObject({ status: 'rejected', reason: new Error('individual offline') });
    expect(sdk.get).toHaveBeenCalledTimes(3);
  });

  it('starts a new read for a refresh made while an invalidated batch is still out', async () => {
    class VersionedService extends BaseDocumentService<{ id: string; version: unknown }> {
      constructor() { super('document', 'contract'); }
      transformDocument(doc: Record<string, unknown>) { return { id: String(doc.$id), version: doc.version }; }
    }
    const service = new VersionedService();
    let finishOld: (docs: Map<string, Record<string, unknown>>) => void = () => undefined;
    sdk.query.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
    const old = Promise.all([service.getOrThrow('a'), service.getOrThrow('b')]);
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1));

    // `a` changes elsewhere; the refresh must not join the batch already out.
    service.clearCache('a');
    sdk.get.mockResolvedValueOnce({ $id: 'a', version: 'new' });
    const refreshed = service.getOrThrow('a');
    await vi.waitFor(() => expect(sdk.get).toHaveBeenCalledTimes(1));
    expect(await refreshed).toEqual({ id: 'a', version: 'new' });

    // The old batch lands late with the stale copy: it answers its own callers only.
    finishOld(new Map([['a', { $id: 'a', version: 'old' }], ['b', { $id: 'b', version: 'old' }]]));
    expect((await old)[0]).toEqual({ id: 'a', version: 'old' });
    sdk.get.mockClear();
    await expect(service.getOrThrow('a')).resolves.toEqual({ id: 'a', version: 'new' });
    expect(sdk.get).not.toHaveBeenCalled();
    expect(sdk.query).toHaveBeenCalledTimes(1);
  });

  it('does not cache a coalesced read its document was invalidated during', async () => {
    const service = new DocumentService();
    let finish: (docs: Map<string, Record<string, unknown>>) => void = () => undefined;
    sdk.query.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const reads = Promise.all([service.getOrThrow('a'), service.getOrThrow('b')]);
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1));
    service.clearCache('a');
    finish(new Map([['a', { $id: 'a' }], ['b', { $id: 'b' }]]));
    expect(await reads).toEqual([{ id: 'a' }, { id: 'b' }]);
    sdk.get.mockResolvedValueOnce(null);
    await expect(service.getOrThrow('a')).resolves.toBeNull();
    await expect(service.getOrThrow('b')).resolves.toEqual({ id: 'b' });
    expect(sdk.get).toHaveBeenCalledTimes(1);
  });

  it('does not turn a successful missing-document response into a failure', async () => {
    sdk.query.mockResolvedValue(new Map());
    expect(await new DocumentService().getMany(['missing'], { throwOnError: true })).toEqual([]);
    expect(sdk.get).not.toHaveBeenCalled();
  });
});
