import type { PostDTO } from '@engine/api';

/** Still saved: a bookmark the viewer just removed leaves the list at once (the optimistic mark). */
export function stillBookmarked(post: PostDTO): boolean {
  return post.viewer?.bookmarked !== false;
}

/** "Search bookmarks": the posts whose text, author name or username contains the query. */
export function filterBookmarks(posts: readonly PostDTO[], query: string): PostDTO[] {
  const needle = query.trim().replace(/^@/, '').toLowerCase();
  if (!needle) return [...posts];
  return posts.filter(
    (post) =>
      post.content.toLowerCase().includes(needle) ||
      post.author.displayName.toLowerCase().includes(needle) ||
      (post.author.username ?? '').toLowerCase().includes(needle),
  );
}
