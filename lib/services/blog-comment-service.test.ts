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
});
