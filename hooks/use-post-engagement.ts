'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { reportBarredWrite } from '@/components/moderation/barred-writer-notice'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import { canBookmark, canRepost, repostsAreQuotes, type TargetKind } from '@/lib/contract-topology'
import { categorizeError, isDuplicateUniqueIndexError, isFrozenBalanceError, isTokenPausedError } from '@/lib/error-utils'
import type { OwnQuote } from '@/lib/feed/quote-reposts'
import { handleInsufficientYapp } from '@/hooks/use-buy-yapp-modal'
import { isUnconfirmed, settleUnconfirmed } from '@/lib/unconfirmed-writes'
import { readScoped, writeScoped } from '@/lib/storage-scope'
import { sessionGeneration } from '@/lib/auth/session-generation'
import { knowsMark, loadViewerMarks, marksFor, noMarksRead, withMark, type MarkName, type SomeMarks, type ViewerMarks } from '@/lib/feed/viewer-marks'

export interface EngagementSnapshot {
  likes: number
  reposts: number
  /** The viewer's marks, when a read for a viewer found them (lib/feed/viewer-marks.ts). */
  marks?: ViewerMarks
  /** The list is still reading marks for this card; the card waits rather than reading them too. */
  marksPending?: boolean
}

/** Marks known for one viewer and one target (or some of them: see SomeMarks). */
type KnownMarks = SomeMarks & { targetId: string }

/** Frozen accounts and a paused token cannot spend at all, so say that instead of offering YAPP. */
function reportSpendError(error: unknown, viewerId: string | undefined, buyReason: string, fallback: string) {
  if (reportBarredWrite(error, viewerId)) return
  if (isFrozenBalanceError(error) || isTokenPausedError(error)) toast.error(categorizeError(error))
  else if (!handleInsufficientYapp(error, buyReason)) toast.error(fallback)
}

const BOOKMARKS_PUBLIC_NOTED_KEY = 'yappr_bookmarks_public_noted'

