import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, get, createDocument, updateDocument, resolveUsername } = vi.hoisted(() => ({
  query: vi.fn(), get: vi.fn(), createDocument: vi.fn(), updateDocument: vi.fn(), resolveUsername: vi.fn(),
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query, get } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument, updateDocument } }));
vi.mock('./dpns-service', () => ({ dpnsService: { resolveUsername } }));
vi.mock('./avatar-generator', () => ({ generateAvatarDataUri: () => 'data:image/svg+xml,avatar' }));
import { unifiedProfileService } from './unified-profile-service';
import { cacheManager } from '../cache-manager';
import { YAPPR_PROFILE_CONTRACT_ID } from '../constants';

const ownerId = '11111111111111111111111111111111';
const documentId = '222222222';
const content = {
  displayName: 'Ava', bio: 'Original bio', location: 'Chicago',
  website: 'https://example.com', bannerUri: 'ipfs://banner', pronouns: 'she/her',
  avatar: '{ "style": "thumbs", "seed": "original-seed" }',
  paymentUris: '[ "dash:original-address" ]',
  socialLinks: '[ { "platform": "github", "handle": "example" } ]',
  nsfw: true,
};
const raw = {
  $id: documentId, $ownerId: ownerId, $revision: 7, $createdAt: 1700000000000,
  ...content,
};

beforeEach(() => {
  unifiedProfileService.clearCache();
  cacheManager.invalidateByTag(`user:${ownerId}`);
  query.mockReset().mockResolvedValue([raw]);
  get.mockReset().mockResolvedValue(raw);
  resolveUsername.mockReset().mockResolvedValue(null);
  createDocument.mockReset().mockImplementation(async (_contract, _type, owner, data) => ({
    success: true,
    document: { $id: documentId, $ownerId: owner, $revision: 1, ...data },
  }));
  updateDocument.mockReset().mockImplementation(async (_contract, _type, id, owner, data, revision) => ({
    success: true,
    document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data },
  }));
});

describe('profile replacements', () => {
  it('updates a bio with only contract fields and preserves serialized values verbatim', async () => {
    const result = await unifiedProfileService.updateProfile(ownerId, { bio: '  New bio  ' });

    expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
      YAPPR_PROFILE_CONTRACT_ID, 'profile', documentId, ownerId,
      { ...content, bio: 'New bio' }, 7
    );
    expect(result).toMatchObject({
      id: ownerId, documentId, bio: 'New bio', $revision: 8,
      joinedAt: new Date(raw.$createdAt),
      paymentUris: [{ scheme: 'dash:', uri: 'dash:original-address' }],
    });
  });

  it('removes intentionally cleared optional fields instead of restoring their old values', async () => {
    const result = await unifiedProfileService.updateProfile(ownerId, {
      bio: '', location: ' ', website: '', bannerUri: '', pronouns: '', avatar: '',
      paymentUris: [], socialLinks: [], nsfw: false,
    });

    expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
      YAPPR_PROFILE_CONTRACT_ID, 'profile', documentId, ownerId,
      { displayName: 'Ava', nsfw: false }, 7
    );
    expect(result).toMatchObject({ bio: undefined, paymentUris: [], socialLinks: [], nsfw: false });
  });

  it('serializes edited arrays once and uses the revision of the same raw document', async () => {
    query.mockResolvedValueOnce([{ ...raw, $revision: 12, data: content }]);
    const socialLinks = [{ platform: 'github', handle: 'new-name' }];
    await unifiedProfileService.updateProfile(ownerId, {
      paymentUris: ['dash:new-address'], socialLinks,
    });

    expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
      YAPPR_PROFILE_CONTRACT_ID, 'profile', documentId, ownerId,
      { ...content, paymentUris: '["dash:new-address"]', socialLinks: JSON.stringify(socialLinks) }, 12
    );
  });

  it('rejects a failed replacement so callers cannot report a successful save', async () => {
    updateDocument.mockResolvedValueOnce({ success: false, error: 'Replacement rejected' });
    await expect(unifiedProfileService.updateProfile(ownerId, { bio: 'New bio' }))
      .rejects.toThrow('Replacement rejected');
  });

  it('invalidates cached profiles after a successful replacement', async () => {
    await unifiedProfileService.get(documentId);
    updateDocument.mockImplementationOnce(async (_contract, _type, id, owner, data, revision) => {
      cacheManager.set('unified_profiles', ownerId, { bio: 'Old cached bio' }, { tags: [`user:${ownerId}`] });
      return { success: true, document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data } };
    });
    await unifiedProfileService.updateProfile(ownerId, { bio: 'New bio' });
    expect(cacheManager.get('unified_profiles', ownerId)).toBeNull();
    get.mockResolvedValueOnce({ ...raw, bio: 'New bio', $revision: 8 });
    expect((await unifiedProfileService.get(documentId))?.bio).toBe('New bio');
  });
});

