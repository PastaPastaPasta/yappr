import { postService } from '@/lib/services/post-service'

const PAGE_SIZE = 100

/** Search one bounded timeline page, advancing past every scanned document. */
export async function searchPostPage(query: string, startAfter?: string) {
  const { documents } = await postService.getTimeline({ limit: PAGE_SIZE, startAfter })
  const needle = query.trim().toLowerCase()
  return {
    posts: documents
      .filter(post => !post.deleted && post.content.toLowerCase().includes(needle))
      .map(post => ({
        ...post,
        author: { ...post.author, username: '', displayName: '', avatar: '', hasDpns: undefined },
      })),
    cursor: documents.at(-1)?.id ?? startAfter,
    scanned: documents.length,
    hasMore: documents.length === PAGE_SIZE,
  }
}
