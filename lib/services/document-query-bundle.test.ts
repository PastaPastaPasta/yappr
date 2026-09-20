import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), composite: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: mocks }) }));
const queries = Array.from({ length: 13 }, (_, index) => ({
  dataContractId: 'contract', documentTypeName: `source${index}`, limit: index + 1,
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v8');
  mocks.query.mockResolvedValue(new Map());
  mocks.composite.mockImplementation(async query => ({
    pageDocuments: [], subResults: query.subQueries.map(() => ({ kind: 'documents', documents: [] })),
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe('explicit document query bundles', () => {
  it('keeps independent page budgets and nonempty siblings when the root is empty', async () => {
    const doc = { $id: 'reply1234', $ownerId: 'owner1234', content: 'reply' };
    mocks.composite.mockResolvedValue({ pageDocuments: [], subResults: [{ kind: 'documents', documents: [doc] }] });
    const { queryDocumentBundle } = await import('./document-query-bundle');
    const result = await queryDocumentBundle(queries.slice(0, 2));
    expect(result).toEqual([[], [doc]]);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.composite.mock.calls[0][0]).toMatchObject({ limit: 1, subQueries: [{ limit: 2 }] });
  });

  it('chunks above ten siblings without changing result positions', async () => {
    const { queryDocumentBundle } = await import('./document-query-bundle');
    const result = await queryDocumentBundle(queries);
    expect(result).toHaveLength(13);
    expect(mocks.composite).toHaveBeenCalledTimes(2);
    expect(mocks.composite.mock.calls.map(([query]) => query.subQueries.length)).toEqual([10, 1]);
  });

  it('discards an incomplete proof and recovers independent members', async () => {
    mocks.composite.mockResolvedValue({ pageDocuments: [{ $id: 'unverified' }], subResults: [] });
    mocks.query.mockRejectedValueOnce(new Error('one unavailable')).mockResolvedValueOnce(new Map([
      ['good', { $id: 'good', content: 'still available' }],
    ]));
    const { queryDocumentBundle } = await import('./document-query-bundle');
    expect(await queryDocumentBundle(queries.slice(0, 2), true)).toEqual([[], [{ $id: 'good', content: 'still available' }]]);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('does not let failed identity reads masquerade as proven absence', async () => {
    mocks.composite.mockRejectedValue(new Error('bad proof'));
    mocks.query.mockRejectedValue(new Error('offline'));
    const { queryDocumentBundle } = await import('./document-query-bundle');
    await expect(queryDocumentBundle(queries.slice(0, 2))).rejects.toThrow('offline');
  });

  it('keeps cursors on ordinary queries and does not probe legacy deployments', async () => {
    const { queryDocumentBundle } = await import('./document-query-bundle');
    await queryDocumentBundle([{ ...queries[0], startAfter: 'cursor123' }, queries[1]]);
    expect(mocks.query.mock.calls[0][0].startAfter).toBe('cursor123');
    expect(mocks.composite).not.toHaveBeenCalled();
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v2');
    const legacy = await import('./document-query-bundle');
    await legacy.queryDocumentBundle(queries.slice(0, 2));
    expect(mocks.composite).not.toHaveBeenCalled();
  });
});
