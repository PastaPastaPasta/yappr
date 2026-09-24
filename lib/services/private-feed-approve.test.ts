import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), createDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: mocks.query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument: mocks.createDocument } }));
vi.mock('./identity-service', () => ({ identityService: {} }));
import { referencedPathFromError } from '@/lib/error-utils';

const ownerId = '9NFhqxW8upkFMVTE5h5VmYWLdSEJ26B2iMKdhCFgsWkd';
const requesterId = 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe';
const requesterKey = new Uint8Array(33).fill(2);

/** Every query answers `docs` for followRequest, nothing for anything else. */
function requestOnChain(present: boolean) {
  mocks.query.mockImplementation(async ({ documentTypeName }: { documentTypeName: string }) =>
    new Map(present && documentTypeName === 'followRequest' ? [['request', { $id: 'request', $ownerId: requesterId }]] : []));
}

/**
 * Stubs the key store, crypto and chain reads on the module instances `load()`
 * returns. A topology change needs a fresh module registry, and spies set on
 * the previous registry's singletons would not reach the fresh service, which
 * then fails before the grant write, so every case builds its own.
 */
async function load(topology: string) {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology);
  vi.resetModules();
  const service = await import('./private-feed-service');
  const { privateFeedKeyStore: keyStore } = await import('./private-feed-key-store');
  const { privateFeedCryptoService: crypto } = await import('./private-feed-crypto-service');
  vi.spyOn(keyStore, 'getFeedSeed').mockReturnValue(new Uint8Array(32).fill(7));
  vi.spyOn(keyStore, 'getCurrentEpoch').mockReturnValue(1);
  vi.spyOn(keyStore, 'getAvailableLeaves').mockReturnValue([0, 1]);
  vi.spyOn(keyStore, 'getRevokedLeaves').mockReturnValue([]);
  vi.spyOn(keyStore, 'getCachedCEK').mockReturnValue({ epoch: 1, cek: new Uint8Array(32).fill(3) });
  vi.spyOn(keyStore, 'storeAvailableLeaves').mockImplementation(() => undefined);
  vi.spyOn(keyStore, 'getRecipientMap').mockReturnValue({});
  vi.spyOn(keyStore, 'storeRecipientMap').mockImplementation(() => undefined);
  vi.spyOn(service.privateFeedService, 'getLatestEpoch').mockResolvedValue(1);
  vi.spyOn(service.privateFeedService, 'getPrivateFollowers').mockResolvedValue([]);
  vi.spyOn(crypto, 'eciesEncrypt').mockResolvedValue(new Uint8Array(96));
  return service;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('approving a follower on the v9 gated contract', () => {
  it('refuses before any key work when the request was withdrawn', async () => {
    const { privateFeedService: service } = await load('v9');
    requestOnChain(false);
    const result = await service.approveFollower(ownerId, requesterId, requesterKey);
    expect(result).toMatchObject({ success: false, errorCode: 'REQUEST_WITHDRAWN' });
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('maps a 40120 on recipientId (the request vanished mid-approval) to "request withdrawn"', async () => {
    const { privateFeedService, REQUEST_WITHDRAWN_MESSAGE } = await load('v9');
    requestOnChain(true);
    mocks.createDocument.mockResolvedValue({
      success: false,
      error: 'referenced document 7xB… not found for path recipientId (code=40120)',
    });
    const result = await privateFeedService.approveFollower(ownerId, requesterId, requesterKey);
    // The grant WAS attempted (the pre-check saw the request): the mapping is of its refusal.
    expect(mocks.createDocument).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: false, error: REQUEST_WITHDRAWN_MESSAGE, errorCode: 'REQUEST_WITHDRAWN' });
  });

  it('maps a 40120 on $ownerId to "enable your private feed first"', async () => {
    const { privateFeedService } = await load('v9');
    requestOnChain(true);
    mocks.createDocument.mockResolvedValue({ success: false, error: 'referenced document x not found for path $ownerId' });
    const result = await privateFeedService.approveFollower(ownerId, requesterId, requesterKey);
    expect(result).toMatchObject({ success: false, errorCode: 'FEED_NOT_ENABLED' });
  });

  it('reads no request on a pre-v9 contract and still writes the grant', async () => {
    const { privateFeedService: service } = await load('v8');
    requestOnChain(false);
    mocks.createDocument.mockResolvedValue({ success: true });
    const result = await service.approveFollower(ownerId, requesterId, requesterKey);
    expect(mocks.query.mock.calls.some(([q]) => q.documentTypeName === 'followRequest')).toBe(false);
    expect(mocks.createDocument).toHaveBeenCalledOnce();
    expect(mocks.createDocument.mock.calls[0][1]).toBe('privateFeedGrant');
    expect(result).toEqual({ success: true });
  });
});

describe('referencedPathFromError', () => {
  it('reads property, writer and element paths', () => {
    expect(referencedPathFromError('referenced document a not found for path quotedPostId')).toBe('quotedPostId');
    expect(referencedPathFromError('referenced document a not found for path $ownerId')).toBe('$ownerId');
    expect(referencedPathFromError('referenced identity a not found for path followedBlockers[2]')).toBe('followedBlockers[2]');
    expect(referencedPathFromError('something else')).toBeNull();
  });
});
