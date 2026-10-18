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

  it('does not turn a successful missing-document response into a failure', async () => {
    sdk.query.mockResolvedValue(new Map());
    expect(await new DocumentService().getMany(['missing'], { throwOnError: true })).toEqual([]);
    expect(sdk.get).not.toHaveBeenCalled();
  });
});
