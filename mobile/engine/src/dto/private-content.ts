import type { Post } from '@/lib/types'

/**
 * The encrypted fields of the private posts and replies the engine has handed
 * the host, by id. A `PostDTO` carries no ciphertext (`api/dto.ts`), so
 * `privateFeed.read` finds it here instead of reading the post again; a miss
 * (an id the host kept across an engine restart) reads it from the network.
 * Ciphertext only: nothing here is a key or plaintext.
 */
export type PrivatePostRecord = Pick<
  Post,
  'id' | 'author' | 'content' | 'encryptedContent' | 'nonce' | 'keyGeneration' | 'feed' | 'targetKind' | 'parentId' | 'rootPostId' | 'rootOwnerId'
>

/** Enough for a few screens of private posts; the oldest go first. */
const MAX_RECORDS = 500
const records = new Map<string, PrivatePostRecord>()

/** Keep `post`'s encrypted fields when it is private (called for every post mapped to a DTO). */
export function rememberPrivatePost(post: Post): void {
  if (post.encryptedContent === undefined) return
  const { id, author, content, encryptedContent, nonce, keyGeneration, feed, targetKind, parentId, rootPostId, rootOwnerId } = post
  records.delete(id)
  records.set(id, { id, author: { ...author }, content, encryptedContent, nonce, keyGeneration, feed, targetKind, parentId, rootPostId, rootOwnerId })
  if (records.size > MAX_RECORDS) records.delete(records.keys().next().value as string)
}

export function privatePostOf(id: string): PrivatePostRecord | null {
  return records.get(id) ?? null
}

/** Whether `id` is a private post or reply the engine has seen. */
export function isKnownPrivate(id: string | undefined): boolean {
  return id !== undefined && records.has(id)
}
