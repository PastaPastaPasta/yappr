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

  it('restores the v2 author the same way', () => {
    const payload = replacePayload({ author: ownerId });
    expect(payload.author).toBeInstanceOf(Uint8Array);
    expect(Array.from(payload.author as Uint8Array)).toEqual(Array.from(bs58.decode(ownerId)));
  });

  it('drops an undecodable identifier instead of throwing, so the required-field error speaks', () => {
    // transformDocument reports a field it could not decode as ''.
    const payload = replacePayload({ author: '' });
    expect(payload.author).toBeUndefined();
    expect(payload.blogId).toBeInstanceOf(Uint8Array);
  });

  it('carries no author on v1, where the property does not exist', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v1');
    const payload = replacePayload({});
    expect(payload.author).toBeUndefined();
    expect(payload.blogId).toBeInstanceOf(Uint8Array);
  });
});
