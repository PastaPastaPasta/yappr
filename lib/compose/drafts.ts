import { hasVisibleContent } from '@/lib/compose/limits'

/** The slice of a composer thread part that decides whether a draft is worth keeping. */
export interface DraftPartLike {
  content: string
  teaser?: string
  postedPostId?: string
}

/** What the composer is writing to: a new post, a reply, or a quote. Only the ids matter for keying. */
export interface DraftTarget {
  replyingTo?: { id: string } | null
  quotingPost?: { id: string } | null
}

export const NEW_POST_DRAFT_KEY = 'post'

/**
 * Which draft a composer session belongs to. A draft for reply X is a
 * different draft from one for reply Y, a quote of X, or a fresh post, so
 * text typed for one target never shows up under another.
 */
export function composeDraftKey({ replyingTo, quotingPost }: DraftTarget): string {
  if (replyingTo) return `reply:${replyingTo.id}`
  if (quotingPost) return `quote:${quotingPost.id}`
  return NEW_POST_DRAFT_KEY
}

/**
 * Whether dismissing the composer would lose something the author typed.
 * Parts already posted are not a draft: they are on the network.
 */
export function hasUnpostedContent(parts: readonly DraftPartLike[]): boolean {
  return parts.some((p) => !p.postedPostId && (hasVisibleContent(p.content) || hasVisibleContent(p.teaser ?? '')))
}

/**
 * Move the composer from the draft it holds to the one for `nextKey`. The
 * held draft is stashed under its own key (when it has content) and the
 * stashed draft for `nextKey` comes back, or a fresh one when there is none.
 * A draft is either live or stashed, never both.
 */
export function switchDraft<D>(args: {
  currentKey: string
  current: D
  isEmpty: (draft: D) => boolean
  nextKey: string
  stash: Readonly<Record<string, D>>
  fresh: () => D
}): { draft: D; stash: Record<string, D> } {
  const { currentKey, current, isEmpty, nextKey, stash, fresh } = args
  if (currentKey === nextKey) return { draft: current, stash: { ...stash } }
  const nextStash = { ...stash }
  if (isEmpty(current)) delete nextStash[currentKey]
  else nextStash[currentKey] = current
  const draft = nextStash[nextKey] ?? fresh()
  delete nextStash[nextKey]
  return { draft, stash: nextStash }
}
