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

  it('shows a DashPay-only user by name, but not as having a Yappr profile', async () => {
    stored[YAPPR_CONTRACT_ID] = [];
    const profiles = await service();
    expect((await profiles.getProfile(ownerId))?.displayName).toBe('Ava');
    expect(await profiles.getV10ProfileStatus(ownerId)).toMatchObject({ dashpay: { displayName: 'Ava', bio: 'hi' }, hasExtension: false });
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
});
