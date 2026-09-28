import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: {} }) }));
import { PrePublishRateLimitError, blogPostService } from './blog-post-service';
import type { BlogPost } from '@/lib/types';

const blogId = bs58.encode(new Uint8Array(32).fill(3));
const ownerId = bs58.encode(new Uint8Array(32).fill(4));

/** `update()` re-derives the full replace payload from the transformed document. */
function replacePayload(post: Partial<BlogPost>): Record<string, unknown> {
  const service = blogPostService as unknown as {
    extractContentFields(doc: BlogPost): Record<string, unknown>;
  };
  return service.extractContentFields({
    id: 'post', ownerId, createdAt: new Date(), blogId, title: 'T', content: [], slug: 's',
    ...post,
  } as BlogPost);
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v2');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('identifier encoding on the edit path', () => {
  it('restores blogId to raw bytes so an edit does not rewrite it as base58', () => {
    const payload = replacePayload({});
    expect(payload.blogId).toBeInstanceOf(Uint8Array);
    expect(Array.from(payload.blogId as Uint8Array)).toEqual(Array.from(bs58.decode(blogId)));
  });

  it('drops an undecodable identifier instead of throwing, so the required-field error speaks', () => {
    // transformDocument reports a field it could not decode as ''.
    const payload = replacePayload({ blogId: '' });
    expect(payload.blogId).toBeUndefined();
    expect(payload.title).toBe('T');
  });

  it('carries no attested author on either topology — the post owner IS the author', () => {
    const payload = replacePayload({});
    expect(payload.author).toBeUndefined();
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v1');
    expect(replacePayload({}).author).toBeUndefined();
  });
});

