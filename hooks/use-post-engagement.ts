'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { reportBarredWrite } from '@/components/moderation/barred-writer-notice'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import { canBookmark, canRepost, repostsAreQuotes, type TargetKind } from '@/lib/contract-topology'
import { categorizeError, isDuplicateUniqueIndexError, isFrozenBalanceError } from '@/lib/error-utils'
import type { OwnQuote } from '@/lib/feed/quote-reposts'
import { handleInsufficientYapp } from '@/hooks/use-buy-yapp-modal'
import { isUnconfirmed, settleUnconfirmed } from '@/lib/unconfirmed-writes'

export interface EngagementSnapshot {
  liked: boolean
  likes: number
  reposted: boolean
  reposts: number
  bookmarked: boolean
  /** v10: the viewer's quote or bare repost of the post, when known. */
  ownQuote?: OwnQuote
}

/** Frozen accounts cannot spend at all, so say that instead of offering YAPP. */
function reportSpendError(error: unknown, viewerId: string | undefined, buyReason: string, fallback: string) {
  if (reportBarredWrite(error, viewerId)) return
  if (isFrozenBalanceError(error)) toast.error(categorizeError(error))
  else if (!handleInsufficientYapp(error, buyReason)) toast.error(fallback)
}

/** v10: the viewer's quote or repost of `postId` as the chain has it (null when none, or unreadable). */
async function lookupOwnQuote(postId: string, viewerId: string, targetKind: TargetKind): Promise<OwnQuote | null> {
  const { postService } = await import('@/lib/services/post-service')
  return (await postService.getOwnQuotes(viewerId, [postId], targetKind)).get(postId) ?? null
}

/**
 * v10: repost `post` as a content-less quote post. One quote or repost per
 * author and target (40105 on a second): the caller's state said there was
 * none, and consensus is the final word.
 */
async function createBareRepost(post: Post, viewerId: string): Promise<OwnQuote> {
  const [{ postService }, { resolveQuoteReference }] = await Promise.all([
    import('@/lib/services/post-service'),
    import('@/lib/feed/resolve-quoted-posts'),
  ])
  const created = await postService.createPost(viewerId, '', { ...resolveQuoteReference(post).fields })
  return { id: created.id, bare: true }
}

/**
 * A card's like, repost and bookmark state with optimistic flips that roll
 * back on failure. Each write names the post, and on v9 that reference is
 * consensus-checked, so a post this session created but never saw confirmed
 * is settled first; the check is a no-op off the DAPI-timeout path.
 *
 * On v10 a repost is a content-less quote post: reposting creates one (a
 * post, priced as a post), undoing it deletes the viewer's quote or repost of
 * the target, and `ownQuote` says which of the two the viewer holds so the
 * card can confirm before deleting a quote with text and offer "View your
 * quote" instead of composing a second (which consensus refuses).
 */
