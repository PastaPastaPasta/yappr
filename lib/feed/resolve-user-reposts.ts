import type { Post } from '@/lib/types'
import type { RepostDocument } from '@/lib/services/repost-service'

/** Newest activity first: a repost sorts by when it was reposted, not written. */
export function byNewestActivity(a: Post, b: Post): number {
  const aTime = a.repostTimestamp?.getTime() || a.createdAt.getTime()
  const bTime = b.repostTimestamp?.getTime() || b.createdAt.getTime()
  return bTime - aTime
}

/**
 * The posts `userId` reposted, each stamped with `repostedBy` so a card can
 * say who shared it. Their own posts are skipped; those already show as posts.
 * `displayName` is what the card shows when the reposter has no DPNS name.
 */
export async function resolveUserReposts(userId: string, reposts: RepostDocument[], displayName: string): Promise<Post[]> {
  if (reposts.length === 0) return []
  const { postService } = await import('@/lib/services/post-service')
  const originals = new Map((await postService.getPostsByIds(reposts.map((r) => r.postId).filter(Boolean))).map((p) => [p.id, p]))

  let username: string | undefined
  try {
    const { dpnsService } = await import('@/lib/services/dpns-service')
    username = (await dpnsService.resolveUsername(userId)) || undefined
  } catch {
    // The reposter's name is decoration; the card falls back to the display name.
  }

  const entries: Post[] = []
  for (const repost of reposts) {
    const original = originals.get(repost.postId)
    if (original && original.author.id !== userId) {
      entries.push({
        ...original,
        repostedBy: { id: userId, displayName, username },
        repostTimestamp: new Date(repost.$createdAt),
      })
    }
  }
  return entries
}
