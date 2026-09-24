import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), createDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: mocks.query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument: mocks.createDocument } }));
vi.mock('./identity-service', () => ({ identityService: {} }));
import { REQUEST_WITHDRAWN_MESSAGE, privateFeedService } from './private-feed-service';
import { privateFeedKeyStore } from './private-feed-key-store';
import { privateFeedCryptoService } from './private-feed-crypto-service';
import { referencedPathFromError } from '@/lib/error-utils';

const ownerId = '9NFhqxW8upkFMVTE5h5VmYWLdSEJ26B2iMKdhCFgsWkd';
const requesterId = 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe';
const requesterKey = new Uint8Array(33).fill(2);

/** Every query answers `docs` for followRequest, nothing for anything else. */
function requestOnChain(present: boolean) {
  mocks.query.mockImplementation(async ({ documentTypeName }: { documentTypeName: string }) =>
    new Map(present && documentTypeName === 'followRequest' ? [['request', { $id: 'request', $ownerId: requesterId }]] : []));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(privateFeedKeyStore, 'getFeedSeed').mockReturnValue(new Uint8Array(32).fill(7));
  vi.spyOn(privateFeedKeyStore, 'getCurrentEpoch').mockReturnValue(1);
  vi.spyOn(privateFeedKeyStore, 'getAvailableLeaves').mockReturnValue([0, 1]);
  vi.spyOn(privateFeedKeyStore, 'getRevokedLeaves').mockReturnValue([]);
  vi.spyOn(privateFeedKeyStore, 'getCachedCEK').mockReturnValue({ epoch: 1, cek: new Uint8Array(32).fill(3) });
  vi.spyOn(privateFeedKeyStore, 'storeAvailableLeaves').mockImplementation(() => undefined);
  vi.spyOn(privateFeedKeyStore, 'getRecipientMap').mockReturnValue({});
  vi.spyOn(privateFeedKeyStore, 'storeRecipientMap').mockImplementation(() => undefined);
  vi.spyOn(privateFeedService, 'getLatestEpoch').mockResolvedValue(1);
  vi.spyOn(privateFeedService, 'getPrivateFollowers').mockResolvedValue([]);
  vi.spyOn(privateFeedCryptoService, 'eciesEncrypt').mockResolvedValue(new Uint8Array(96));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function onTopology(topology: string) {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology);
  vi.resetModules();
}

describe('approving a follower on the v9 gated contract', () => {
  it('refuses before any key work when the request was withdrawn', async () => {
    await onTopology('v9');
    const { privateFeedService: service } = await import('./private-feed-service');
    requestOnChain(false);
    const result = await service.approveFollower(ownerId, requesterId, requesterKey);
    expect(result).toMatchObject({ success: false, errorCode: 'REQUEST_WITHDRAWN' });
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('maps a 40120 on recipientId (the request vanished mid-approval) to "request withdrawn"', async () => {
    requestOnChain(true);
    mocks.createDocument.mockResolvedValue({
      success: false,
      error: 'referenced document 7xB… not found for path recipientId (code=40120)',
    });
    const result = await privateFeedService.approveFollower(ownerId, requesterId, requesterKey);
    expect(result).toEqual({ success: false, error: REQUEST_WITHDRAWN_MESSAGE, errorCode: 'REQUEST_WITHDRAWN' });
  });

  it('maps a 40120 on $ownerId to "enable your private feed first"', async () => {
    requestOnChain(true);
    mocks.createDocument.mockResolvedValue({ success: false, error: 'referenced document x not found for path $ownerId' });
    const result = await privateFeedService.approveFollower(ownerId, requesterId, requesterKey);
    expect(result).toMatchObject({ success: false, errorCode: 'FEED_NOT_ENABLED' });
  });

  it('does not read the request on a pre-v9 contract', async () => {
    await onTopology('v8');
    const { privateFeedService: service } = await import('./private-feed-service');
    requestOnChain(false);
    mocks.createDocument.mockResolvedValue({ success: true });
    const result = await service.approveFollower(ownerId, requesterId, requesterKey);
    expect(mocks.query.mock.calls.some(([q]) => q.documentTypeName === 'followRequest')).toBe(false);
    expect(result.errorCode).toBeUndefined();
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
