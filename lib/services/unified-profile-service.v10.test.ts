import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DASHPAY_CONTRACT_ID, YAPPR_CONTRACT_ID } from '../constants';

// v10 profiles (docs/SOCIAL_V10.md): the DashPay `profile` plus the social
// `yapprProfile` extension, behind the same service the v2/v9 profile uses.
const { query, createDocument, updateDocument, imageDigestForUrl } = vi.hoisted(() => ({
  query: vi.fn(), createDocument: vi.fn(), updateDocument: vi.fn(), imageDigestForUrl: vi.fn(),
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument, updateDocument } }));
vi.mock('./dpns-service', () => ({ dpnsService: { resolveUsername: async () => null } }));
vi.mock('./avatar-generator', () => ({ generateAvatarDataUri: (style: string, seed: string) => `dicebear:${style}:${seed}` }));
vi.mock('../media/image-digest', () => ({ imageDigestForUrl }));

const ownerId = '11111111111111111111111111111111';
const dashpay = { $id: 'dashpay-doc', $ownerId: ownerId, $revision: 2, $createdAt: 1, displayName: 'Ava', publicMessage: 'hi' };
const extension = { $id: 'ext-doc', $ownerId: ownerId, $revision: 1, $createdAt: 2, location: 'Lisbon', avatar: '{"seed":"s","style":"bottts"}' };

/** Stored documents per contract, answered for both `==` and `in` owner queries. */
let stored: Record<string, Record<string, unknown>[]>;

async function service() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10');
  return (await import('./unified-profile-service')).unifiedProfileService;
}

beforeEach(() => {
  stored = { [DASHPAY_CONTRACT_ID]: [dashpay], [YAPPR_CONTRACT_ID]: [extension] };
  query.mockReset().mockImplementation(async ({ dataContractId }: { dataContractId: string }) => stored[dataContractId] ?? []);
  createDocument.mockReset().mockImplementation(async (_contract, type, owner, data) => ({
    success: true, document: { $id: `new-${type}`, $ownerId: owner, ...data },
  }));
  updateDocument.mockReset().mockImplementation(async (_contract, type, id, owner, data, revision) => ({
    success: true, document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data },
  }));
  imageDigestForUrl.mockReset().mockResolvedValue({ hash: new Uint8Array(32).fill(1), fingerprint: new Uint8Array(8).fill(2) });
});
afterEach(() => vi.unstubAllEnvs());

