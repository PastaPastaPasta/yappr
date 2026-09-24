import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), deleteDocument: vi.fn(), updateDocument: vi.fn(), createDocument: vi.fn(),
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: mocks.query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: mocks }));
vi.mock('./identity-service', () => ({ identityService: {} }));
import { privateFeedService } from './private-feed-service';
import { privateFeedKeyStore } from './private-feed-key-store';

const ownerId = '9NFhqxW8upkFMVTE5h5VmYWLdSEJ26B2iMKdhCFgsWkd';
const state = {
  $id: 'state', $ownerId: ownerId, $createdAt: 1,
  treeCapacity: 1024, maxEpoch: 2000, encryptedSeed: new Uint8Array(1),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(privateFeedService, 'getPrivateFeedState').mockResolvedValue(state);
  mocks.query.mockImplementation(async ({ documentTypeName }: { documentTypeName: string }) => new Map([
    ['document', documentTypeName === 'privateFeedState' ? state : { $id: documentTypeName }],
  ]));
  mocks.deleteDocument.mockResolvedValue({ success: true });
  mocks.updateDocument.mockResolvedValue({ success: false, error: 'Private feed state is immutable' });
});

afterEach(() => vi.restoreAllMocks());

describe('unsupported private feed reset', () => {
  it('refuses before deleting grants/rekeys, replacing state, or clearing local keys', async () => {
    const clearKeys = vi.spyOn(privateFeedKeyStore, 'clearOwnerKeys');
    const initialize = vi.spyOn(privateFeedKeyStore, 'initializeOwnerState');
    const cacheKey = vi.spyOn(privateFeedKeyStore, 'storeCachedCEK');

    const result = await privateFeedService.resetPrivateFeed();

    expect(result.success).toBe(false);
    expect(result.error).toContain('reset is unavailable');
    expect(result.error).toContain('original encryption key');
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
    expect(mocks.updateDocument).not.toHaveBeenCalled();
    expect(mocks.createDocument).not.toHaveBeenCalled();
    expect(clearKeys).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(cacheKey).not.toHaveBeenCalled();
  });
});
