import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: {} }) }));
import { blogPostService } from './blog-post-service';
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
    expect(create).not.toHaveBeenCalled();
  });

  it('does not retry a failure that is not a rate limit', async () => {
    const lookup = vi.spyOn(blogPostService, 'getPostBySlug').mockRejectedValue(new Error('invalid query'));
    await expect(blogPostService.createPost(ownerId, { blogId, title: 'Hello', content })).rejects.toThrow('invalid query');
    expect(lookup).toHaveBeenCalledOnce();
  });
});
