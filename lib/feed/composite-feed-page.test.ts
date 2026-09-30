import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the loader and decoders with an in-memory SDK boundary. No SDK
// initialization, browser storage or network calls are made by these tests.
const mocks = vi.hoisted(() => ({
  composite: vi.fn(),
  getEvoSdk: vi.fn(),
  seedUsernames: vi.fn(),
  seedProfiles: vi.fn(() => new Map()),
  resolveAuthors: vi.fn(),
  getOwnQuotes: vi.fn(),
  countRepliesForPosts: vi.fn(),
}));
// The v10 reads beside the composite (own quotes, multi-root reply counts).
vi.mock('@/lib/services/post-service', () => ({ postService: { getOwnQuotes: mocks.getOwnQuotes } }));
vi.mock('@/lib/services/reply-service', () => ({ replyService: { countRepliesForPosts: mocks.countRepliesForPosts } }));
vi.mock('@/lib/services/evo-sdk-service', () => ({ getEvoSdk: mocks.getEvoSdk }));
vi.mock('@/lib/services/dpns-service', () => ({ dpnsService: { seedUsernames: mocks.seedUsernames } }));
vi.mock('@/lib/services/unified-profile-service', () => ({
  unifiedProfileService: {
    seedProfileDocuments: mocks.seedProfiles,
    getDefaultAvatarUrl: (id: string) => `avatar:${id}`,
  },
}));
vi.mock('@/lib/services/post-enrichment-helpers', () => ({ resolvePostAuthorsBatch: mocks.resolveAuthors }));

const ownerIds = ['111111111', '222222222', '333333333', '444444444'];
const docs = ownerIds.map((ownerId, i) => ({
  $id: `post0000${i}`, $ownerId: ownerId, $createdAt: 1000, content: 'test', language: 'en',
}));
const names = ownerIds.map((id, i) => ({ records: { identity: id }, label: `name${i}` }));
function result(dpns = names, page = docs) {
  return {
    pageDocuments: page,
    subResults: [
      ...Array.from({ length: 4 }, () => ({ kind: 'counts', counts: new Map() })),
      { kind: 'documents', documents: [] },
      { kind: 'documents', documents: [] },
      { kind: 'documents', documents: dpns },
      { kind: 'documents', documents: [] },
    ],
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9');
  mocks.getEvoSdk.mockResolvedValue({ documents: { composite: mocks.composite } });
  mocks.composite.mockResolvedValue(result());
});
afterEach(() => vi.unstubAllEnvs());

