'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { motion } from 'framer-motion'
import {
  ChatBubbleOvalLeftIcon,
  ArrowPathIcon,
  HeartIcon,
  ArrowUpTrayIcon,
  BookmarkIcon,
  EllipsisHorizontalIcon,
  CurrencyDollarIcon,
  PencilSquareIcon,
  LockClosedIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { HeartIcon as HeartIconSolid, BookmarkIcon as BookmarkIconSolid } from '@heroicons/react/24/solid'
import { Post } from '@/lib/types'
import { formatNumber } from '@/lib/utils'
import { useRelativeTime } from '@/hooks/use-relative-time'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/lib/store'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { UserAvatar } from '@/components/ui/avatar-image'
import { LikesModal } from './likes-modal'
import { PostContent } from './post-content'
import { PrivatePostContent, isPrivatePost } from './private-post-content'
import { EmbeddedPostCard, EmbeddedPostSkeleton } from './embedded-post-card'
import { EmbeddedBlogPostCard, isEmbeddedBlogPostLike } from '@/components/blog/embedded-blog-post-card'
import { PollCard } from '@/components/poll/poll-card'
import { findPollrPollLink, getEmbeddedPollId, stripPollrPollLink } from '@/lib/poll-embed'
import { ProfileHoverCard } from '@/components/profile/profile-hover-card'
import { useTipModal } from '@/hooks/use-tip-modal'
import { handleInsufficientYapp } from '@/hooks/use-buy-yapp-modal'
import { categorizeError, isFrozenBalanceError } from '@/lib/error-utils'
import { useBlock } from '@/hooks/use-block'
import { useFollow } from '@/hooks/use-follow'
import { useHashtagValidation } from '@/hooks/use-hashtag-validation'
import { useHashtagRecoveryModal } from '@/hooks/use-hashtag-recovery-modal'
import { useMentionValidation } from '@/hooks/use-mention-validation'
import { useMentionRecoveryModal } from '@/hooks/use-mention-recovery-modal'
import { useDeleteConfirmationModal } from '@/hooks/use-delete-confirmation-modal'
import { tipService } from '@/lib/services/tip-service'
import { useCanReplyToPrivate } from '@/hooks/use-can-reply-to-private'
import { canBookmark, canRepost, deletesAreTombstones, targetKindOf } from '@/lib/contract-topology'
import { isUnconfirmed, settleUnconfirmed } from '@/lib/unconfirmed-writes'

// Username loading state: undefined = loading, null = no DPNS, string = username
type UsernameState = string | null | undefined

/**
 * Resolves username display state from progressive enrichment and post data.
 * Priority: progressive enrichment > post.author.hasDpns flag
 */
function resolveUsernameState(
  progressiveUsername: UsernameState,
  postAuthor: Post['author']
): UsernameState {
  // Progressive enrichment takes priority when defined
  if (progressiveUsername !== undefined) {
    return progressiveUsername
  }

  // Fall back to hasDpns flag on author
  if (postAuthor.hasDpns === undefined) {
    return undefined // Still loading
  }

  if (postAuthor.hasDpns) {
    return postAuthor.username // Has DPNS
  }

  return null // No DPNS
}

/**
 * Checks if a display name represents a real profile (not a placeholder).
 */
function hasRealProfile(displayName: string | undefined): boolean {
  if (!displayName) return false
  if (displayName === 'Unknown User') return false
  if (displayName.startsWith('User ')) return false
  return true
}

/**
 * Reusable tooltip wrapper for action buttons.
 * Reduces boilerplate for the repetitive Tooltip.Root/Trigger/Portal/Content pattern.
 */
interface ActionTooltipProps {
  label: string
  children: React.ReactNode
}

function ActionTooltip({ label, children }: ActionTooltipProps): React.ReactElement {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
          sideOffset={5}
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

// Enrichment data from progressive loading
export interface ProgressiveEnrichment {
  username: string | null | undefined  // undefined = loading, null = no DPNS, string = username
  displayName: string | undefined
  avatarUrl: string | undefined
  stats: { likes: number; reposts: number; replies: number; quotes: number; views: number } | undefined
  interactions: { liked: boolean; reposted: boolean; bookmarked: boolean } | undefined
  isBlocked: boolean | undefined
  isFollowing: boolean | undefined
  replyTo?: { id: string; authorId: string; authorUsername: string | null }
}

interface PostCardProps {
  post: Post
  hideAvatar?: boolean
  isOwnPost?: boolean
  /** Progressive enrichment data - use this when available for faster rendering */
  enrichment?: ProgressiveEnrichment
  /** For replies to private posts, the root post owner ID to check access against */
  rootPostOwnerId?: string
  /** Callback when post is successfully deleted - parent component should remove post from list */
  onDelete?: (postId: string) => void
}

export function PostCard({ post, hideAvatar = false, isOwnPost: isOwnPostProp, enrichment: progressiveEnrichment, rootPostOwnerId, onDelete }: PostCardProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()

  // Compute isOwnPost from auth context if not explicitly provided
  const isOwnPost = isOwnPostProp ?? (user?.identityId === post.author.id)

  // Which document type this card is actually showing. Everything that reads or
  // writes an engagement has to dispatch on it, because the v3 topology gives
  // posts and replies different interaction doctypes (and forbids reposting or
  // bookmarking a reply at all).
  const targetKind = targetKindOf(post)
  const isReply = targetKind === 'reply'
  const repostable = canRepost(targetKind)
  const bookmarkable = canBookmark(targetKind)
  // On v3 posts and replies are permanent, so "delete" blanks the document and
  // flags it instead of removing it.
  const tombstones = deletesAreTombstones()
  // Set after this card's own document was tombstoned this session, so the
  // deleted state renders in place even when no parent list removes the card.
  const [locallyTombstoned, setLocallyTombstoned] = useState(false)
  // Single source of truth for "this card's document is a tombstone" — the
  // deleted paragraph must beat EVERY content branch (tip text, poll, quote,
  // media), not just the plain-content one, or a freshly tombstoned card keeps
  // exposing its former attachments until fresh Platform data arrives.
  const isTombstoned = Boolean(post.deleted) || locallyTombstoned

  // Use progressive enrichment data when available, fall back to post._enrichment (old path)
  const legacyEnrichment = post._enrichment

  // Resolve display values: progressive enrichment > post data > placeholder
  const displayName = progressiveEnrichment?.displayName ?? post.author.displayName
  const avatarUrl = progressiveEnrichment?.avatarUrl ?? legacyEnrichment?.authorAvatarUrl ?? post.author.avatar

  // Resolve username state using helper (replaces nested ternary)
  const usernameState = resolveUsernameState(
    progressiveEnrichment?.username,
    post.author
  )

  // Check if user has a real profile (not a placeholder)
  const hasProfile = hasRealProfile(displayName)

  // Stats: use progressive enrichment > post data
  const statsLikes = progressiveEnrichment?.stats?.likes ?? post.likes
  const statsReposts = progressiveEnrichment?.stats?.reposts ?? post.reposts
  const statsReplies = progressiveEnrichment?.stats?.replies ?? post.replies
  const statsQuotes = progressiveEnrichment?.stats?.quotes ?? post.quotes

  // Interactions: use progressive enrichment > post data
  const initialLiked = progressiveEnrichment?.interactions?.liked ?? post.liked ?? false
  const initialReposted = progressiveEnrichment?.interactions?.reposted ?? post.reposted ?? false
  const initialBookmarked = progressiveEnrichment?.interactions?.bookmarked ?? post.bookmarked ?? false


  // Memoize enriched post for use in compose/tip modals and caching
  // Includes all resolved values so cached posts display correctly
  const enrichedPost = useMemo(() => ({
    ...post,
    author: {
      ...post.author,
      username: usernameState || post.author.username,
      displayName: displayName || post.author.displayName,
      avatar: avatarUrl || post.author.avatar,
      // Set hasDpns based on resolved username state to prevent loading skeletons
      // undefined = still loading, true = has DPNS, false = no DPNS
      hasDpns: usernameState !== undefined ? (usernameState !== null) : post.author.hasDpns
    }
  }), [post, usernameState, displayName, avatarUrl])

  // Render username/identity display based on state
  const renderUsernameOrIdentity = useCallback(() => {
    // Has DPNS username
    if (usernameState) {
      return (
        <ProfileHoverCard
          userId={post.author.id}
          username={usernameState}
          displayName={displayName}
          avatarUrl={avatarUrl}
        >
          <Link
            href={`/user?id=${post.author.id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-gray-500 hover:underline truncate"
          >
            @{usernameState}
          </Link>
        </ProfileHoverCard>
      )
    }

    // Still loading
    if (usernameState === undefined) {
      return <span className="inline-block w-20 h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
    }

    // No DPNS and no profile - show identity ID with copy tooltip
    if (!hasProfile) {
      return (
        <ProfileHoverCard
          userId={post.author.id}
          username={null}
          displayName={displayName}
          avatarUrl={avatarUrl}
        >
          <span className="inline-flex">
            <Tooltip.Provider>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      navigator.clipboard.writeText(post.author.id).catch((error) => logger.error(error))
                      toast.success('Identity ID copied')
                    }}
                    className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 truncate font-mono text-xs"
                  >
                    {post.author.id.slice(0, 8)}...{post.author.id.slice(-6)}
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded max-w-xs"
                    sideOffset={5}
                  >
                    Click to copy full identity ID
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </span>
        </ProfileHoverCard>
      )
    }

    // Has profile but no DPNS - display name is sufficient
    return null
  }, [usernameState, hasProfile, post.author.id, displayName, avatarUrl])

  const [liked, setLiked] = useState(initialLiked)
  const [likes, setLikes] = useState(statsLikes)
  const [reposted, setReposted] = useState(initialReposted)
  const [reposts, setReposts] = useState(statsReposts)
  const [bookmarked, setBookmarked] = useState(initialBookmarked)
  // The repost control shows reposts + quote-posts combined — or, where the
  // topology forbids reposting this kind, just the quotes (there is no repost
  // doctype to have counted).
  const totalReposts = (repostable ? reposts : 0) + statsQuotes
  const [showLikesModal, setShowLikesModal] = useState(false)
  const [likeLoading, setLikeLoading] = useState(false)
  const [repostLoading, setRepostLoading] = useState(false)
  const [bookmarkLoading, setBookmarkLoading] = useState(false)
  const { setReplyingTo, setComposeOpen, setQuotingPost } = useAppStore()
  const { open: openTipModal } = useTipModal()
  const { open: openHashtagRecoveryModal } = useHashtagRecoveryModal()
  const { open: openMentionRecoveryModal } = useMentionRecoveryModal()
  const { open: openDeleteModal } = useDeleteConfirmationModal()

  // Validate hashtags for all posts (checks if hashtag documents exist on platform)
  const { validations: hashtagValidations, revalidate: revalidateHashtags } = useHashtagValidation(post)

  // Validate mentions for all posts (checks if mention documents exist on platform)
  const { validations: mentionValidations, revalidate: revalidateMentions } = useMentionValidation(post)

  // Use pre-fetched enrichment data to avoid N+1 queries
  const { isBlocked, isLoading: blockLoading, toggleBlock } = useBlock(post.author.id, {
    initialValue: progressiveEnrichment?.isBlocked ?? legacyEnrichment?.authorIsBlocked
  })
  const { isFollowing, isLoading: followLoading, toggleFollow } = useFollow(post.author.id, {
    initialValue: progressiveEnrichment?.isFollowing ?? legacyEnrichment?.authorIsFollowing
  })

  // Check if user can reply to private posts (PRD §5.5)
  // For replies, check access against root post owner, not the reply author
  const { canReply: canReplyToPrivate, reason: cantReplyReason } = useCanReplyToPrivate(post, rootPostOwnerId)

  // Sync local state with prop changes (reuses computed initial values)
  useEffect(() => {
    setLiked(initialLiked)
    setLikes(statsLikes)
    setReposted(initialReposted)
    setReposts(statsReposts)
    setBookmarked(initialBookmarked)
  }, [initialLiked, statsLikes, initialReposted, statsReposts, initialBookmarked])

  // Listen for hashtag registration events to revalidate
  useEffect(() => {
    const handleHashtagRegistered = (event: CustomEvent<{ postId: string; hashtag: string }>) => {
      if (event.detail.postId === post.id) {
        revalidateHashtags()
      }
    }

    window.addEventListener('hashtag-registered', handleHashtagRegistered as EventListener)
    return () => {
      window.removeEventListener('hashtag-registered', handleHashtagRegistered as EventListener)
    }
  }, [post.id, revalidateHashtags])

  // Listen for mention registration events to revalidate
  useEffect(() => {
    const handleMentionRegistered = (event: CustomEvent<{ postId: string; username: string }>) => {
      if (event.detail.postId === post.id) {
        revalidateMentions()
      }
    }

    window.addEventListener('mention-registered', handleMentionRegistered as EventListener)
    return () => {
      window.removeEventListener('mention-registered', handleMentionRegistered as EventListener)
    }
  }, [post.id, revalidateMentions])

  // Check if this post is a tip and parse tip info
  const tipInfo = useMemo(() => tipService.parseTipContent(post.content), [post.content])
  const isTipPost = !!tipInfo
  const createdAtLabel = useRelativeTime(post.createdAt)

  // Native poll embed, or a legacy post that only links to the Pollr web app.
  const nativePollId = getEmbeddedPollId(post)
  // Only look for a legacy link when there is no native embed: on a native poll
  // post a Pollr URL in the body points at some *other* poll, and stripping it
  // would drop a link nothing else renders.
  const pollLink = useMemo(
    () => (nativePollId ? null : findPollrPollLink(post.content)),
    [nativePollId, post.content]
  )
  const embeddedPollId = nativePollId ?? pollLink?.pollId ?? null
  // Legacy poll links are rendered as the poll itself, so drop the raw URL.
  const displayContent = useMemo(
    () => (pollLink ? stripPollrPollLink(post.content, pollLink.url) : post.content),
    [post.content, pollLink]
  )

  const handleLike = async () => {
    if (hideAvatar) {
      // On "Your Posts" tab, show who liked instead of liking
      setShowLikesModal(true)
      return
    }

    const authedUser = requireAuth('like')
    if (!authedUser) return

    if (likeLoading) return

    const wasLiked = liked
    const prevLikes = likes

    // Optimistic update
    setLiked(!wasLiked)
    setLikes(wasLiked ? prevLikes - 1 : prevLikes + 1)
    setLikeLoading(true)

    try {
      // A like references its target, and on v3 that reference is checked by
      // consensus — so liking a card this session just created but never saw
      // confirmed would be rejected with the YAPP spent. Only reachable on the
      // DAPI-timeout path; a no-op otherwise.
      if (isUnconfirmed(post.id) && !(await settleUnconfirmed(post.id))) {
        throw new Error('This post has not confirmed yet. Try again in a moment.')
      }

      const { likeService } = await import('@/lib/services/like-service')
      const success = wasLiked
        ? await likeService.unlikePost(post.id, authedUser.identityId, targetKind)
        : await likeService.likePost(post.id, authedUser.identityId, post.author.id, targetKind)

      if (!success) throw new Error('Like operation failed')
    } catch (error) {
      // Rollback on error
      setLiked(wasLiked)
      setLikes(prevLikes)
      logger.error('Like error:', error)
      // Frozen accounts can't spend YAPP at all, so explain the suspension
      // instead of prompting a purchase that wouldn't help.
      if (isFrozenBalanceError(error)) {
        toast.error(categorizeError(error))
      } else if (!handleInsufficientYapp(error, 'You need YAPP to like posts. Buy some to continue.')) {
        toast.error('Failed to update like. Please try again.')
      }
    } finally {
      setLikeLoading(false)
    }
  }

  const handleRepost = async () => {
    const authedUser = requireAuth('repost')
    if (!authedUser) return

    // The topology may forbid reposting this kind entirely (v3 replies), in which
    // case there is no doctype to write. The control is still rendered today, so
    // this guard — not the action row — is what enforces the rule.
    if (!repostable) return

    if (repostLoading) return

    const wasReposted = reposted
    const prevReposts = reposts

    // Optimistic update
    setReposted(!wasReposted)
    setReposts(wasReposted ? prevReposts - 1 : prevReposts + 1)
    setRepostLoading(true)

    try {
      // Same consensus-reference rule as likes: on v3 a repost names its target
      // through a checked permanentDocument reference, so creating one against a
      // not-yet-confirmed post would be rejected with the YAPP already spent.
      // Removal needs no gate — the repost document itself already exists.
      if (!wasReposted && isUnconfirmed(post.id) && !(await settleUnconfirmed(post.id))) {
        throw new Error('This post has not confirmed yet. Try again in a moment.')
      }

      const { repostService } = await import('@/lib/services/repost-service')
      const success = wasReposted
        ? await repostService.removeRepost(post.id, authedUser.identityId)
        : await repostService.repostPost(post.id, authedUser.identityId, post.author.id)

      if (!success) throw new Error('Repost operation failed')
      toast.success(wasReposted ? 'Removed repost' : 'Reposted!')
    } catch (error) {
      // Rollback on error
      setReposted(wasReposted)
      setReposts(prevReposts)
      logger.error('Repost error:', error)
      // Frozen accounts can't spend YAPP at all, so explain the suspension
      // instead of prompting a purchase that wouldn't help.
      if (isFrozenBalanceError(error)) {
        toast.error(categorizeError(error))
      } else if (!handleInsufficientYapp(error, 'You need YAPP to repost. Buy some to continue.')) {
        toast.error('Failed to update repost. Please try again.')
      }
    } finally {
      setRepostLoading(false)
    }
  }

  const handleQuote = () => {
    if (!requireAuth('quote')) return
    setQuotingPost(enrichedPost)
    setComposeOpen(true)
  }

  const handleBookmark = async () => {
    const authedUser = requireAuth('bookmark')
    if (!authedUser) return

    // Same guard as handleRepost: on v3 replies have no bookmark doctype.
    if (!bookmarkable) return

    if (bookmarkLoading) return

    const wasBookmarked = bookmarked

    // Optimistic update
    setBookmarked(!wasBookmarked)
    setBookmarkLoading(true)

    try {
      // Same unconfirmed-target gate as likes/reposts (bookmark.postId is a
      // checked reference on v3); removal is ungated.
      if (!wasBookmarked && isUnconfirmed(post.id) && !(await settleUnconfirmed(post.id))) {
        throw new Error('This post has not confirmed yet. Try again in a moment.')
      }

      const { bookmarkService } = await import('@/lib/services/bookmark-service')
      const success = wasBookmarked
        ? await bookmarkService.removeBookmark(post.id, authedUser.identityId)
        : await bookmarkService.bookmarkPost(post.id, authedUser.identityId)

      if (!success) throw new Error('Bookmark operation failed')
      toast.success(wasBookmarked ? 'Removed from bookmarks' : 'Added to bookmarks')
    } catch (error) {
      // Rollback on error
      setBookmarked(wasBookmarked)
      logger.error('Bookmark error:', error)
      toast.error('Failed to update bookmark. Please try again.')
    } finally {
      setBookmarkLoading(false)
    }
  }

  const handleReply = () => {
    if (!requireAuth('reply')) return
    // Check if user can reply to private posts (PRD §5.5)
    if (!canReplyToPrivate) {
      toast.error(cantReplyReason || "Can't reply to this post")
      return
    }
    setReplyingTo(enrichedPost)
    setComposeOpen(true)
  }

  const handleShare = () => {
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
    navigator.clipboard.writeText(`${baseUrl}/post?id=${post.id}`).catch((error) => logger.error(error))
    toast.success('Link copied to clipboard')
  }

  const handleTip = () => {
    if (!requireAuth('tip')) return
    openTipModal(enrichedPost)
  }

  const handleFailedHashtagClick = (hashtag: string) => {
    openHashtagRecoveryModal(post, hashtag)
  }

  const handleFailedMentionClick = (username: string) => {
    openMentionRecoveryModal(post, username)
  }

  const handleDelete = () => {
    const authedUser = requireAuth('delete')
    if (!authedUser) return

    openDeleteModal(post, async () => {
      let success: boolean

      if (isReply) {
        // Use replyService for replies (document type 'reply')
        const { replyService } = await import('@/lib/services/reply-service')
        success = tombstones
          ? await replyService.tombstoneReply(post.id, authedUser.identityId)
          : await replyService.deleteReply(post.id, authedUser.identityId)
      } else {
        // Use postService for posts (document type 'post')
        const { postService } = await import('@/lib/services/post-service')
        success = tombstones
          ? await postService.tombstonePost(post.id, authedUser.identityId)
          : await postService.deletePost(post.id, authedUser.identityId)
      }

      if (!success) throw new Error('Delete operation failed')

      toast.success(isReply ? 'Reply deleted' : 'Post deleted')
      // On v3 the document still exists as a tombstone. Flip the card into its
      // tombstone rendering immediately — detail and thread callers pass no
      // onDelete, so without this the pre-delete content would stay on screen
      // (and the service cache could re-serve it) until a full reload.
      if (tombstones) {
        setLocallyTombstoned(true)
      }
      // Notify parent to remove post from list if callback provided
      if (onDelete) {
        onDelete(post.id)
      }
    })
  }

  const handleCardClick = (e: React.MouseEvent) => {
    const url = `/post?id=${post.id}`

    // Set pending navigation data for instant display on post detail page
    // This is consumed immediately when the detail page mounts - no TTL needed
    const { setPendingPostNavigation } = useAppStore.getState()
    const resolvedEnrichment: ProgressiveEnrichment = {
      // Use resolved values (what's currently displayed) instead of raw progressive state
      username: usernameState,
      displayName: displayName,
      avatarUrl: avatarUrl,
      // Preserve stats and interactions from progressive enrichment
      stats: progressiveEnrichment?.stats ?? {
        likes: statsLikes,
        reposts: statsReposts,
        replies: statsReplies,
        quotes: statsQuotes,
        views: post.views
      },
      interactions: progressiveEnrichment?.interactions ?? {
        liked: liked,
        reposted: reposted,
        bookmarked: bookmarked
      },
      isBlocked: progressiveEnrichment?.isBlocked ?? isBlocked,
      isFollowing: progressiveEnrichment?.isFollowing ?? isFollowing,
      replyTo: progressiveEnrichment?.replyTo
    }
    setPendingPostNavigation(enrichedPost, resolvedEnrichment)

    // Handle Ctrl/Cmd+click to open in new tab (standard browser behavior)
    if (e.ctrlKey || e.metaKey) {
      window.open(url, '_blank')
    } else {
      router.push(url)
    }
  }

  return (
    <motion.article
      data-testid={`post-card-${post.id}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={handleCardClick}
      className="border-b border-gray-200 dark:border-gray-800 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors cursor-pointer"
    >
      {/* Reposted by header */}
      {post.repostedBy && (
        <Link
          href={`/user?id=${post.repostedBy.id}`}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-2 text-sm text-gray-500 mb-2 ml-8 hover:underline"
        >
          <ArrowPathIcon className="h-4 w-4" />
          <span>
            {post.repostedBy.username
              ? `@${post.repostedBy.username}`
              : post.repostedBy.displayName || 'Someone'} reposted
          </span>
        </Link>
      )}
      <div className="flex gap-3">
        {!hideAvatar && (
          <ProfileHoverCard
            userId={post.author.id}
            username={usernameState}
            displayName={displayName}
            avatarUrl={avatarUrl}
          >
            <Link
              href={`/user?id=${post.author.id}`}
              onClick={(e) => e.stopPropagation()}
              className="h-12 w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 block flex-shrink-0"
            >
              <UserAvatar userId={post.author.id} size="lg" alt={displayName} preloadedUrl={avatarUrl || undefined} />
            </Link>
          </ProfileHoverCard>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 text-sm min-w-0">
              {!hideAvatar && (
                <>
                  {usernameState === undefined || (displayName === 'Unknown User' || displayName?.startsWith('User ')) ? (
                    // Still loading - show skeleton for display name
                    <span className="inline-block w-24 h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                  ) : (
                    <ProfileHoverCard
                      userId={post.author.id}
                      username={usernameState}
                      displayName={displayName}
                      avatarUrl={avatarUrl}
                    >
                      <Link
                        href={`/user?id=${post.author.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-semibold hover:underline truncate"
                      >
                        {displayName}
                      </Link>
                    </ProfileHoverCard>
                  )}
                  {post.author.verified && (
                    <svg className="h-4 w-4 text-yappr-500 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z" />
                    </svg>
                  )}
                  {renderUsernameOrIdentity()}
                </>
              )}
            </div>

            <div className="flex items-center gap-1 flex-shrink-0">
              {isPrivatePost(post) && (
                <span className="flex items-center gap-0.5 text-gray-500 mr-1">
                  <LockClosedIcon className="h-3.5 w-3.5" />
                </span>
              )}
              <span className="text-gray-500 text-sm">{createdAtLabel}</span>
              <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton data-testid={`more-btn-${post.id}`} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                  <EllipsisHorizontalIcon className="h-5 w-5" />
                </IconButton>
              </DropdownMenu.Trigger>
              
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="min-w-[200px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50"
                  sideOffset={5}
                >
                  <DropdownMenu.Item
                    onClick={(e) => { e.stopPropagation(); toggleFollow().catch((error) => logger.error(error)); }}
                    disabled={followLoading}
                    className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none disabled:opacity-50"
                  >
                    {isFollowing ? 'Unfollow' : 'Follow'} {usernameState ? `@${usernameState}` : displayName}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={(e) => {
                      e.stopPropagation();
                      // The kind travels in the URL: the engagements page has to
                      // know which doctypes to read, and an id alone no longer says.
                      router.push(`/post/engagements?id=${post.id}&kind=${targetKind}`);
                    }}
                    className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none"
                  >
                    View post engagements
                  </DropdownMenu.Item>
                  {isOwnPost && (
                    <DropdownMenu.Item
                      onClick={(e) => { e.stopPropagation(); handleDelete(); }}
                      className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none text-red-500"
                    >
                      <TrashIcon className="h-4 w-4" />
                      Delete {isReply ? 'reply' : 'post'}
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Item
                    onClick={(e) => { e.stopPropagation(); toggleBlock().catch((error) => logger.error(error)); }}
                    disabled={blockLoading}
                    className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none text-red-500 disabled:opacity-50"
                  >
                    {isBlocked ? 'Unblock' : 'Block'} {usernameState ? `@${usernameState}` : displayName}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            </div>
          </div>

          {/* Tip post - show tip badge with recipient and message */}
          {/* TODO: Remove tooltip once SDK exposes transition IDs for on-chain verification */}
          {isTombstoned ? (
            <p className="mt-2 text-sm italic text-gray-500 dark:text-gray-400">
              {isReply ? 'This reply was deleted.' : 'This post was deleted.'}
            </p>
          ) : isTipPost ? (
            <div className="mt-2">
              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-sm font-medium mb-2 cursor-help">
                      <CurrencyDollarIcon className="h-4 w-4" />
                      <span>
                        Sent a tip of {tipService.formatDash(tipService.creditsToDash(tipInfo.amount))}
                      </span>
                    </div>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded max-w-xs"
                      sideOffset={5}
                    >
                      Unverified - awaiting SDK support
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
              {tipInfo.message && (
                <PostContent content={tipInfo.message} className="mt-1" />
              )}
            </div>
          ) : isPrivatePost(post) ? (
            <PrivatePostContent
              post={post}
              rootPostOwnerId={rootPostOwnerId}
              className="mt-1"
              hashtagValidations={hashtagValidations}
              onFailedHashtagClick={handleFailedHashtagClick}
              mentionValidations={mentionValidations}
              onFailedMentionClick={handleFailedMentionClick}
            />
          ) : displayContent ? (
            <PostContent
              content={displayContent}
              className="mt-1"
              hashtagValidations={hashtagValidations}
              onFailedHashtagClick={handleFailedHashtagClick}
              mentionValidations={mentionValidations}
              onFailedMentionClick={handleFailedMentionClick}
            />
          ) : null}

          {/* Native poll (Pollr contract) — suppressed on tombstones */}
          {!isTombstoned && embeddedPollId && !isPrivatePost(post) && (
            <PollCard
              pollId={embeddedPollId}
              postContent={displayContent}
              postAuthorId={post.author.id}
            />
          )}

          {/* Quoted post - show skeleton while loading, then actual content.
              Either quote field may hold the reference (v3 splits them). */}
          {!isTombstoned && (post.quotedPostId || post.quotedReplyId) && !post.quotedPost && (
            <EmbeddedPostSkeleton />
          )}

          {!isTombstoned && post.quotedPost && (
            isEmbeddedBlogPostLike(post.quotedPost)
              ? <EmbeddedBlogPostCard post={post.quotedPost} />
              : <EmbeddedPostCard post={post.quotedPost} />
          )}

          {!isTombstoned && post.media && post.media.length > 0 && (
            <div className={cn(
              'mt-3 grid gap-1 rounded-xl overflow-hidden',
              post.media.length === 1 && 'grid-cols-1',
              post.media.length === 2 && 'grid-cols-2',
              post.media.length === 3 && 'grid-cols-2',
              post.media.length >= 4 && 'grid-cols-2'
            )}>
              {post.media.map((media, index) => (
                <div
                  key={media.id}
                  className={cn(
                    'relative aspect-video bg-gray-100 dark:bg-gray-900',
                    post.media && post.media.length === 3 && index === 0 && 'row-span-2'
                  )}
                >
                  <Image
                    src={media.url}
                    alt={media.alt || ''}
                    fill
                    className="object-cover"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between mt-3 -ml-2">
            <Tooltip.Provider>
              <ActionTooltip label={cantReplyReason || 'Reply'}>
                <button
                  data-testid={`reply-btn-${post.id}`}
                  onClick={(e) => { e.stopPropagation(); handleReply(); }}
                  disabled={!canReplyToPrivate}
                  className={cn(
                    "group flex items-center gap-1 p-2 rounded-full transition-colors",
                    !canReplyToPrivate
                      ? "opacity-50 cursor-not-allowed"
                      : "hover:bg-yappr-50 dark:hover:bg-yappr-950"
                  )}
                >
                  <ChatBubbleOvalLeftIcon className={cn(
                    "h-5 w-5 transition-colors",
                    !canReplyToPrivate
                      ? "text-gray-400"
                      : "text-gray-500 group-hover:text-yappr-500"
                  )} />
                  <span className={cn(
                    "text-sm transition-colors",
                    !canReplyToPrivate
                      ? "text-gray-400"
                      : "text-gray-500 group-hover:text-yappr-500"
                  )}>
                    {statsReplies > 0 && formatNumber(statsReplies)}
                  </span>
                </button>
              </ActionTooltip>

              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    data-testid={`repost-menu-btn-${post.id}`}
                    onClick={(e) => e.stopPropagation()}
                    disabled={repostLoading}
                    className={cn(
                      'group flex items-center gap-1 p-2 rounded-full transition-colors',
                      repostLoading && 'opacity-50 cursor-wait',
                      reposted
                        ? 'text-green-500 hover:bg-green-50 dark:hover:bg-green-950'
                        : 'hover:bg-green-50 dark:hover:bg-green-950'
                    )}
                  >
                    <ArrowPathIcon className={cn(
                      'h-5 w-5 transition-colors',
                      repostLoading && 'animate-spin',
                      reposted ? 'text-green-500' : 'text-gray-500 group-hover:text-green-500'
                    )} />
                    <span className={cn(
                      'text-sm transition-colors',
                      reposted ? 'text-green-500' : 'text-gray-500 group-hover:text-green-500'
                    )}>
                      {totalReposts > 0 && formatNumber(totalReposts)}
                    </span>
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="min-w-[160px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50"
                    sideOffset={5}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Reposting a reply has no doctype to write on v3 —
                        consensus rejects a reply id on `repost.postId` — so the
                        item is absent rather than failing when clicked. */}
                    {repostable && (
                      <DropdownMenu.Item
                        onClick={(e) => { e.stopPropagation(); handleRepost().catch((error) => logger.error(error)); }}
                        className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer outline-none"
                      >
                        <ArrowPathIcon className={cn('h-5 w-5', reposted ? 'text-green-500' : '')} />
                        {reposted ? 'Undo Repost' : 'Repost'}
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Item
                      onClick={(e) => { e.stopPropagation(); handleQuote(); }}
                      className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer outline-none"
                    >
                      <PencilSquareIcon className="h-5 w-5" />
                      Quote
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>

              <ActionTooltip label="Like">
                <button
                  data-testid={`like-btn-${post.id}`}
                  aria-pressed={liked}
                  onClick={(e) => { e.stopPropagation(); handleLike().catch((error) => logger.error(error)); }}
                  disabled={likeLoading}
                  className={cn(
                    'group flex items-center gap-1 p-2 rounded-full transition-colors',
                    likeLoading && 'opacity-50 cursor-wait',
                    liked
                      ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-950'
                      : 'hover:bg-red-50 dark:hover:bg-red-950'
                  )}
                >
                  <motion.div
                    whileTap={{ scale: 0.8 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                  >
                    {liked ? (
                      <HeartIconSolid className="h-5 w-5 text-red-500" />
                    ) : (
                      <HeartIcon className="h-5 w-5 text-gray-500 group-hover:text-red-500 transition-colors" />
                    )}
                  </motion.div>
                  <span className={cn(
                    'text-sm transition-colors',
                    liked ? 'text-red-500' : 'text-gray-500 group-hover:text-red-500'
                  )}>
                    {likes > 0 && formatNumber(likes)}
                  </span>
                </button>
              </ActionTooltip>

              {/* Tip button - disabled for own posts */}
              <ActionTooltip label={isOwnPost ? "Can't tip yourself" : "Tip"}>
                <button
                  onClick={(e) => { e.stopPropagation(); if (!isOwnPost) handleTip(); }}
                  disabled={isOwnPost}
                  className={cn(
                    "group flex items-center gap-1 p-2 rounded-full transition-colors",
                    isOwnPost
                      ? "opacity-40 cursor-not-allowed"
                      : "hover:bg-amber-50 dark:hover:bg-amber-950"
                  )}
                >
                  <CurrencyDollarIcon className={cn(
                    "h-5 w-5 transition-colors",
                    isOwnPost ? "text-gray-400" : "text-gray-500 group-hover:text-amber-500"
                  )} />
                </button>
              </ActionTooltip>

              <div className="flex items-center gap-1">
                {/* Same rule as Repost: `bookmark.postId` only accepts posts on
                    v3, so replies have no bookmark control at all. */}
                {bookmarkable && (
                  <ActionTooltip label="Bookmark">
                    <button
                      data-testid={`bookmark-btn-${post.id}`}
                      onClick={(e) => { e.stopPropagation(); handleBookmark().catch((error) => logger.error(error)); }}
                      disabled={bookmarkLoading}
                      className={cn(
                        'p-2 rounded-full hover:bg-yappr-50 dark:hover:bg-yappr-950 transition-colors',
                        bookmarkLoading && 'opacity-50 cursor-wait'
                      )}
                    >
                      {bookmarked ? (
                        <BookmarkIconSolid className="h-5 w-5 text-yappr-500" />
                      ) : (
                        <BookmarkIcon className="h-5 w-5 text-gray-500 hover:text-yappr-500 transition-colors" />
                      )}
                    </button>
                  </ActionTooltip>
                )}

                <ActionTooltip label="Share">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleShare(); }}
                    className="p-2 rounded-full hover:bg-yappr-50 dark:hover:bg-yappr-950 transition-colors"
                  >
                    <ArrowUpTrayIcon className="h-5 w-5 text-gray-500 hover:text-yappr-500 transition-colors" />
                  </button>
                </ActionTooltip>
              </div>
            </Tooltip.Provider>
          </div>
        </div>
      </div>
      
      <LikesModal 
        isOpen={showLikesModal}
        onClose={() => setShowLikesModal(false)}
        postId={post.id}
      />
    </motion.article>
  )
}