describe('the pre-publish slug check (QA D-54)', () => {
  // What the SDK rejects with when the DAPI gateway throttles: a WasmSdkError, not an Error.
  const rateLimited = { message: 'no available addresses to retry, last error: grpc error: code: \'Some resource has been exhausted\', message: "rate limited"' };
  const content = [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function spyCreate() {
    const service = blogPostService as unknown as { create(ownerId: string, data: Record<string, unknown>): Promise<BlogPost> };
    return vi.spyOn(service, 'create').mockImplementation(async (_owner, data) => ({ id: 'new', slug: data.slug } as BlogPost));
  }

  it('retries a rate-limited lookup instead of failing the publish outright', async () => {
    const lookup = vi.spyOn(blogPostService, 'getPostBySlug')
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(null);
    const create = spyCreate();

    const published = blogPostService.createPost(ownerId, { blogId, title: 'Hello', content });
    await vi.runAllTimersAsync();

    await expect(published).resolves.toMatchObject({ slug: 'hello' });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
  });

  it('gives up with the gateway\'s message (for the rate-limit toast) when it stays throttled', async () => {
    vi.spyOn(blogPostService, 'getPostBySlug').mockRejectedValue(rateLimited);
    const create = spyCreate();

    const published = blogPostService.createPost(ownerId, { blogId, title: 'Hello', content });
    const settled = expect(published).rejects.toThrow(/rate limited/);
    await vi.runAllTimersAsync();
    await settled;
    // Typed apart from a rate limit on the write itself, which may follow a broadcast that landed.
    await expect(published).rejects.toBeInstanceOf(PrePublishRateLimitError);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not mark a rate limit from the write itself as pre-publish', async () => {
    vi.spyOn(blogPostService, 'getPostBySlug').mockResolvedValue(null);
    const service = blogPostService as unknown as { create(ownerId: string, data: Record<string, unknown>): Promise<BlogPost> };
    vi.spyOn(service, 'create').mockRejectedValue(new Error(rateLimited.message));

    const published = blogPostService.createPost(ownerId, { blogId, title: 'Hello', content });
    await expect(published).rejects.toThrow(/rate limited/);
    await expect(published).rejects.not.toBeInstanceOf(PrePublishRateLimitError);
  });

  it('does not retry a failure that is not a rate limit', async () => {
    const lookup = vi.spyOn(blogPostService, 'getPostBySlug').mockRejectedValue(new Error('invalid query'));
    await expect(blogPostService.createPost(ownerId, { blogId, title: 'Hello', content })).rejects.toThrow('invalid query');
    expect(lookup).toHaveBeenCalledOnce();
  });
});

describe('public discovery reads past drafts (QA D-27)', () => {
  const otherBlogId = bs58.encode(new Uint8Array(32).fill(5));
  const post = (id: string, forBlog: string, createdAt: number, publishedAt?: number) =>
    ({ id, blogId: forBlog, ownerId, createdAt: new Date(createdAt), title: id, content: [], slug: id, publishedAt } as BlogPost);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills a blog\'s slot past a newer draft instead of dropping its published article', async () => {
    const draft = post('draft', blogId, 3_000);
    const article = post('article', blogId, 2_000, 2_000);
    const other = post('other', otherBlogId, 1_000, 1_000);
    vi.spyOn(blogPostService, 'getPostsByBlogs').mockResolvedValue(new Map([[blogId, [draft]], [otherBlogId, [other]]]));
    const refill = vi.spyOn(blogPostService, 'getPostsByBlog').mockResolvedValue([article]);

    const recent = await blogPostService.getRecentPosts([blogId, otherBlogId], 2);

    expect(recent.map((item) => item.id)).toEqual(['article', 'other']);
    expect(refill).toHaveBeenCalledOnce();
    expect(refill).toHaveBeenCalledWith(blogId, { limit: 20, startAfter: 'draft' });
  });

  it('keeps the blog\'s newest publication when a refill returns a backdated import first', async () => {
    const draft = post('draft', blogId, 3_000);
    const imported = post('imported', blogId, 2_500, 100);
    const newer = post('newer', blogId, 2_000, 2_000);
    vi.spyOn(blogPostService, 'getPostsByBlogs').mockResolvedValue(new Map([[blogId, [draft]]]));
    vi.spyOn(blogPostService, 'getPostsByBlog').mockResolvedValue([imported, newer]);

    const recent = await blogPostService.getRecentPosts([blogId, otherBlogId], 1);

    expect(recent.map((item) => item.id)).toEqual(['newer']);
  });

  it('stops reading once the slots are filled, even by a backdated import (documented limit)', async () => {
    const minute = 60_000;
    const imported = post('imported', blogId, 300 * minute, 10 * minute);
    vi.spyOn(blogPostService, 'getPostsByBlogs').mockResolvedValue(new Map([[blogId, [imported]]]));
    const refill = vi.spyOn(blogPostService, 'getPostsByBlog');

    expect((await blogPostService.getRecentPosts([blogId, otherBlogId], 1)).map((item) => item.id)).toEqual(['imported']);
    expect(refill).not.toHaveBeenCalled();
  });

  it('does not read on for a live publish, whose date trails its creation by moments', async () => {
    const live = post('live', blogId, 300_000, 298_000);
    vi.spyOn(blogPostService, 'getPostsByBlogs').mockResolvedValue(new Map([[blogId, [live]]]));
    const refill = vi.spyOn(blogPostService, 'getPostsByBlog');

    expect((await blogPostService.getRecentPosts([blogId, otherBlogId], 1)).map((item) => item.id)).toEqual(['live']);
    expect(refill).not.toHaveBeenCalled();
  });

  it('does not read on when the first page already ended the blog\'s history', async () => {
    vi.spyOn(blogPostService, 'getPostsByBlogs').mockResolvedValue(new Map([[blogId, [post('draft', blogId, 3_000)]]]));
    const refill = vi.spyOn(blogPostService, 'getPostsByBlog');

    expect(await blogPostService.searchPosts([blogId], 'draft')).toEqual([]);
    expect(refill).not.toHaveBeenCalled();
  });

  it('stops reading after a bounded number of all-draft pages', async () => {
    const drafts = (prefix: string) => Array.from({ length: 20 }, (_, index) => post(`${prefix}${index}`, blogId, 1_000 - index));
    vi.spyOn(blogPostService, 'getPostsByBlogs').mockResolvedValue(new Map([[blogId, drafts('first')]]));
    const refill = vi.spyOn(blogPostService, 'getPostsByBlog').mockImplementation(async () => drafts('next'));

    expect(await blogPostService.searchPosts([blogId], 'x')).toEqual([]);
    expect(refill).toHaveBeenCalledTimes(3);
  });
});