/** The first bookmark on this browser also says that bookmarks are public; later ones just confirm. */
function addedToBookmarksMessage(): string {
  if (readScoped(BOOKMARKS_PUBLIC_NOTED_KEY) === '1') return 'Added to bookmarks'
  writeScoped(BOOKMARKS_PUBLIC_NOTED_KEY, '1')
  return 'Added to bookmarks. Anyone can see your bookmarks.'
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

/** The same viewer and target: a write's rollback never lands on another viewer's marks. */
function sameMarks(a: KnownMarks | null, b: KnownMarks): a is KnownMarks {
  return a !== null && a.viewerId === b.viewerId && a.session === b.session && a.targetId === b.targetId
}

/**
 * A card's like, repost and bookmark state with optimistic flips that roll
 * back on failure. Each write names the post, and on v9 that reference is
 * consensus-checked, so a post this session created but never saw confirmed
 * is settled first; the check is a no-op off the DAPI-timeout path.
 *
 * The viewer's marks are unknown until a read for this viewer and this post
 * succeeds: the snapshot's, when it names this viewer, or the card's own read
 * otherwise (the viewer signed in, or switched account, with the page still
 * open). Unknown marks show as unmarked and never decide a write: a tap reads
 * them first.
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
  const postId = post.id
  const [likes, setLikes] = useState(initial.likes)
  const [reposts, setReposts] = useState(initial.reposts)
  const [likeLoading, setLikeLoading] = useState(false)
  const [repostLoading, setRepostLoading] = useState(false)
  const [bookmarkLoading, setBookmarkLoading] = useState(false)

  // Follow the counts as the enrichment snapshot fills in.
  useEffect(() => {
    setLikes(initial.likes)
    setReposts(initial.reposts)
  }, [initial.likes, initial.reposts])

  // The snapshot's marks count only when they were read for this viewer in this session.
  const snapshot = marksFor(initial.marks, viewerId)
  const snapshotViewer = snapshot?.viewerId
  const snapshotSession = snapshot?.session ?? -1
  const snapshotLiked = snapshot?.liked === true
  const snapshotReposted = snapshot?.reposted === true
  const snapshotBookmarked = snapshot?.bookmarked === true
  const snapshotQuoteId = snapshot?.ownQuote?.id
  const snapshotQuoteBare = snapshot?.ownQuote?.bare === true
  const snapshotMarks = useMemo<KnownMarks | null>(() => snapshotViewer
    ? {
        viewerId: snapshotViewer,
        session: snapshotSession,
        targetId: postId,
        liked: snapshotLiked,
        reposted: snapshotReposted,
        bookmarked: snapshotBookmarked,
        ...(snapshotQuoteId ? { ownQuote: { id: snapshotQuoteId, bare: snapshotQuoteBare } } : {}),
      }
    : null, [snapshotViewer, snapshotSession, postId, snapshotLiked, snapshotReposted, snapshotBookmarked, snapshotQuoteId, snapshotQuoteBare])

  // Marks from this card's own read or writes; a newer snapshot replaces them,
  // unless a write is pending (the snapshot may predate it).
  const [ownMarks, setOwnMarks] = useState<KnownMarks | null>(null)
  const writesRef = useRef(0)
  useEffect(() => {
    if (writesRef.current === 0) setOwnMarks(null)
  }, [snapshotMarks])
  const ownKnown = ownMarks && ownMarks.targetId === postId ? marksFor(ownMarks, viewerId) ?? null : null
  const current = ownKnown ?? snapshotMarks

  const readMarks = useCallback(async (viewer: string): Promise<KnownMarks> => {
    const read = await loadViewerMarks(viewer, { id: postId, kind: targetKind })
    return { ...read, targetId: postId }
  }, [postId, targetKind])

  // Signed in with nothing read for this viewer: read the marks now.
  const needsRead = Boolean(viewerId) && current === null && !initial.marksPending
  useEffect(() => {
    if (!needsRead || !viewerId) return
    let live = true
    readMarks(viewerId)
      .then((read) => { if (live) setOwnMarks(read) })
      .catch((error) => logger.warn('Engagement: the viewer\'s marks could not be read; a tap reads them again', error))
    return () => {
      live = false
    }
  }, [needsRead, viewerId, readMarks])

  /**
   * The marks a write of `need` starts from: known ones, or a read made now.
   * When the full read fails, just `need` is read, so another mark's failed
   * lookup never stops this write; from then on only the marks still unread
   * are read, so a later read never overwrites a write in flight.
   * Null (with a toast) when `need` cannot be read.
   */
  const resolveMarks = useCallback(async (need: MarkName): Promise<KnownMarks | null> => {
    if (!viewerId) return null
    if (current && knowsMark(current, need)) return current
    if (!current) {
      try {
        const read = await readMarks(viewerId)
        // Marks another tap read or wrote meanwhile stay; the read only fills those still unread.
        setOwnMarks((held) => held && held.unread && sameMarks(held, read)
          ? held.unread.reduce((marks, name) => withMark(marks, name, read), held)
          : read)
        return read
      } catch (error) {
        logger.warn('Engagement: the viewer\'s marks could not all be read; reading just the one this needs', error)
      }
    }
    try {
      const session = sessionGeneration()
      const { fetchUserMark } = await import('@/lib/services/post-stats-helpers')
      const read = await fetchUserMark({ id: postId, kind: targetKind }, viewerId, need)
      const fresh: KnownMarks = { ...noMarksRead(viewerId, session), targetId: postId }
      const fits = (marks: KnownMarks | null): marks is KnownMarks =>
        marks !== null && marks.viewerId === viewerId && marks.session === session && marks.targetId === postId
      setOwnMarks((held) => fits(held) ? withMark(held, need, read) : sessionGeneration() === session ? withMark(fresh, need, read) : held)
      return withMark(fits(current) ? current : fresh, need, read)
    } catch (error) {
      logger.error('Engagement: the viewer\'s marks could not be read:', error)
      toast.error('Could not check this post right now. Please try again.')
      return null
    }
  }, [viewerId, current, readMarks, postId, targetKind])

  /** Applies `change` to the marks of `base`'s viewer and target, and to nothing else. */
  const patchMarks = useCallback((base: KnownMarks, change: Partial<ViewerMarks>) => {
    setOwnMarks((marks) => ({ ...(sameMarks(marks, base) ? marks : base), ...change }))
  }, [])

  const settle = useCallback(async () => {
    if (isUnconfirmed(postId) && !(await settleUnconfirmed(postId))) {
      throw new Error('This post has not confirmed yet. Try again in a moment.')
    }
  }, [postId])

  const toggleLike = useCallback(async () => {
    if (!viewerId || likeLoading) return
    setLikeLoading(true)
    writesRef.current += 1
    try {
      const shown = current
      const before = await resolveMarks('liked')
      // Unknown marks showed as unliked: a read finding a like just shows it.
      if (!before || (!knowsMark(shown, 'liked') && before.liked)) return
      const wasLiked = before.liked
      patchMarks(before, { liked: !wasLiked })
      setLikes((count) => count + (wasLiked ? -1 : 1))
      try {
        await settle()
        const { likeService } = await import('@/lib/services/like-service')
        // On devnet cuts the like repeats the target's author and tags under a
        // consensus-checked agreement; passing them saves the service a fetch.
        const targetInfo = { author: post.author.id, tags: post.tags }
        const ok = wasLiked
          ? await likeService.unlikePost(postId, viewerId, targetKind, targetInfo)
          : await likeService.likePost(postId, viewerId, post.author.id, targetKind, targetInfo)
        if (!ok) throw new Error('Like operation failed')
      } catch (error) {
        patchMarks(before, { liked: wasLiked })
        setLikes((count) => count + (wasLiked ? 1 : -1))
        logger.error('Like error:', error)
        reportSpendError(error, viewerId, 'You need YAPP to like posts. Buy some to continue.', 'Failed to update like. Please try again.')
      }
    } finally {
      writesRef.current -= 1
      setLikeLoading(false)
    }
  }, [viewerId, likeLoading, current, resolveMarks, patchMarks, settle, postId, post.author.id, post.tags, targetKind])

  /**
   * v10: delete the viewer's quote or repost of the post. Callers confirm a
   * quote with text first ({@link toggleRepost} hands such a quote back).
   */
  const removeOwnQuote = useCallback(async (quote: OwnQuote, base: KnownMarks | null = current) => {
    // Offered only once the viewer's repost was read; nothing to undo against otherwise.
    if (!viewerId || !base) return
    patchMarks(base, { reposted: false })
    setReposts((count) => Math.max(0, count - 1))
    setRepostLoading(true)
    writesRef.current += 1
    try {
      const { postService } = await import('@/lib/services/post-service')
      // v11: a tombstone that clears the quote, freeing the slot for a redo.
      if (!(await postService.deleteOwnPost(quote.id, viewerId))) throw new Error('Repost operation failed')
      patchMarks(base, { reposted: false, ownQuote: undefined })
      toast.success(quote.bare ? 'Removed repost' : 'Quote deleted')
    } catch (error) {
      patchMarks(base, { reposted: true, ownQuote: quote })
      setReposts((count) => count + 1)
      logger.error('Repost error:', error)
      // Undo is a tombstone (a replace), refused to a banned or suspended
      // author on v11; v12 accepts it (retractedWhen).
      if (!reportBarredWrite(error, viewerId)) toast.error('Failed to update repost. Please try again.')
    } finally {
      writesRef.current -= 1
      setRepostLoading(false)
    }
  }, [viewerId, current, patchMarks])

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
    setRepostLoading(true)
    const shown = current
    let before: KnownMarks | null
    try {
      before = await resolveMarks('reposted')
    } finally {
      setRepostLoading(false)
    }
    if (!before || (!knowsMark(shown, 'reposted') && before.reposted)) return null
    if (repostsAreQuotes() && before.reposted) {
      let quote = before.ownQuote ?? null
      if (!quote) {
        setRepostLoading(true)
        try {
          quote = await lookupOwnQuote(postId, viewerId, targetKind)
        } catch (error) {
          logger.error('Undo repost: the viewer\'s quote or repost could not be read:', error)
          toast.error('Failed to update repost. Please try again.')
          return null
        } finally {
          setRepostLoading(false)
        }
      }
      if (!quote) {
        logger.warn('Undo repost: no quote or repost of this post by the viewer was found; nothing to delete')
        patchMarks(before, { reposted: false })
        return null
      }
      patchMarks(before, { ownQuote: quote })
      if (!quote.bare) return quote
      await removeOwnQuote(quote, before)
      return null
    }
    const wasReposted = before.reposted
    patchMarks(before, { reposted: !wasReposted })
    setReposts((count) => count + (wasReposted ? -1 : 1))
    setRepostLoading(true)
    writesRef.current += 1
    try {
      // Removal needs no gate: the repost document already exists.
      if (!wasReposted) await settle()
      if (repostsAreQuotes()) {
        // (Undo returned above: here the viewer is reposting.)
        patchMarks(before, { reposted: true, ownQuote: await createBareRepost(post, viewerId) })
        toast.success('Reposted')
        return null
      }
      const { repostService } = await import('@/lib/services/repost-service')
      const ok = wasReposted ? await repostService.removeRepost(postId, viewerId) : await repostService.repostPost(postId, viewerId, post.author.id)
      if (!ok) throw new Error('Repost operation failed')
      toast.success(wasReposted ? 'Removed repost' : 'Reposted')
    } catch (error) {
      patchMarks(before, { reposted: wasReposted })
      setReposts((count) => count + (wasReposted ? 1 : -1))
      logger.error('Repost error:', error)
      if (repostsAreQuotes() && !wasReposted && isDuplicateUniqueIndexError(error)) {
        // The viewer already holds this target's one quote/repost slot (marks
        // read before it landed said otherwise).
        const existing = await lookupOwnQuote(postId, viewerId, targetKind).catch((lookupError: unknown) => {
          logger.error('Repost: the viewer\'s quote or repost could not be read:', lookupError)
          return null
        })
        if (existing?.bare) {
          // Their own earlier repost landed (a double click, or a lost ack):
          // that is the repost they asked for.
          patchMarks(before, { reposted: true, ownQuote: existing })
          setReposts((count) => count + 1)
          toast.success('Reposted')
          return null
        }
        // A quote with text holds the slot: adopt it, so undo and "View your quote" work.
        if (existing) patchMarks(before, { reposted: true, ownQuote: existing })
        toast.error('You have already quoted this.')
        return null
      }
      reportSpendError(error, viewerId, 'You need YAPP to repost. Buy some to continue.', 'Failed to update repost. Please try again.')
    } finally {
      writesRef.current -= 1
      setRepostLoading(false)
    }
    return null
  }, [viewerId, repostable, repostLoading, current, resolveMarks, patchMarks, settle, post, postId, targetKind, removeOwnQuote])

  const toggleBookmark = useCallback(async () => {
    if (!viewerId || !bookmarkable || bookmarkLoading) return
    setBookmarkLoading(true)
    writesRef.current += 1
    try {
      const shown = current
      const before = await resolveMarks('bookmarked')
      if (!before || (!knowsMark(shown, 'bookmarked') && before.bookmarked)) return
      const wasBookmarked = before.bookmarked
      patchMarks(before, { bookmarked: !wasBookmarked })
      try {
        if (!wasBookmarked) await settle()
        const { bookmarkService } = await import('@/lib/services/bookmark-service')
        const ok = wasBookmarked ? await bookmarkService.removeBookmark(postId, viewerId) : await bookmarkService.bookmarkPost(postId, viewerId)
        if (!ok) throw new Error('Bookmark operation failed')
        toast.success(wasBookmarked ? 'Removed from bookmarks' : addedToBookmarksMessage())
      } catch (error) {
        patchMarks(before, { bookmarked: wasBookmarked })
        logger.error('Bookmark error:', error)
        toast.error('Failed to update bookmark. Please try again.')
      }
    } finally {
      writesRef.current -= 1
      setBookmarkLoading(false)
    }
  }, [viewerId, bookmarkable, bookmarkLoading, current, resolveMarks, patchMarks, settle, postId])

  return {
    repostable,
    bookmarkable,
    /** The viewer's marks when all were read for them; undefined while any is unknown (or signed out). */
    marks: current && !current.unread ? current : undefined,
    liked: current?.liked ?? false,
    likes,
    reposted: current?.reposted ?? false,
    reposts,
    /** v10: the viewer's quote or bare repost of the post (null when none, unknown, or off v10). */
    ownQuote: current?.ownQuote ?? null,
    bookmarked: current?.bookmarked ?? false,
    likeLoading,
    repostLoading,
    bookmarkLoading,
    toggleLike,
    toggleRepost,
    removeOwnQuote,
    toggleBookmark,
    /** The marks for a write of one mark, read now when unknown; null (after a toast) when it cannot be read. */
    resolveMarks,
  }
}