describe('a first edit without a profile', () => {
  beforeEach(() => {
    query.mockResolvedValue([]);
  });

  it('creates the profile, named after the DPNS label', async () => {
    resolveUsername.mockResolvedValue('ava.dash');
    const result = await unifiedProfileService.updateProfile(ownerId, { bannerUri: 'ipfs://banner' });

    expect(updateDocument).not.toHaveBeenCalled();
    expect(createDocument).toHaveBeenCalledExactlyOnceWith(
      YAPPR_PROFILE_CONTRACT_ID, 'profile', ownerId,
      { displayName: 'ava', bannerUri: 'ipfs://banner' }, undefined
    );
    expect(result).toMatchObject({ displayName: 'ava', bannerUri: 'ipfs://banner' });
  });

  it('keeps a name the edit sets, and falls back to the identity without a username', async () => {
    await unifiedProfileService.updateProfile(ownerId, { displayName: '  Ava  ', bio: 'hi' });
    expect(createDocument).toHaveBeenLastCalledWith(
      YAPPR_PROFILE_CONTRACT_ID, 'profile', ownerId, { displayName: 'Ava', bio: 'hi' }, undefined
    );

    await unifiedProfileService.updateProfile(ownerId, { displayName: ' ' });
    expect(createDocument).toHaveBeenLastCalledWith(
      YAPPR_PROFILE_CONTRACT_ID, 'profile', ownerId, { displayName: `User ${ownerId.slice(-6)}` }, undefined
    );
  });

  it('cuts a long DPNS label to the display name limit', async () => {
    resolveUsername.mockResolvedValue(`${'a'.repeat(60)}.dash`);
    await unifiedProfileService.updateProfile(ownerId, { bio: 'hi' });
    expect(createDocument).toHaveBeenLastCalledWith(
      YAPPR_PROFILE_CONTRACT_ID, 'profile', ownerId, { displayName: 'a'.repeat(50), bio: 'hi' }, undefined
    );
  });

  it('rejects, and creates nothing, when the profile read fails', async () => {
    query.mockRejectedValue(new Error('DAPI timeout'));
    await expect(unifiedProfileService.updateProfile(ownerId, { bio: 'hi' })).rejects.toThrow('DAPI timeout');
    await expect(unifiedProfileService.profileExists(ownerId)).rejects.toThrow('DAPI timeout');
    expect(createDocument).not.toHaveBeenCalled();
  });
});

describe('profile v2 typed arrays (docs/SOCIAL_V9.md)', () => {
  it('writes lists on profile v2, "platform:handle" split on the first colon only', async () => {
    vi.stubEnv('NEXT_PUBLIC_PROFILE_TOPOLOGY', 'v2');
    try {
      const socialLinks = [{ platform: 'other', handle: 'https://example.com/a:b' }];
      await unifiedProfileService.updateProfile(ownerId, { paymentUris: ['dash:new-address'], socialLinks });
      expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
        YAPPR_PROFILE_CONTRACT_ID, 'profile', documentId, ownerId,
        { ...content, paymentUris: ['dash:new-address'], socialLinks: ['other:https://example.com/a:b'] }, 7
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a social link over 256 characters INCLUDING its platform prefix, before writing', async () => {
    vi.stubEnv('NEXT_PUBLIC_PROFILE_TOPOLOGY', 'v2');
    try {
      // 250-char handle + "mastodon:" prefix = 259 > 256.
      await expect(unifiedProfileService.updateProfile(ownerId, { socialLinks: [{ platform: 'mastodon', handle: 'h'.repeat(250) }] }))
        .rejects.toThrow(/at most 256 characters/);
      expect(updateDocument).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads a v2 document stored as lists', async () => {
    get.mockResolvedValueOnce({ ...raw, paymentUris: ['dash:listed'], socialLinks: ['mastodon:@a@host.social'] });
    const user = await unifiedProfileService.get(documentId);
    expect(user?.paymentUris).toEqual([{ scheme: 'dash:', uri: 'dash:listed' }]);
    expect(user?.socialLinks).toEqual([{ platform: 'mastodon', handle: '@a@host.social' }]);
  });
});

describe('stored avatar settings', () => {
  it('preserves the generator recipe alongside the separately rendered profile avatar', async () => {
    const profile = await unifiedProfileService.getProfile(ownerId);
    expect(profile?.avatar).toBe('data:image/svg+xml,avatar');
    expect(await unifiedProfileService.getStoredAvatar(ownerId)).toBe(content.avatar);
  });

  it.each(['https://example.com/avatar.png', 'ipfs://avatar-cid'])('preserves a custom avatar URI: %s', async (avatar) => {
    query.mockResolvedValueOnce([{ ...raw, avatar }]);
    expect(await unifiedProfileService.getStoredAvatar(ownerId)).toBe(avatar);
    expect(await unifiedProfileService.getAvatarUrl(ownerId)).toBe(avatar);
  });

  it('returns no stored recipe for a profile using its default avatar', async () => {
    query.mockResolvedValueOnce([{ ...raw, avatar: undefined }]);
    expect(await unifiedProfileService.getStoredAvatar(ownerId)).toBeUndefined();
    expect(await unifiedProfileService.getAvatarUrl(ownerId)).toBe('data:image/svg+xml,avatar');
  });
});
