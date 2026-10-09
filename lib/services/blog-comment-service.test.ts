import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';

const sdk = vi.hoisted(() => ({
  documents: { count: vi.fn(), query: vi.fn() },
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }));
const bundle = vi.hoisted(() => ({ queryDocumentBundle: vi.fn() }));
vi.mock('./document-query-bundle', () => bundle);
import { blogCommentService } from './blog-comment-service';

const postA = bs58.encode(new Uint8Array(32).fill(1));
const postB = bs58.encode(new Uint8Array(32).fill(2));
/** The grouped-count key encoding: hex of the bound identifier's bytes. */
const hexOf = (id: string) => Buffer.from(bs58.decode(id)).toString('hex');

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v2');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('comment counts on the v2 contract', () => {
  it('counts one post with a single proved count, no cursor scan', async () => {
    sdk.documents.count.mockResolvedValue(new Map([['', 4n]]));
    expect(await blogCommentService.countCommentsByPost(postA)).toBe(4);
    expect(sdk.documents.count).toHaveBeenCalledTimes(1);
    expect(sdk.documents.count).toHaveBeenCalledWith(
      expect.objectContaining({ documentTypeName: 'blogComment', where: [['blogPostId', '==', postA]] })
    );
    // A count query must carry no orderBy/limit — Drive rejects those.
    const query = sdk.documents.count.mock.calls[0][0];
    expect(query).not.toHaveProperty('orderBy');
    expect(query).not.toHaveProperty('limit');
  });

  it('reports zero for a post whose count tree is unmaterialized', async () => {
    sdk.documents.count.mockResolvedValue(new Map());
    expect(await blogCommentService.countCommentsByPost(postA)).toBe(0);
  });

  it('counts a whole post list in one grouped request', async () => {
    sdk.documents.count.mockResolvedValue(new Map([[hexOf(postA), 2n], [hexOf(postB), 5n]]));
    const counts = await blogCommentService.countCommentsByPostBatch([postA, postB, postA]);
    expect(counts.get(postA)).toBe(2);
    expect(counts.get(postB)).toBe(5);
    expect(sdk.documents.count).toHaveBeenCalledTimes(1);
    expect(sdk.documents.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: [['blogPostId', 'in', [postA, postB]]], groupBy: ['blogPostId'] })
    );
    expect(bundle.queryDocumentBundle).not.toHaveBeenCalled();
  });

  it('falls back to per-post counts when the grouped keys do not decode', async () => {
    sdk.documents.count
      .mockResolvedValueOnce(new Map([['deadbeef', 9n]]))
      .mockResolvedValue(new Map([['', 1n]]));
    const counts = await blogCommentService.countCommentsByPostBatch([postA, postB]);
    expect(counts.get(postA)).toBe(1);
    expect(counts.get(postB)).toBe(1);
  });
});

describe('comment counts on the v1 contract', () => {
  it('bundles first pages instead of counting', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v1');
    bundle.queryDocumentBundle.mockResolvedValue([[{}, {}], [{}]]);
    const counts = await blogCommentService.countCommentsByPostBatch([postA, postB]);
    expect(counts.get(postA)).toBe(2);
    expect(counts.get(postB)).toBe(1);
    expect(sdk.documents.count).not.toHaveBeenCalled();
  });
});

describe('comments on my posts', () => {
  it('is empty on v1, where the postOwnerAndTime index does not exist', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v1');
    expect(await blogCommentService.getCommentsOnMyPosts(postA, 0)).toEqual([]);
    expect(sdk.documents.query).not.toHaveBeenCalled();
  });

  it('pins the copied blogPostOwnerId up to v5', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v5');
    const query = vi.spyOn(blogCommentService, 'query').mockResolvedValue({ documents: [] } as never);
    await blogCommentService.getCommentsOnMyPosts(postA, 5);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      where: [['blogPostOwnerId', '==', postA], ['$createdAt', '>', 5]],
      orderBy: [['blogPostOwnerId', 'asc'], ['$createdAt', 'desc']],
    }));
  });

  it('pins the derived blogPostId.$ownerId on v6', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v6');
    const query = vi.spyOn(blogCommentService, 'query').mockResolvedValue({ documents: [] } as never);
    await blogCommentService.getCommentsOnMyPosts(postA, 5);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      where: [['blogPostId.$ownerId', '==', postA], ['$createdAt', '>', 5]],
      orderBy: [['blogPostId.$ownerId', 'asc'], ['$createdAt', 'desc']],
    }));
  });
});