describe('composite feed page', () => {
  it('uses reply surfaces and preserves caller linkage without mutating the input', async () => {
    mocks.composite.mockImplementation(async query => ({
      pageDocuments: [docs[0]],
      subResults: query.subQueries.map((sub: { kind?: string }) => sub.kind === 'counts'
        ? { kind: 'counts', counts: new Map([[docs[0].$id, BigInt(5)]]) }
        : { kind: 'documents', documents: [] }),
    }));
    const { transformRawPost } = await import('./transform-raw-post');
    const source = { ...transformRawPost(docs[0]), targetKind: 'reply' as const, rootPostId: 'root1234', parentId: 'parent1234' };
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({
      language: 'en', limit: 1, documentIds: [source.id], kind: 'reply',
      sourcePosts: [source], currentUserId: ownerIds[0],
    });
    const query = mocks.composite.mock.calls[0][0];
    expect(query.documentType).toBe('reply');
    expect(query.subQueries.filter((sub: { kind?: string }) => sub.kind === 'counts').map((sub: { documentType: string }) => sub.documentType))
      .toEqual(['likeReply', 'reply', 'post']);
    expect(query.subQueries.some((sub: { documentType: string }) => ['bookmark', 'repost'].includes(sub.documentType))).toBe(false);
    expect(page.posts[0]).toMatchObject({ targetKind: 'reply', rootPostId: 'root1234', parentId: 'parent1234', likes: 5 });
    expect(source.likes).toBe(0);
  });

  it('retains the exact owner/tag query instead of changing its ordering', async () => {
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const pageQuery = { where: [['hashtag', '==', 'dash']] as [string, '==', string][], orderBy: [['$createdAt', 'desc']] as [string, 'desc'][] };
    await loadCompositeFeedPage({ language: 'en', limit: 20, pageQuery });
    expect(mocks.composite.mock.calls[0][0]).toMatchObject(pageQuery);
  });

  it('keeps an explicit ID page unordered when its caller omits orderBy', async () => {
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const pageQuery = { where: [['$id', 'in', [docs[0].$id]]] as [string, 'in', string[]][] };
    await loadCompositeFeedPage({ language: 'en', limit: 1, pageQuery });
    expect(mocks.composite.mock.calls[0][0].where).toEqual(pageQuery.where);
    expect(mocks.composite.mock.calls[0][0].orderBy).toBeUndefined();
  });

  it('should preload all four named authors using a total budget of 100', async () => {
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20 });
    expect(page?.preloaded.usernames?.size).toBe(4);
    expect(page?.preloaded.usernames?.get(ownerIds[3])).toBe('name3.dash');
    expect(page?.posts[0].hashtag).toBe('');
    const query = mocks.composite.mock.calls[0][0];
    expect(query.subQueries).toHaveLength(8);
    expect(query.subQueries[6].limit).toBe(100);
  });

  it('should not preload partial primary names or negative cache entries at the cap', async () => {
    mocks.composite.mockResolvedValue(result(Array.from({ length: 100 }, (_, i) => ({
      records: { identity: ownerIds[0] }, label: `alias${i}`,
    }))));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20 });
    expect(page?.preloaded.usernames?.size).toBe(0);
    expect(mocks.seedUsernames).toHaveBeenCalledWith(new Map());
  });

  it('should seed absence only when the DPNS result leaves capacity for every author', async () => {
    mocks.composite.mockResolvedValue(result(names.slice(0, 3)));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20 });
    expect(page?.preloaded.usernames?.get(ownerIds[3])).toBeNull();
  });

  it('should leave capacity for empty identity branches before trusting completeness', async () => {
    mocks.composite.mockResolvedValue(result(Array.from({ length: 97 }, (_, i) => ({
      records: { identity: ownerIds[0] }, label: `alias${i}`,
    }))));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20 });
    expect(page?.preloaded.usernames?.size).toBe(0);
  });

  it('should query exact cursor-selected ids and restore their timeline order', async () => {
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const ids = docs.map(doc => doc.$id).reverse();
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20, documentIds: ids });
    expect(mocks.composite.mock.calls[0][0].where).toEqual([['$id', 'in', ids]]);
    expect(mocks.composite.mock.calls[0][0].orderBy).toBeUndefined();
    expect(page?.posts.map(post => post.id)).toEqual(ids);
  });

  it('marks a quoting post whose quoted id the join proved absent, matched by id not position', async () => {
    // docs[1] quotes a REMOVED post, docs[2] quotes a live one; the join returns
    // only the live document and lists the removed id in missingIds.
    const page = docs.map((doc, i) => ({ ...doc, ...(i === 1 ? { quotedPostId: 'removedAA' } : i === 2 ? { quotedPostId: 'quotedBBB' } : {}) }));
    const response: { pageDocuments: unknown[]; subResults: unknown[] } = result(names, page);
    response.subResults[4] = {
      kind: 'documents',
      documents: [{ $id: 'quotedBBB', $ownerId: ownerIds[3], $createdAt: 900, content: 'quoted', language: 'en' }],
      missingIds: ['removedAA'],
    };
    mocks.composite.mockResolvedValue(response);
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const { posts } = await loadCompositeFeedPage({ language: 'en', limit: 4 });
    expect(posts[1].quotedPostRemoved).toBe(true);
    expect(posts[1].quotedPost).toBeUndefined();
    expect(posts[2].quotedPostRemoved).toBeUndefined();
    expect(posts[2].quotedPost?.id).toBe('quotedBBB');
    expect(posts[0].quotedPostRemoved).toBeUndefined();
  });

  it('should keep tombstones in the raw cursor page and remove them from cards', async () => {
    mocks.composite.mockResolvedValue(result(names, docs.map((doc, i) => ({ ...doc, deleted: i === 3 }))));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 4 });
    expect(page?.rawPosts).toHaveLength(4);
    expect(page?.posts).toHaveLength(3);
    expect(page?.hasMore).toBe(true);
  });

  it('should fit viewer interactions within ten subqueries', async () => {
    const response = result();
    response.subResults.push({ kind: 'documents', documents: [] }, { kind: 'documents', documents: [] });
    mocks.composite.mockResolvedValue(response);
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20, currentUserId: ownerIds[0] });
    expect(mocks.composite.mock.calls[0][0].subQueries).toHaveLength(10);
    expect(page?.preloaded.interactions?.size).toBe(4);
  });

  it('propagates composite request failures', async () => {
    const error = new Error('composite request failed');
    mocks.composite.mockRejectedValue(error);
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    await expect(loadCompositeFeedPage({ language: 'en', limit: 20 })).rejects.toBe(error);
    expect(mocks.composite).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete composite responses without seeding false absences', async () => {
    mocks.composite.mockResolvedValue({ pageDocuments: docs, subResults: [] });
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    await expect(loadCompositeFeedPage({ language: 'en', limit: 20 })).rejects.toThrow('incomplete composite result');
    expect(mocks.seedUsernames).not.toHaveBeenCalled();
    expect(mocks.seedProfiles).not.toHaveBeenCalled();
  });
});

