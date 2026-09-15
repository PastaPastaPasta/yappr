import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, get, updateDocument } = vi.hoisted(() => ({
  query: vi.fn(), get: vi.fn(), updateDocument: vi.fn(),
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query, get } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }));
vi.mock('./dpns-service', () => ({ dpnsService: { resolveUsername: async () => null } }));
vi.mock('./avatar-generator', () => ({ generateAvatarDataUri: () => 'data:image/svg+xml,avatar' }));
import { unifiedProfileService } from './unified-profile-service';
import { cacheManager } from '../cache-manager';
import { YAPPR_PROFILE_CONTRACT_ID } from '../constants';

const ownerId = '111111111';
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
