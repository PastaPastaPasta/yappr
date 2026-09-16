import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: vi.fn() }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }));
vi.mock('./private-feed-service', () => ({ privateFeedService: {} }));
import { PrivateFeedFollowerService } from './private-feed-follower-service';

let service: PrivateFeedFollowerService;
const request = { $id: 'request', $ownerId: 'requester', targetId: 'owner', $createdAt: 100 };
const grant = {
  $id: 'grant', $ownerId: 'owner', recipientId: 'requester', $createdAt: 150,
  leafIndex: 0, epoch: 1, encryptedPayload: new Uint8Array(),
};

beforeEach(() => {
  service = new PrivateFeedFollowerService();
  vi.spyOn(service, 'getGrant').mockResolvedValue(null);
  vi.spyOn(service, 'getFollowRequest').mockResolvedValue(request);
});
afterEach(() => vi.restoreAllMocks());

describe('private feed request status', () => {
  it('keeps an ungranted request pending after a feed-wide revocation', async () => {
    const rekeyReader = service as unknown as {
      getRekeyDocumentsAfter: (ownerId: string, epoch: number) => Promise<unknown[]>;
    };
    vi.spyOn(rekeyReader, 'getRekeyDocumentsAfter').mockResolvedValue([{
      $id: 'rekey', $ownerId: 'owner', $createdAt: 200,
      epoch: 2, revokedLeaf: 0, rekeyPayload: new Uint8Array(),
    }]);

    // This also covers a request left behind when approval was revoked before recovery.
    // The same timestamps are possible when a different follower was revoked.
    await expect(service.getAccessStatus('owner', 'requester')).resolves.toBe('pending');
  });

  it('returns none after the requester cancels the ungranted request', async () => {
    vi.mocked(service.getFollowRequest).mockResolvedValue(null);
    await expect(service.getAccessStatus('owner', 'requester')).resolves.toBe('none');
  });

  it('still requires a grant for approved status and preserves the key-recovery state', async () => {
    vi.mocked(service.getGrant).mockResolvedValue(grant);
    const canDecrypt = vi.spyOn(service, 'canDecrypt').mockResolvedValue(false);
    const cleanup = vi.spyOn(service, 'cleanupStaleFollowRequest').mockResolvedValue({ success: true });
    await expect(service.getAccessStatus('owner', 'requester')).resolves.toBe('approved-no-keys');
    expect(cleanup).not.toHaveBeenCalled();

    canDecrypt.mockResolvedValue(true);
    await expect(service.getAccessStatus('owner', 'requester')).resolves.toBe('approved');
    expect(cleanup).toHaveBeenCalledWith('owner', 'requester');
  });
});