describe('composite feed page on v10', () => {
  /** Answer every sub-query with empty results of its own kind. */
  const echo = (page: Record<string, unknown>[]) => async (query: { subQueries: { kind?: string }[] }) => ({
    pageDocuments: page,
    subResults: query.subQueries.map((sub) => sub.kind === 'counts'
      ? { kind: 'counts', counts: new Map() }
      : { kind: 'documents', documents: [] }),
  });
  type Sub = { documentType: string; kind?: string; where?: unknown[][]; bind?: { field: string } };

  beforeEach(() => vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10'));

  it('pins a single-thread reply page\'s child-count slot to its root and has no repost slot', async () => {
    mocks.composite.mockImplementation(echo([docs[0], docs[1]]));
    const { transformRawPost } = await import('./transform-raw-post');
    const sources = [docs[0], docs[1]].map((doc) => ({ ...transformRawPost(doc), targetKind: 'reply' as const, rootPostId: 'rootA' }));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    await loadCompositeFeedPage({ language: 'en', limit: 2, kind: 'reply', sourcePosts: sources, documentIds: sources.map((post) => post.id) });
    const subs: Sub[] = mocks.composite.mock.calls[0][0].subQueries;
    expect(subs.find((sub) => sub.documentType === 'reply' && sub.kind === 'counts'))
      .toMatchObject({ where: [['rootPostId', '==', 'rootA']], bind: { field: 'replyToReplyId' } });
    expect(subs.some((sub) => sub.documentType === 'repost')).toBe(false);
    expect(mocks.countRepliesForPosts).not.toHaveBeenCalled();
  });

  it('counts a reply page spanning several threads separately, per root', async () => {
    mocks.composite.mockImplementation(echo([docs[0], docs[1]]));
    mocks.countRepliesForPosts.mockResolvedValue(new Map([[docs[0].$id, 4], [docs[1].$id, 1]]));
    const { transformRawPost } = await import('./transform-raw-post');
    const sources = [docs[0], docs[1]].map((doc, i) => ({ ...transformRawPost(doc), targetKind: 'reply' as const, rootPostId: `root${i}` }));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 2, kind: 'reply', sourcePosts: sources, documentIds: sources.map((post) => post.id) });
    const subs: Sub[] = mocks.composite.mock.calls[0][0].subQueries;
    expect(subs.some((sub) => sub.documentType === 'reply' && sub.kind === 'counts')).toBe(false);
    expect(mocks.countRepliesForPosts).toHaveBeenCalledWith([docs[0].$id, docs[1].$id], 'reply', new Map([[docs[0].$id, 'root0'], [docs[1].$id, 'root1']]));
    expect(page.preloaded.stats?.get(docs[0].$id)?.replies).toBe(4);
    expect(page.posts[1].replies).toBe(1);
  });

  it('reads the viewer\'s own quotes and reposts beside the composite, not inside it', async () => {
    mocks.composite.mockImplementation(echo(docs));
    mocks.getOwnQuotes.mockResolvedValue(new Map([[docs[2].$id, { id: 'myRepost', bare: true }]]));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20, currentUserId: ownerIds[0] });
    const subs: Sub[] = mocks.composite.mock.calls[0][0].subQueries;
    // No $ownerId-bound post sub-query: beside an ownerAndTime page it would be refused.
    expect(subs.filter((sub) => sub.documentType === 'post').map((sub) => sub.kind ?? 'documents')).toEqual(['counts', 'documents']);
    expect(subs.some((sub) => sub.documentType === 'repost')).toBe(false);
    expect(mocks.getOwnQuotes).toHaveBeenCalledWith(ownerIds[0], docs.map((doc) => doc.$id), 'post');
    expect(page.preloaded.interactions?.get(docs[2].$id)).toEqual({ liked: false, reposted: true, bookmarked: false, ownQuote: { id: 'myRepost', bare: true } });
    expect(page.preloaded.interactions?.get(docs[0].$id)?.reposted).toBe(false);
  });

  it.each([
    ['post', 'like', 'postId'],
    ['reply', 'likeReply', 'replyId'],
  ] as const)('caps the viewer-likes %s slot at the page size: byPost/byReply are not value-bounded', async (kind, docType, field) => {
    mocks.composite.mockImplementation(echo(docs));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    await loadCompositeFeedPage({ language: 'en', limit: 20, kind, currentUserId: ownerIds[0] });
    const subs: (Sub & { limit?: number })[] = mocks.composite.mock.calls[0][0].subQueries;
    expect(subs.find((sub) => sub.documentType === docType && sub.kind === undefined)).toEqual({
      documentType: docType, where: [['$ownerId', '==', ownerIds[0]]], bind: { source: 'page', sourceProperty: '$id', field }, limit: 20,
    });
  });
});

describe('composite feed page on v9', () => {
  it('leaves the viewer-likes slot without a limit: byLiker is value-bounded and refuses one', async () => {
    const response = result();
    response.subResults.push({ kind: 'documents', documents: [] }, { kind: 'documents', documents: [] });
    mocks.composite.mockResolvedValue(response);
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    await loadCompositeFeedPage({ language: 'en', limit: 20, currentUserId: ownerIds[0] });
    const subs: { documentType: string; kind?: string; limit?: number }[] = mocks.composite.mock.calls[0][0].subQueries;
    const myLikes = subs.find((sub) => sub.documentType === 'like' && sub.kind === undefined);
    expect(myLikes).toBeDefined();
    expect(myLikes).not.toHaveProperty('limit');
  });
});
