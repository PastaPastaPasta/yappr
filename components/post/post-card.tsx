'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { NsfwImageGuard } from '@/components/post/nsfw-image-guard'
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
import { formatTime, formatNumber } from '@/lib/utils'
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
import { PrivateQuotedPostContent, isQuotedPostPrivate } from './private-quoted-post-content'
import { ProfileHoverCard } from '@/components/profile/profile-hover-card'
import { useTipModal } from '@/hooks/use-tip-modal'
import { useBlock } from '@/hooks/use-block'
import { useFollow } from '@/hooks/use-follow'
import { useHashtagValidation } from '@/hooks/use-hashtag-validation'
import { useHashtagRecoveryModal } from '@/hooks/use-hashtag-recovery-modal'
import { useMentionValidation } from '@/hooks/use-mention-validation'
import { useMentionRecoveryModal } from '@/hooks/use-mention-recovery-modal'
import { useDeleteConfirmationModal } from '@/hooks/use-delete-confirmation-modal'
import { tipService } from '@/lib/services/tip-service'
import { useCanReplyToPrivate } from '@/hooks/use-can-reply-to-private'

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
  stats: { likes: number; reposts: number; replies: number; views: number } | undefined
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
  /** Hide the "Replying to" annotation (used on post detail pages where structure makes it clear) */
  hideReplyTo?: boolean
  /** For replies to private posts, the root post owner ID to check access against */
  rootPostOwnerId?: string
  /** Callback when post is successfully deleted - parent component should remove post from list */
  onDelete?: (postId: string) => void
}