describe('creating a comment', () => {
  const author = bs58.encode(new Uint8Array(32).fill(7));
  const reader = bs58.encode(new Uint8Array(32).fill(8));
  const withPost = async (post: Record<string, unknown> | null) => {
    const { blogPostService } = await import('./blog-post-service');
    vi.spyOn(blogPostService, 'getPost').mockResolvedValue(post as never);
    return vi.spyOn(blogCommentService, 'create').mockResolvedValue({ id: 'c' } as never);
  };

  it('on v5 copies a post\'s commentsEnabled: true into postCommentsEnabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v5');
    const create = await withPost({ ownerId: author, commentsEnabled: true });
    await blogCommentService.createComment(reader, postA, author, ' hi ');
    expect(create).toHaveBeenCalledWith(reader, expect.objectContaining({ content: 'hi', postCommentsEnabled: true }));
  });

  it('on v5 leaves postCommentsEnabled out when the post leaves commentsEnabled out (both absent agree)', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v5');
    const create = await withPost({ ownerId: author });
    await blogCommentService.createComment(reader, postA, author, 'hi');
    expect(create.mock.calls[0][1]).not.toHaveProperty('postCommentsEnabled');
  });

  it('on v5 refuses before paying when comments are off, or when the post cannot be read', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v5');
    const create = await withPost({ ownerId: author, commentsEnabled: false });
    await expect(blogCommentService.createComment(reader, postA, author, 'hi')).rejects.toThrow(/turned off/);
    await withPost(null);
    await expect(blogCommentService.createComment(reader, postA, author, 'hi')).rejects.toThrow(/Could not load/);
    expect(create).not.toHaveBeenCalled();
  });

  it('on v5 re-reads the post past the cache after a 40127 and stops if comments were just turned off', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v5');
    const { blogPostService } = await import('./blog-post-service');
    const getPost = vi.spyOn(blogPostService, 'getPost')
      .mockResolvedValueOnce({ ownerId: author, commentsEnabled: true } as never)
      .mockResolvedValueOnce({ ownerId: author, commentsEnabled: false } as never);
    const clearCache = vi.spyOn(blogPostService, 'clearCache');
    const create = vi.spyOn(blogCommentService, 'create').mockRejectedValue(new Error('refused (code=40127)'));
    await expect(blogCommentService.createComment(reader, postA, author, 'hi')).rejects.toThrow(/turned off/);
    expect(clearCache).toHaveBeenCalledWith(postA);
    expect(getPost).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('on v5 retries once with the fresh flag after a 40127', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v5');
    const { blogPostService } = await import('./blog-post-service');
    vi.spyOn(blogPostService, 'getPost')
      .mockResolvedValueOnce({ ownerId: author } as never)
      .mockResolvedValueOnce({ ownerId: author, commentsEnabled: true } as never);
    const create = vi.spyOn(blogCommentService, 'create')
      .mockRejectedValueOnce(new Error('refused (code=40127)'))
      .mockResolvedValueOnce({ id: 'c' } as never);
    await blogCommentService.createComment(reader, postA, author, 'hi');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][1]).not.toHaveProperty('postCommentsEnabled');
    expect(create.mock.calls[1][1]).toMatchObject({ postCommentsEnabled: true });
  });

  it('on v5 never sends a null commentsEnabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v5');
    const create = await withPost({ ownerId: author, commentsEnabled: null });
    await blogCommentService.createComment(reader, postA, author, 'hi');
    expect(create.mock.calls[0][1]).not.toHaveProperty('postCommentsEnabled');
  });

  it('on v5 copies the post owner into blogPostOwnerId', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v5');
    const create = await withPost({ ownerId: author, commentsEnabled: true });
    await blogCommentService.createComment(reader, postA, reader, 'hi');
    expect(create.mock.calls[0][1]).toHaveProperty('blogPostOwnerId', bs58.decode(author));
  });

  it('on v6 leaves blogPostOwnerId out (derived through blogPostId) and still copies commentsEnabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v6');
    const create = await withPost({ ownerId: author, commentsEnabled: true });
    await blogCommentService.createComment(reader, postA, author, 'hi');
    expect(create.mock.calls[0][1]).not.toHaveProperty('blogPostOwnerId');
    expect(create.mock.calls[0][1]).toMatchObject({ content: 'hi', postCommentsEnabled: true });
  });

  it('on v4 never sends postCommentsEnabled, which that contract does not have', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v4');
    const create = await withPost({ ownerId: author, commentsEnabled: true });
    await blogCommentService.createComment(reader, postA, author, 'hi');
    expect(create.mock.calls[0][1]).not.toHaveProperty('postCommentsEnabled');
  });
});

describe('commenting on blog v7', () => {
  const author = bs58.encode(new Uint8Array(32).fill(7));
  const reader = bs58.encode(new Uint8Array(32).fill(8));

  it('refuses a deleted post before signing, naming why', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v7');
    const { blogPostService } = await import('./blog-post-service');
    vi.spyOn(blogPostService, 'getPost').mockResolvedValue({ ownerId: author, deleted: true, commentsEnabled: false } as never);
    const create = vi.spyOn(blogCommentService, 'create').mockResolvedValue({ id: 'c' } as never);
    await expect(blogCommentService.createComment(reader, postA, author, 'hi')).rejects.toThrow(/deleted/);
    expect(create).not.toHaveBeenCalled();
  });

  it('writes a v7 comment exactly as v6 does: the copied flag, no post owner', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v7');
    const { blogPostService } = await import('./blog-post-service');
    vi.spyOn(blogPostService, 'getPost').mockResolvedValue({ ownerId: author, commentsEnabled: true } as never);
    const create = vi.spyOn(blogCommentService, 'create').mockResolvedValue({ id: 'c' } as never);
    await blogCommentService.createComment(reader, postA, author, 'hi');
    expect(create.mock.calls[0][1]).toMatchObject({ content: 'hi', postCommentsEnabled: true });
    expect(create.mock.calls[0][1]).not.toHaveProperty('blogPostOwnerId');
  });
});
