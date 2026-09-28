import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }));
vi.mock('./private-feed-service', () => ({ privateFeedService: {} }));
import { PrivateFeedFollowerService } from './private-feed-follower-service';
import { privateFeedKeyStore } from './private-feed-key-store';

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
    vi.spyOn(service, 'canDecrypt').mockResolvedValue(false);
    await expect(service.getAccessStatus('owner', 'requester')).resolves.toBe('none');
  });

  it('reports revoked, not none, when this device still holds keys but the grant is gone (QA D-17)', async () => {
    vi.mocked(service.getFollowRequest).mockResolvedValue(null);
    vi.spyOn(service, 'canDecrypt').mockResolvedValue(true);
    await expect(service.getAccessStatus('owner', 'requester')).resolves.toBe('revoked');
  });

  it('does not call a failed grant read revoked', async () => {
    vi.mocked(service.getGrant).mockRejectedValue(new Error('offline'));
    vi.spyOn(service, 'canDecrypt').mockResolvedValue(true);
    await expect(service.getAccessStatus('owner', 'requester')).resolves.toBe('none');
  });

  it('asks for key recovery when the local keys predate a re-approval grant (QA D-17)', async () => {
    vi.mocked(service.getGrant).mockResolvedValue({ ...grant, epoch: 3 });
    vi.spyOn(service, 'canDecrypt').mockResolvedValue(true);
    vi.spyOn(privateFeedKeyStore, 'getCachedEpoch').mockReturnValue(2);
    await expect(service.getAccessStatus('owner', 'requester')).resolves.toBe('approved-no-keys');
  });

  it('still requires a grant for approved status and preserves the key-recovery state', async () => {
    vi.mocked(service.getGrant).mockResolvedValue(grant);
    const canDecrypt = vi.spyOn(service, 'canDecrypt').mockResolvedValue(false);
    const cleanup = vi.spyOn(service, 'cleanupStaleFollowRequest').mockResolvedValue({ success: true });
    await expect(service.getAccessStatus('owner', 'requester')).resolves.toBe('approved-no-keys');
    expect(cleanup).not.toHaveBeenCalled();

    canDecrypt.mockResolvedValue(true);
    vi.spyOn(privateFeedKeyStore, 'getCachedEpoch').mockReturnValue(1);
    await expect(service.getAccessStatus('owner', 'requester')).resolves.toBe('approved');
    expect(cleanup).toHaveBeenCalledWith('owner', 'requester');
  });
});

describe('private feed access reads', () => {
  it('shares one grant and one request query across concurrent checks of a pair', async () => {
    vi.restoreAllMocks();
    query.mockReset().mockResolvedValue(new Map());
    const reader = new PrivateFeedFollowerService();
    vi.spyOn(reader, 'canDecrypt').mockResolvedValue(false);

    // Three private posts by one owner check access at the same time.
    const statuses = await Promise.all([1, 2, 3].map(() => reader.getAccessStatus('owner', 'requester')));
    expect(statuses).toEqual(['none', 'none', 'none']);
    expect(query.mock.calls.map(([q]) => q.documentTypeName).sort()).toEqual(['followRequest', 'privateFeedGrant']);

    // Settled reads are not cached: a later check sees a fresh answer.
    await reader.getAccessStatus('owner', 'requester');
    expect(query).toHaveBeenCalledTimes(4);
  });
});

describe('catching up after a revocation (QA D-17)', () => {
  const rekey = { $id: 'rekey', $ownerId: 'owner', $createdAt: 200, epoch: 2, revokedLeaf: 0, packets: new Uint8Array(), encryptedCEK: new Uint8Array() };
  const internals = () => service as unknown as {
    getRekeyDocumentsAfter: (ownerId: string, epoch: number) => Promise<unknown[]>;
    applyRekey: (ownerId: string, rekey: unknown) => Promise<{ success: boolean; error?: string }>;
  };

  beforeEach(() => {
    vi.spyOn(privateFeedKeyStore, 'getCachedEpoch').mockReturnValue(1);
    vi.spyOn(internals(), 'getRekeyDocumentsAfter').mockResolvedValue([rekey]);
    vi.spyOn(internals(), 'applyRekey').mockResolvedValue({ success: false, error: 'Failed to derive new root key - may be revoked' });
  });

  it('keeps the keys that still open pre-revocation posts', async () => {
    const clear = vi.spyOn(privateFeedKeyStore, 'clearFeedKeys').mockImplementation(() => undefined);
    await expect(service.catchUp('owner', 'requester')).resolves.toEqual({ success: false, error: 'Access has been revoked' });
    expect(clear).not.toHaveBeenCalled();
  });

  it('fails, rather than reporting up to date, when the rekey read fails', async () => {
    vi.mocked(internals().getRekeyDocumentsAfter).mockRestore();
    query.mockRejectedValueOnce(new Error('offline'));
    const result = await service.catchUp('owner', 'requester');
    expect(result.success).toBe(false);
  });

  it('asks for recovery when a newer grant replaced the revoked one', async () => {
    vi.mocked(service.getGrant).mockResolvedValue({ ...grant, epoch: 2 });
    const result = await service.catchUp('owner', 'requester');
    expect(result.error).toMatch(/^RECOVERY_NEEDED:/);
  });
});