export function PostCard({ post, hideAvatar = false, isOwnPost: isOwnPostProp, enrichment: progressiveEnrichment, hideReplyTo = false, rootPostOwnerId, onDelete }: PostCardProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()

  // Compute isOwnPost from auth context if not explicitly provided
  const isOwnPost = isOwnPostProp ?? (user?.identityId === post.author.id)

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
                      navigator.clipboard.writeText(post.author.id).catch(console.error)
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
      const { likeService } = await import('@/lib/services/like-service')
      const success = wasLiked
        ? await likeService.unlikePost(post.id, authedUser.identityId)
        : await likeService.likePost(post.id, authedUser.identityId, post.author.id)

      if (!success) throw new Error('Like operation failed')
    } catch (error) {
      // Rollback on error
      setLiked(wasLiked)
      setLikes(prevLikes)
      console.error('Like error:', error)
      toast.error('Failed to update like. Please try again.')
    } finally {
      setLikeLoading(false)
    }
  }

  const handleRepost = async () => {
    const authedUser = requireAuth('repost')
    if (!authedUser) return

    if (repostLoading) return

    const wasReposted = reposted
    const prevReposts = reposts

    // Optimistic update
    setReposted(!wasReposted)
    setReposts(wasReposted ? prevReposts - 1 : prevReposts + 1)
    setRepostLoading(true)

    try {
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
      console.error('Repost error:', error)
      toast.error('Failed to update repost. Please try again.')
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

    if (bookmarkLoading) return

    const wasBookmarked = bookmarked

    // Optimistic update
    setBookmarked(!wasBookmarked)
    setBookmarkLoading(true)

    try {
      const { bookmarkService } = await import('@/lib/services/bookmark-service')
      const success = wasBookmarked
        ? await bookmarkService.removeBookmark(post.id, authedUser.identityId)
        : await bookmarkService.bookmarkPost(post.id, authedUser.identityId)

      if (!success) throw new Error('Bookmark operation failed')
      toast.success(wasBookmarked ? 'Removed from bookmarks' : 'Added to bookmarks')
    } catch (error) {
      // Rollback on error
      setBookmarked(wasBookmarked)
      console.error('Bookmark error:', error)
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
    navigator.clipboard.writeText(`${baseUrl}/post?id=${post.id}`).catch(console.error)
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

    // Check if this is a reply (has parentId) or a post
    const isReply = Boolean(post.parentId)

    openDeleteModal(post, async () => {
      let success: boolean

      if (isReply) {
        // Use replyService for replies (document type 'reply')
        const { replyService } = await import('@/lib/services/reply-service')
        success = await replyService.deleteReply(post.id, authedUser.identityId)
      } else {
        // Use postService for posts (document type 'post')
        const { postService } = await import('@/lib/services/post-service')
        success = await postService.deletePost(post.id, authedUser.identityId)
      }

      if (!success) throw new Error('Delete operation failed')

      toast.success(isReply ? 'Reply deleted' : 'Post deleted')
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
              <span className="text-gray-500 text-sm">{formatTime(post.createdAt)}</span>
              <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                  <EllipsisHorizontalIcon className="h-5 w-5" />
                </IconButton>
              </DropdownMenu.Trigger>
              
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="min-w-[200px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50"
                  sideOffset={5}
                >
                  <DropdownMenu.Item
                    onClick={(e) => { e.stopPropagation(); toggleFollow().catch(console.error); }}
                    disabled={followLoading}
                    className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none disabled:opacity-50"
                  >
                    {isFollowing ? 'Unfollow' : 'Follow'} {usernameState ? `@${usernameState}` : displayName}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/post/engagements?id=${post.id}`);
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
                      Delete post
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Item
                    onClick={(e) => { e.stopPropagation(); toggleBlock().catch(console.error); }}
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
          {isTipPost ? (
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
              className="mt-1"
              hashtagValidations={hashtagValidations}
              onFailedHashtagClick={handleFailedHashtagClick}
              mentionValidations={mentionValidations}
              onFailedMentionClick={handleFailedMentionClick}
            />
          ) : post.content ? (
            <PostContent
              content={post.content}
              className="mt-1"
              hashtagValidations={hashtagValidations}
              onFailedHashtagClick={handleFailedHashtagClick}
              mentionValidations={mentionValidations}
              onFailedMentionClick={handleFailedMentionClick}
            />
          ) : null}

          {/* Quoted post - show skeleton while loading, then actual content */}
          {post.quotedPostId && !post.quotedPost && (
            <div className="mt-3 border border-gray-200 dark:border-gray-700 rounded-xl p-3 animate-pulse">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-gray-200 dark:bg-gray-700" />
                <div className="h-3 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="h-3 w-16 bg-gray-200 dark:bg-gray-700 rounded" />
              </div>
              <div className="mt-2 space-y-2">
                <div className="h-3 w-full bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="h-3 w-3/4 bg-gray-200 dark:bg-gray-700 rounded" />
              </div>
            </div>
          )}

          {post.quotedPost && (
            isQuotedPostPrivate(post.quotedPost) ? (
              // PRD §5.3: Private quoted posts are decrypted separately
              <PrivateQuotedPostContent quotedPost={post.quotedPost} />
            ) : (
              <Link
                href={`/post?id=${post.quotedPost.id}`}
                onClick={(e) => e.stopPropagation()}
                className="mt-3 block border border-gray-200 dark:border-gray-700 rounded-xl p-3 hover:bg-gray-50 dark:hover:bg-gray-900/50 hover:border-gray-400 dark:hover:border-gray-500 transition-all cursor-pointer"
              >
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <UserAvatar userId={post.quotedPost.author.id} size="sm" alt={post.quotedPost.author.displayName} />
                  <span className="font-semibold text-gray-900 dark:text-gray-100">
                    {post.quotedPost.author.displayName}
                  </span>
                  {post.quotedPost.author.username && !post.quotedPost.author.username.startsWith('user_') ? (
                    <span className="text-gray-500">@{post.quotedPost.author.username}</span>
                  ) : (
                    <span className="text-gray-500 font-mono text-xs">
                      {post.quotedPost.author.id.slice(0, 8)}...
                    </span>
                  )}
                  <span>·</span>
                  <span>{formatTime(post.quotedPost.createdAt)}</span>
                </div>
                <PostContent content={post.quotedPost.content} className="mt-1 text-sm" />
              </Link>
            )
          )}

          {post.media && post.media.length > 0 && (
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
                  <NsfwImageGuard
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
                      {reposts > 0 && formatNumber(reposts)}
                    </span>
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="min-w-[160px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50"
                    sideOffset={5}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DropdownMenu.Item
                      onClick={(e) => { e.stopPropagation(); handleRepost().catch(console.error); }}
                      className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer outline-none"
                    >
                      <ArrowPathIcon className={cn('h-5 w-5', reposted ? 'text-green-500' : '')} />
                      {reposted ? 'Undo Repost' : 'Repost'}
                    </DropdownMenu.Item>
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
                  onClick={(e) => { e.stopPropagation(); handleLike().catch(console.error); }}
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
                <ActionTooltip label="Bookmark">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleBookmark().catch(console.error); }}
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