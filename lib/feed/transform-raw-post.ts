import { Post } from '@/lib/types';
import { identifierToBase58, normalizeBytes } from '@/lib/services/sdk-helpers';

function createPlaceholderPostId(): string {
  return Math.random().toString(36).slice(2, 11);
}

export function getFeedItemTimestamp(post: Post): number {
  const feedItem = post as Post & { repostTimestamp?: Date | string };

  if (feedItem.repostTimestamp instanceof Date) {
    return feedItem.repostTimestamp.getTime();
  }

  if (typeof feedItem.repostTimestamp === 'string') {
    return new Date(feedItem.repostTimestamp).getTime();
  }

  if (post.createdAt instanceof Date) {
    return post.createdAt.getTime();
  }

  return new Date(post.createdAt).getTime();
}

export function sortFeedByTimestamp(posts: Post[]): Post[] {
  return posts.sort((a, b) => getFeedItemTimestamp(b) - getFeedItemTimestamp(a));
}

export function transformRawPost(doc: Record<string, unknown>): Post {
  const data = (doc.data || doc) as Record<string, unknown>;
  const existingAuthor = (doc.author || {}) as Record<string, unknown>;
  const authorId = (existingAuthor.id || doc.$ownerId || doc.ownerId || 'unknown') as string;

  const rawQuotedPostId = data.quotedPostId || doc.quotedPostId;
  const quotedPostId = rawQuotedPostId ? identifierToBase58(rawQuotedPostId) || undefined : undefined;

  const rawEncryptedContent = data.encryptedContent || doc.encryptedContent;
  const rawNonce = data.nonce || doc.nonce;
  const epoch = (data.epoch ?? doc.epoch) as number | undefined;

  const username = (existingAuthor.username as string | undefined) || '';
  const hasResolvedUsername = Boolean(username && !username.startsWith('user_'));

  const createdAtValue = doc.$createdAt || doc.createdAt;
  const createdAt = createdAtValue instanceof Date
    ? createdAtValue
    : new Date((createdAtValue as number | string | undefined) || Date.now());

  return {
    id: (doc.$id || doc.id || createPlaceholderPostId()) as string,
    content: (data.content || '') as string,
    author: {
      id: authorId,
      username,
      displayName: hasResolvedUsername ? ((existingAuthor.displayName as string | undefined) || '') : '',
      avatar: '',
      followers: 0,
      following: 0,
      verified: false,
      joinedAt: new Date(),
      hasDpns: hasResolvedUsername ? true : undefined,
    },
    createdAt,
    likes: (doc.likes as number | undefined) || 0,
    replies: (doc.replies as number | undefined) || 0,
    reposts: (doc.reposts as number | undefined) || 0,
    views: (doc.views as number | undefined) || 0,
    liked: (doc.liked as boolean | undefined) || false,
    reposted: (doc.reposted as boolean | undefined) || false,
    bookmarked: (doc.bookmarked as boolean | undefined) || false,
    quotedPostId,
    encryptedContent: rawEncryptedContent ? normalizeBytes(rawEncryptedContent) ?? undefined : undefined,
    epoch,
    nonce: rawNonce ? normalizeBytes(rawNonce) ?? undefined : undefined,
  };
}