describe('v10 profile reads', () => {
  it('merges the DashPay profile and the extension, one batched query per document type', async () => {
    const profiles = await service();
    const profile = await profiles.getProfile(ownerId);
    expect(profile).toMatchObject({ displayName: 'Ava', bio: 'hi', location: 'Lisbon', avatar: 'dicebear:bottts:s', documentId: 'ext-doc' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ dataContractId: DASHPAY_CONTRACT_ID, documentTypeName: 'profile', where: [['$ownerId', 'in', [ownerId]]] }));
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ dataContractId: YAPPR_CONTRACT_ID, documentTypeName: 'yapprProfile', where: [['$ownerId', 'in', [ownerId]]] }));
  });

  it('shows a DashPay-only user by name', async () => {
    stored[YAPPR_CONTRACT_ID] = [];
    const profiles = await service();
    expect((await profiles.getProfile(ownerId))?.displayName).toBe('Ava');
  });

  it('counts either document as an existing profile, and rejects rather than reporting none', async () => {
    const profiles = await service();
    stored[YAPPR_CONTRACT_ID] = [];
    await expect(profiles.profileExists(ownerId)).resolves.toBe(true);
    stored = {};
    await expect(profiles.profileExists(ownerId)).resolves.toBe(false);
    query.mockRejectedValue(new Error('DAPI timeout'));
    await expect(profiles.profileExists(ownerId)).rejects.toThrow('DAPI timeout');
  });

  it('knows a profile only once both documents are seeded, then answers from cache', async () => {
    const profiles = await service();
    const found = profiles.seedProfileDocuments([dashpay], [ownerId]);
    expect(found.get(ownerId)?.displayName).toBe('Ava');
    expect(profiles.hasCachedProfile(ownerId)).toBe(false);
    profiles.seedProfileDocuments([extension], [ownerId], 'extension');
    expect(profiles.hasCachedProfile(ownerId)).toBe(true);
    expect(await profiles.getAvatarUrl(ownerId)).toBe('dicebear:bottts:s');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('v10 profile writes', () => {
  it('creates the DashPay profile first, then the extension', async () => {
    stored = {};
    const profiles = await service();
    const user = await profiles.createProfile(ownerId, { displayName: 'Ava', bio: 'hi', location: 'Lisbon', socialLinks: [{ platform: 'github', handle: 'ava' }] });
    expect(createDocument.mock.calls.map(([contract, type, , data]) => [contract, type, data])).toEqual([
      [DASHPAY_CONTRACT_ID, 'profile', { displayName: 'Ava', publicMessage: 'hi' }],
      [YAPPR_CONTRACT_ID, 'yapprProfile', { location: 'Lisbon', socialLinks: ['github:ava'] }],
    ]);
    expect(user).toMatchObject({ displayName: 'Ava', bio: 'hi', location: 'Lisbon' });
  });

  it('keeps an existing DashPay profile and adds only the extension', async () => {
    stored[YAPPR_CONTRACT_ID] = [];
    const profiles = await service();
    await profiles.createProfile(ownerId, { displayName: 'Ava', bio: 'hi', pronouns: 'she/her' });
    expect(createDocument).toHaveBeenCalledExactlyOnceWith(YAPPR_CONTRACT_ID, 'yapprProfile', ownerId, { pronouns: 'she/her' });
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it('names the DashPay profile a first banner-only save creates', async () => {
    stored = {};
    const profiles = await service();
    await profiles.updateProfile(ownerId, { bannerUri: 'ipfs://banner' });
    expect(createDocument).toHaveBeenCalledWith(DASHPAY_CONTRACT_ID, 'profile', ownerId, { displayName: `User ${ownerId.slice(-6)}` });
  });

  it('replaces only the document an edit touches, at its own revision', async () => {
    const profiles = await service();
    await profiles.updateProfile(ownerId, { bio: 'new bio' });
    expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
      DASHPAY_CONTRACT_ID, 'profile', 'dashpay-doc', ownerId, { displayName: 'Ava', publicMessage: 'new bio' }, 2
    );
    updateDocument.mockClear();
    await profiles.updateProfile(ownerId, { bannerUri: 'ipfs://banner' });
    expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
      YAPPR_CONTRACT_ID, 'yapprProfile', 'ext-doc', ownerId, { location: 'Lisbon', avatar: extension.avatar, bannerUri: 'ipfs://banner' }, 1
    );
  });

  it('reports each document it is about to write, as "1 of 2" then "2 of 2"', async () => {
    const profiles = await service();
    const progress: unknown[] = [];
    const order: string[] = [];
    updateDocument.mockImplementation(async (_contract, type, id, owner, data, revision) => {
      order.push(`write ${type}`);
      return { success: true, document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data } };
    });
    await profiles.updateProfile(ownerId, { bio: 'new bio', pronouns: 'she/her' }, {
      onProgress: (step) => { progress.push(step); order.push(`step ${step.step}`); },
    });
    expect(progress).toEqual([{ step: 1, total: 2 }, { step: 2, total: 2 }]);
    expect(order).toEqual(['step 1', 'write profile', 'step 2', 'write yapprProfile']);

    // An edit of one group writes one document.
    progress.length = 0;
    await profiles.updateProfile(ownerId, { bio: 'newer bio' }, { onProgress: (step) => progress.push(step) });
    expect(progress).toEqual([{ step: 1, total: 1 }]);
  });

  it('fingerprints a new image avatar into DashPay and keeps the recipe as the fallback', async () => {
    const profiles = await service();
    await profiles.updateProfile(ownerId, { avatar: 'ipfs://avatar' });
    expect(imageDigestForUrl).toHaveBeenCalledExactlyOnceWith('ipfs://avatar');
    expect(updateDocument).toHaveBeenCalledExactlyOnceWith(DASHPAY_CONTRACT_ID, 'profile', 'dashpay-doc', ownerId, {
      displayName: 'Ava', publicMessage: 'hi', avatarUrl: 'ipfs://avatar',
      avatarHash: new Uint8Array(32).fill(1), avatarFingerprint: new Uint8Array(8).fill(2),
    }, 2);
  });

  it('keeps an image it cannot fingerprint in the extension rather than failing the save', async () => {
    imageDigestForUrl.mockRejectedValueOnce(new Error('CORS'));
    const profiles = await service();
    await profiles.updateProfile(ownerId, { avatar: 'https://no-cors.example/a.png' });
    expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
      YAPPR_CONTRACT_ID, 'yapprProfile', 'ext-doc', ownerId, { location: 'Lisbon', avatar: 'https://no-cors.example/a.png' }, 1
    );
  });

  it('waits for a DashPay profile whose create was not confirmed before writing the extension', async () => {
    stored = {};
    createDocument.mockImplementationOnce(async (_contract, type, owner, data) => {
      setTimeout(() => { stored[DASHPAY_CONTRACT_ID] = [{ $id: 'late', $ownerId: owner, ...data }]; }, 3000);
      return { success: true, confirmed: false, document: { $id: `new-${type}`, $ownerId: owner, ...data } };
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const profiles = await service();
      const saving = profiles.createProfile(ownerId, { displayName: 'Ava' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(createDocument).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      await saving;
      expect(createDocument).toHaveBeenLastCalledWith(YAPPR_CONTRACT_ID, 'yapprProfile', ownerId, { avatar: expect.stringContaining(ownerId) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops before the extension when the DashPay write fails', async () => {
    stored = {};
    createDocument.mockResolvedValueOnce({ success: false, error: 'refused' });
    const profiles = await service();
    await expect(profiles.createProfile(ownerId, { displayName: 'Ava' })).rejects.toThrow('refused');
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it('explains a DashPay write refused because the key is bound to another contract', async () => {
    stored = {};
    createDocument.mockResolvedValueOnce({ success: false, error: 'Broadcast refused (code=20014)' });
    const profiles = await service();
    await expect(profiles.createProfile(ownerId, { displayName: 'Ava' })).rejects.toThrow(/limited to Yappr/);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it('refuses a website the extension would refuse before writing either document', async () => {
    const profiles = await service();
    await expect(profiles.updateProfile(ownerId, { bio: 'new bio', website: 'example.com' })).rejects.toThrow(/http:\/\/ or https:\/\//);
    expect(updateDocument).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
  });
});

describe('v10 profile saves not confirmed (onUnconfirmed)', () => {
  const unconfirmed = async (_contract: string, _type: string, id: string, owner: string, data: Record<string, unknown>, revision: number) => ({
    success: true, confirmed: false, document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data },
  });

  it('tells the caller when the DashPay replacement was not confirmed', async () => {
    updateDocument.mockImplementationOnce(unconfirmed);
    const profiles = await service();
    const onUnconfirmed = vi.fn();
    await profiles.updateProfile(ownerId, { bio: 'new bio' }, { onUnconfirmed });
    expect(onUnconfirmed).toHaveBeenCalledTimes(1);
  });

  it('tells the caller when the extension replacement was not confirmed', async () => {
    updateDocument.mockImplementationOnce(unconfirmed);
    const profiles = await service();
    const onUnconfirmed = vi.fn();
    await profiles.updateProfile(ownerId, { pronouns: 'she/her' }, { onUnconfirmed });
    expect(updateDocument).toHaveBeenCalledExactlyOnceWith(YAPPR_CONTRACT_ID, 'yapprProfile', 'ext-doc', ownerId, expect.anything(), 1);
    expect(onUnconfirmed).toHaveBeenCalledTimes(1);
  });

  it('tells the caller once per document not confirmed in a two-document save, and never for confirmed ones', async () => {
    const profiles = await service();
    const onUnconfirmed = vi.fn();
    await profiles.updateProfile(ownerId, { bio: 'new bio', pronouns: 'she/her' }, { onUnconfirmed });
    expect(onUnconfirmed).not.toHaveBeenCalled();

    updateDocument.mockImplementationOnce(unconfirmed).mockImplementationOnce(unconfirmed);
    await profiles.updateProfile(ownerId, { bio: 'newer bio', pronouns: 'they/them' }, { onUnconfirmed });
    expect(onUnconfirmed).toHaveBeenCalledTimes(2);
  });

  it('tells the caller when a new extension was not confirmed', async () => {
    stored[YAPPR_CONTRACT_ID] = [];
    createDocument.mockImplementationOnce(async (_contract, type, owner, data) => ({
      success: true, confirmed: false, document: { $id: `new-${type}`, $ownerId: owner, ...data },
    }));
    const profiles = await service();
    const onUnconfirmed = vi.fn();
    await profiles.updateProfile(ownerId, { pronouns: 'she/her' }, { onUnconfirmed });
    expect(createDocument).toHaveBeenCalledExactlyOnceWith(YAPPR_CONTRACT_ID, 'yapprProfile', ownerId, expect.anything());
    expect(onUnconfirmed).toHaveBeenCalledTimes(1);
  });
});

describe('v10 profile reads after a save', () => {
  /** Drops the cached profile, as a later screen's read would find it expired or invalidated. */
  async function dropCache() {
    (await import('../cache-manager')).cacheManager.invalidateByTag(`user:${ownerId}`);
  }

  // DAPI answers from any node: one a block behind still returns the document the save replaced.
  it('shows the saved profile while reads still return the previous revision (NEW-profile-stale-after-save)', async () => {
    const profiles = await service();
    expect((await profiles.getProfile(ownerId))?.pronouns).toBeUndefined();

    await profiles.updateProfile(ownerId, { pronouns: 'she/they' });
    expect(updateDocument).toHaveBeenCalledWith(
      YAPPR_CONTRACT_ID, 'yapprProfile', 'ext-doc', ownerId, expect.objectContaining({ pronouns: 'she/they' }), 1
    );
    // `stored` still holds revision 1: every read below comes from a node behind.
    query.mockClear();
    await dropCache();
    expect((await profiles.getProfile(ownerId))?.pronouns).toBe('she/they');
    expect(query).toHaveBeenCalled();

    // A feed page read before the save landed seeds the old document: it does not win either.
    profiles.seedProfileDocuments([extension], [ownerId], 'extension');
    await dropCache();
    expect((await profiles.getProfile(ownerId))?.pronouns).toBe('she/they');

    // The next edit replaces the revision this save wrote, not the one the node behind returns.
    updateDocument.mockClear();
    await profiles.updateProfile(ownerId, { location: 'Porto' });
    expect(updateDocument).toHaveBeenCalledWith(
      YAPPR_CONTRACT_ID, 'yapprProfile', 'ext-doc', ownerId, expect.objectContaining({ location: 'Porto', pronouns: 'she/they' }), 2
    );
  });

  it('gives way to a read that has caught up, or to a later edit from another device', async () => {
    const profiles = await service();
    await profiles.updateProfile(ownerId, { pronouns: 'she/they' });
    stored[YAPPR_CONTRACT_ID] = [{ ...extension, $revision: 3, pronouns: 'they/them' }];
    await dropCache();
    expect((await profiles.getProfile(ownerId))?.pronouns).toBe('they/them');
  });

  it('keeps the saved revision after one caught-up read, when the next node is still behind', async () => {
    const profiles = await service();
    await profiles.updateProfile(ownerId, { pronouns: 'she/they' });
    const saved = { ...extension, $revision: 2, pronouns: 'she/they' };

    // One node has caught up...
    stored[YAPPR_CONTRACT_ID] = [saved];
    await dropCache();
    expect((await profiles.getProfile(ownerId))?.pronouns).toBe('she/they');

    // ...the next is still behind: neither a feed seed nor an edit's fresh read takes its revision 1.
    stored[YAPPR_CONTRACT_ID] = [extension];
    await dropCache();
    profiles.seedProfileDocuments([extension], [ownerId], 'extension');
    expect((await profiles.getProfile(ownerId))?.pronouns).toBe('she/they');
    updateDocument.mockClear();
    await profiles.updateProfile(ownerId, { location: 'Porto' });
    expect(updateDocument).toHaveBeenCalledWith(
      YAPPR_CONTRACT_ID, 'yapprProfile', 'ext-doc', ownerId, expect.objectContaining({ location: 'Porto', pronouns: 'she/they' }), 2
    );
  });

  it('edits a just-created extension at its revision while reads from a node behind still miss it', async () => {
    stored[YAPPR_CONTRACT_ID] = [];
    const profiles = await service();
    await profiles.updateProfile(ownerId, { pronouns: 'she/they' });
    expect(createDocument).toHaveBeenCalledTimes(1);

    await profiles.updateProfile(ownerId, { location: 'Porto' });
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(updateDocument).toHaveBeenCalledWith(
      YAPPR_CONTRACT_ID, 'yapprProfile', 'new-yapprProfile', ownerId, expect.objectContaining({ location: 'Porto', pronouns: 'she/they' }), 1
    );
  });

  it('checks a profile read against a save that lands while the other document is still loading', async () => {
    const profiles = await service();
    let releaseExtension: (documents: Record<string, unknown>[]) => void = () => {};
    const batchQuery = query.getMockImplementation();
    query.mockImplementation(async (request: { dataContractId: string; where: unknown[][] }) => {
      if (request.dataContractId === YAPPR_CONTRACT_ID && request.where[0][1] === 'in') {
        return new Promise((resolve) => { releaseExtension = resolve; });
      }
      return batchQuery?.(request);
    });

    // The DashPay profile (revision 2) comes back at once; the extension's read is still out.
    const read = profiles.getProfile(ownerId);
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith(expect.objectContaining({ dataContractId: YAPPR_CONTRACT_ID })));

    await profiles.updateProfile(ownerId, { displayName: 'Bea' });
    expect(updateDocument).toHaveBeenCalledWith(DASHPAY_CONTRACT_ID, 'profile', 'dashpay-doc', ownerId, expect.objectContaining({ displayName: 'Bea' }), 2);

    releaseExtension([extension]);
    expect((await read)?.displayName).toBe('Bea');
    expect((await profiles.getProfile(ownerId))?.displayName).toBe('Bea');
  });

  it('keeps a landed DashPay replacement when the extension write then fails', async () => {
    const profiles = await service();
    updateDocument.mockImplementation(async (_contract, type, id, owner, data, revision) => (
      type === 'yapprProfile'
        ? { success: false, error: 'Extension rejected' }
        : { success: true, document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data } }
    ));
    await expect(profiles.updateProfile(ownerId, { bio: 'new bio', pronouns: 'she/her' })).rejects.toThrow('Extension rejected');

    // Reads still return the DashPay profile at revision 2: the landed revision 3 stands in for them.
    await dropCache();
    expect((await profiles.getProfile(ownerId))?.bio).toBe('new bio');

    // The retry writes only the extension, not another replacement of revision 2.
    updateDocument.mockReset().mockImplementation(async (_contract, type, id, owner, data, revision) => ({
      success: true, document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data },
    }));
    await profiles.updateProfile(ownerId, { bio: 'new bio', pronouns: 'she/her' });
    expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
      YAPPR_CONTRACT_ID, 'yapprProfile', 'ext-doc', ownerId, expect.objectContaining({ pronouns: 'she/her' }), 1
    );
  });

  it('keeps a landed DashPay create when the extension create then fails', async () => {
    stored = {};
    const profiles = await service();
    createDocument.mockImplementation(async (_contract, type, owner, data) => (
      type === 'yapprProfile'
        ? { success: false, error: 'Extension rejected' }
        : { success: true, document: { $id: `new-${type}`, $ownerId: owner, ...data } }
    ));
    await expect(profiles.updateProfile(ownerId, { displayName: 'Ava', pronouns: 'she/her' })).rejects.toThrow('Extension rejected');

    await dropCache();
    expect((await profiles.getProfile(ownerId))?.displayName).toBe('Ava');

    // The retry creates only the extension; the DashPay profile is not created twice.
    createDocument.mockClear();
    createDocument.mockImplementation(async (_contract, type, owner, data) => ({
      success: true, document: { $id: `new-${type}`, $ownerId: owner, ...data },
    }));
    await profiles.updateProfile(ownerId, { displayName: 'Ava', pronouns: 'she/her' });
    expect(createDocument).toHaveBeenCalledExactlyOnceWith(YAPPR_CONTRACT_ID, 'yapprProfile', ownerId, { pronouns: 'she/her' });
  });

  it('does not stand in for reads with a create that was never confirmed (it may not land)', async () => {
    stored[YAPPR_CONTRACT_ID] = [];
    createDocument.mockImplementationOnce(async (_contract, type, owner, data) => ({
      success: true, confirmed: false, document: { $id: `new-${type}`, $ownerId: owner, ...data },
    }));
    const profiles = await service();
    await profiles.updateProfile(ownerId, { pronouns: 'she/they' });
    expect(createDocument).toHaveBeenCalledWith(YAPPR_CONTRACT_ID, 'yapprProfile', ownerId, expect.objectContaining({ pronouns: 'she/they' }));
    await dropCache();
    expect((await profiles.getProfile(ownerId))?.pronouns).toBeUndefined();
  });

  it('stops preferring its own write once a cached read would have expired', async () => {
    const profiles = await service();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await profiles.updateProfile(ownerId, { pronouns: 'she/they' });
      clock.mockReturnValue(now + 300001);
      await dropCache();
      expect((await profiles.getProfile(ownerId))?.pronouns).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
});