export function usePostEngagement(post: Post, viewerId: string | undefined, initial: EngagementSnapshot, targetKind: TargetKind) {
  // The v9 topology forbids reposting or bookmarking a reply at all.
  const repostable = canRepost(targetKind)
  const bookmarkable = canBookmark(targetKind)
  const [liked, setLiked] = useState(initial.liked)
  const [likes, setLikes] = useState(initial.likes)
  const [reposted, setReposted] = useState(initial.reposted)
  const [reposts, setReposts] = useState(initial.reposts)
  const [ownQuote, setOwnQuote] = useState<OwnQuote | null>(initial.ownQuote ?? null)
  const [bookmarked, setBookmarked] = useState(initial.bookmarked)
  const [likeLoading, setLikeLoading] = useState(false)
  const [repostLoading, setRepostLoading] = useState(false)
  const [bookmarkLoading, setBookmarkLoading] = useState(false)

  // Follow the enrichment snapshot as it fills in.
  useEffect(() => {
    setLiked(initial.liked)
    setLikes(initial.likes)
    setReposted(initial.reposted)
    setReposts(initial.reposts)
    setBookmarked(initial.bookmarked)
  }, [initial.liked, initial.likes, initial.reposted, initial.reposts, initial.bookmarked])
  const initialQuoteId = initial.ownQuote?.id
  const initialQuoteBare = initial.ownQuote?.bare
  useEffect(() => {
    setOwnQuote(initialQuoteId ? { id: initialQuoteId, bare: initialQuoteBare === true } : null)
  }, [initialQuoteId, initialQuoteBare])

  const settle = useCallback(async () => {
    if (isUnconfirmed(post.id) && !(await settleUnconfirmed(post.id))) {
      throw new Error('This post has not confirmed yet. Try again in a moment.')
    }
  }, [post.id])

  const toggleLike = useCallback(async () => {
    if (!viewerId || likeLoading) return
    const wasLiked = liked
    const prevLikes = likes
    setLiked(!wasLiked)
    setLikes(wasLiked ? prevLikes - 1 : prevLikes + 1)
    setLikeLoading(true)
    try {
      await settle()
      const { likeService } = await import('@/lib/services/like-service')
      // On v9 the like repeats the target's author and hashtag under a
      // consensus-checked agreement; passing them saves the service a fetch.
      const targetInfo = { author: post.author.id, hashtag: post.hashtag }
      const ok = wasLiked
        ? await likeService.unlikePost(post.id, viewerId, targetKind, targetInfo)
        : await likeService.likePost(post.id, viewerId, post.author.id, targetKind, targetInfo)
      if (!ok) throw new Error('Like operation failed')
    } catch (error) {
      setLiked(wasLiked)
      setLikes(prevLikes)
      logger.error('Like error:', error)
      reportSpendError(error, viewerId, 'You need YAPP to like posts. Buy some to continue.', 'Failed to update like. Please try again.')
    } finally {
      setLikeLoading(false)
    }
  }, [viewerId, likeLoading, liked, likes, settle, post.id, post.author.id, post.hashtag, targetKind])

  /**
   * v10: delete the viewer's quote or repost of the post. Callers confirm a
   * quote with text first ({@link toggleRepost} hands such a quote back).
   */
  const removeOwnQuote = useCallback(async (quote: OwnQuote) => {
    if (!viewerId) return
    const prevReposts = reposts
    setReposted(false)
    setReposts(Math.max(0, prevReposts - 1))
    setRepostLoading(true)
    try {
      const { postService } = await import('@/lib/services/post-service')
      // v11: a tombstone that clears the quote, freeing the slot for a redo.
      if (!(await postService.deleteOwnPost(quote.id, viewerId))) throw new Error('Repost operation failed')
      setOwnQuote(null)
      toast.success(quote.bare ? 'Removed repost' : 'Quote deleted')
    } catch (error) {
      setReposted(true)
      setReposts(prevReposts)
      logger.error('Repost error:', error)
      toast.error('Failed to update repost. Please try again.')
    } finally {
      setRepostLoading(false)
    }
  }, [viewerId, reposts])

  /**
   * Repost, or undo the viewer's repost. On v10 undo deletes the viewer's
   * quote post; one WITH text is never deleted here but returned, for the
   * caller to confirm and then pass to {@link removeOwnQuote}. Resolves null
   * otherwise.
   */
  const toggleRepost = useCallback(async (): Promise<OwnQuote | null> => {
    // The topology may forbid reposting this kind (v9 replies); this guard, not
    // the action row, enforces it.
    if (!viewerId || !repostable || repostLoading) return null
    if (repostsAreQuotes() && reposted) {
      let quote = ownQuote
      if (!quote) {
        setRepostLoading(true)
        try {
          quote = await lookupOwnQuote(post.id, viewerId, targetKind)
        } finally {
          setRepostLoading(false)
        }
      }
      if (!quote) {
        logger.warn('Undo repost: no quote or repost of this post by the viewer was found; nothing to delete')
        setReposted(false)
        return null
      }
      setOwnQuote(quote)
      if (!quote.bare) return quote
      await removeOwnQuote(quote)
      return null
    }
    const wasReposted = reposted
    const prevReposts = reposts
    setReposted(!wasReposted)
    setReposts(wasReposted ? prevReposts - 1 : prevReposts + 1)
    setRepostLoading(true)
    try {
      // Removal needs no gate: the repost document already exists.
      if (!wasReposted) await settle()
      if (repostsAreQuotes()) {
        // (Undo returned above: here the viewer is reposting.)
        setOwnQuote(await createBareRepost(post, viewerId))
        toast.success('Reposted!')
        return null
      }
      const { repostService } = await import('@/lib/services/repost-service')
      const ok = wasReposted ? await repostService.removeRepost(post.id, viewerId) : await repostService.repostPost(post.id, viewerId, post.author.id)
      if (!ok) throw new Error('Repost operation failed')
      toast.success(wasReposted ? 'Removed repost' : 'Reposted!')
    } catch (error) {
      setReposted(wasReposted)
      setReposts(prevReposts)
      logger.error('Repost error:', error)
      if (repostsAreQuotes() && !wasReposted && isDuplicateUniqueIndexError(error)) {
        // The viewer already holds this target's one quote/repost slot (a stale
        // snapshot said otherwise).
        const existing = await lookupOwnQuote(post.id, viewerId, targetKind)
        if (existing?.bare) {
          // Their own earlier repost landed (a double click, or a lost ack):
          // that is the repost they asked for.
          setReposted(true)
          setReposts(prevReposts + 1)
          setOwnQuote(existing)
          toast.success('Reposted!')
          return null
        }
        // A quote with text holds the slot: adopt it, so undo and "View your quote" work.
        if (existing) {
          setReposted(true)
          setOwnQuote(existing)
        }
        toast.error('You have already quoted this.')
        return null
      }
      reportSpendError(error, viewerId, 'You need YAPP to repost. Buy some to continue.', 'Failed to update repost. Please try again.')
    } finally {
      setRepostLoading(false)
    }
    return null
  }, [viewerId, repostable, repostLoading, reposted, reposts, ownQuote, settle, post, targetKind, removeOwnQuote])

  const toggleBookmark = useCallback(async () => {
    if (!viewerId || !bookmarkable || bookmarkLoading) return
    const wasBookmarked = bookmarked
    setBookmarked(!wasBookmarked)
    setBookmarkLoading(true)
    try {
      if (!wasBookmarked) await settle()
      const { bookmarkService } = await import('@/lib/services/bookmark-service')
      const ok = wasBookmarked ? await bookmarkService.removeBookmark(post.id, viewerId) : await bookmarkService.bookmarkPost(post.id, viewerId)
      if (!ok) throw new Error('Bookmark operation failed')
      toast.success(wasBookmarked ? 'Removed from bookmarks' : 'Added to bookmarks')
    } catch (error) {
      setBookmarked(wasBookmarked)
      logger.error('Bookmark error:', error)
      toast.error('Failed to update bookmark. Please try again.')
    } finally {
      setBookmarkLoading(false)
    }
  }, [viewerId, bookmarkable, bookmarkLoading, bookmarked, settle, post.id])

  return {
    repostable,
    bookmarkable,
    liked,
    likes,
    reposted,
    reposts,
    /** v10: the viewer's quote or bare repost of the post (null when none, or off v10). */
    ownQuote,
    bookmarked,
    likeLoading,
    repostLoading,
    bookmarkLoading,
    toggleLike,
    toggleRepost,
    removeOwnQuote,
    toggleBookmark,
  }
}
