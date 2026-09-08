'use client'

import { logger } from '@/lib/logger'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowPathIcon, ChatBubbleOvalLeftIcon, CurrencyDollarIcon, EllipsisHorizontalIcon, LockClosedIcon, TrashIcon } from '@heroicons/react/24/outline'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import toast from 'react-hot-toast'
import type { Post } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAppStore, useSettingsStore } from '@/lib/store'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { useRelativeTime } from '@/hooks/use-relative-time'
import { useCopy } from '@/hooks/use-copy'
import { useTipModal } from '@/hooks/use-tip-modal'
import { useBlock } from '@/hooks/use-block'
import { useFollow } from '@/hooks/use-follow'
import { useMediaGate } from '@/hooks/use-media-gate'
import { useQuotedPost } from '@/hooks/use-quoted-post'
import { usePostFieldValidation } from '@/hooks/use-post-field-validation'
import { useRecoveryModal } from '@/hooks/use-recovery-modal'
import { useDeleteConfirmationModal } from '@/hooks/use-delete-confirmation-modal'
import { useCanReplyToPrivate } from '@/hooks/use-can-reply-to-private'
import { usePostEngagement } from '@/hooks/use-post-engagement'
import { tipService } from '@/lib/services/tip-service'
import { shouldGateSensitive } from '@/lib/sensitive-content'
import { findPollrPollLink, getEmbeddedPollId, stripPollrPollLink } from '@/lib/poll-embed'
import { canBookmark, canRepost, deletesAreTombstones, targetKindOf } from '@/lib/contract-topology'
import { IconButton } from '@/components/ui/icon-button'
import { UserAvatar } from '@/components/ui/avatar-image'
import { TooltipBadge } from '@/components/ui/tooltip-button'
import { ProfileHoverCard } from '@/components/profile/profile-hover-card'
import { EmbeddedBlogPostCard, isEmbeddedBlogPostLike } from '@/components/blog/embedded-blog-post-card'
import { PollCard } from '@/components/poll/poll-card'
import { LikesModal } from './likes-modal'
import { PostContent } from './post-content'
import { PrivatePostContent, isPrivatePost } from './private-post-content'
import { SensitiveContentGate } from './sensitive-content-gate'
import { EmbeddedPostCard, EmbeddedPostSkeleton, EmbeddedPostUnavailable } from './embedded-post-card'
import { GatedPostMedia } from './gated-media'
import { PostActionBar } from './post-action-bar'
import { PostAuthorLine, hasRealProfile, resolveUsernameState } from './post-author-line'

/** What progressive loading has resolved so far for a card. */
export interface ProgressiveEnrichment {
  /** `undefined` while loading, `null` for an author with no DPNS name. */
  username: string | null | undefined
  displayName: string | undefined
  /** True once the profile lookup completed, even when no profile exists. Omitted = already resolved. */
  profileLoaded?: boolean
  avatarUrl: string | undefined
  stats: { likes: number; reposts: number; replies: number; quotes: number; views: number } | undefined
  interactions: { liked: boolean; reposted: boolean; bookmarked: boolean } | undefined
  isBlocked: boolean | undefined
  isFollowing: boolean | undefined
  replyTo?: { id: string; authorId: string; authorUsername: string | null }
}

interface PostCardProps {
  post: Post
  /** Hide the avatar and author line, and make the like button show who liked instead. */
  hideAvatar?: boolean
  isOwnPost?: boolean
  /** Progressive enrichment data; preferred over `post` fields when present. */
  enrichment?: ProgressiveEnrichment
  /** For replies, the owner of the thread's root post; private-reply access is checked against them. */
  rootPostOwnerId?: string
  /** The post a reply answers, for cards rendered outside their thread. */
  parentPost?: Post
  /** True while `parentPost` is still being fetched, so the embed slot is held with a skeleton. */
  parentPostLoading?: boolean
  /** Called after a successful delete so a list can drop the card. */
  onDelete?: (postId: string) => void
}

/**
 * How to address the author of a reply's parent: their DPNS handle when they
 * have one, their profile name otherwise, and a truncated identity for neither.
 */
function parentHandleOf(parent: Post): string {
  const { username, displayName, id } = parent.author
  if (username && !username.startsWith('user_')) return `@${username}`
  return hasRealProfile(displayName, id) ? displayName : `${id.slice(0, 8)}...`
}

const MENU_ITEM = 'px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none'
const mediaGridCols = (count: number) => (count === 1 ? 'grid-cols-1' : 'grid-cols-2')

export function PostCard({
  post,
  hideAvatar = false,
  isOwnPost: isOwnPostProp,
  enrichment: progressiveEnrichment,
  rootPostOwnerId,
  parentPost,
  parentPostLoading = false,
  onDelete,
}: PostCardProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()
  const copy = useCopy()
  const viewerId = user?.identityId
  const isOwnPost = isOwnPostProp ?? viewerId === post.author.id

  // Which document type this card shows. Every engagement dispatches on it: the
  // v3 topology gives posts and replies different interaction doctypes, and
  // forbids reposting or bookmarking a reply at all.
  const targetKind = targetKindOf(post)
  const isReply = targetKind === 'reply'
  const repostable = canRepost(targetKind)
  const bookmarkable = canBookmark(targetKind)
  // On v3 posts are permanent: "delete" blanks the document and flags it.
  const tombstones = deletesAreTombstones()
  const [locallyTombstoned, setLocallyTombstoned] = useState(false)
  // Beats EVERY content branch (tip, poll, quote, media), or a freshly
  // tombstoned card keeps exposing its former attachments until Platform data arrives.
  const isTombstoned = Boolean(post.deleted) || locallyTombstoned

  // Author-flagged sensitive content gets an opaque gate over the whole content
  // region for the same reason. 'hide' filtering is a list's job; here it blurs.
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode)
  const gateSensitive = !isTombstoned && shouldGateSensitive(post, sensitiveContentMode)

  // Display values: progressive enrichment, then post data, then placeholder.
  const legacyEnrichment = post._enrichment
  const displayName = progressiveEnrichment?.displayName ?? post.author.displayName
  const avatarUrl = progressiveEnrichment?.avatarUrl ?? legacyEnrichment?.authorAvatarUrl ?? post.author.avatar
  const usernameState = resolveUsernameState(progressiveEnrichment?.username, post.author)
  const hasProfile = hasRealProfile(displayName, post.author.id)
  // Callers that pass no progressive enrichment resolved the author before render.
  const profileLoaded = progressiveEnrichment?.profileLoaded ?? true

  const stats = {
    likes: progressiveEnrichment?.stats?.likes ?? post.likes,
    reposts: progressiveEnrichment?.stats?.reposts ?? post.reposts,
    replies: progressiveEnrichment?.stats?.replies ?? post.replies,
    quotes: progressiveEnrichment?.stats?.quotes ?? post.quotes,
  }
  const engagement = usePostEngagement(
    post,
    viewerId,
    {
      liked: progressiveEnrichment?.interactions?.liked ?? post.liked ?? false,
      likes: stats.likes,
      reposted: progressiveEnrichment?.interactions?.reposted ?? post.reposted ?? false,
      reposts: stats.reposts,
      bookmarked: progressiveEnrichment?.interactions?.bookmarked ?? post.bookmarked ?? false,
    },
    { targetKind, repostable, bookmarkable }
  )
  // The repost control shows reposts plus quote-posts; where the topology
  // forbids reposting this kind there is no repost doctype to have counted.
  const totalReposts = (repostable ? engagement.reposts : 0) + stats.quotes

  // The resolved author travels with the post into compose, tip and navigation
  // so cached copies render without loading skeletons.
  const enrichedPost = useMemo(
    () => ({
      ...post,
      author: {
        ...post.author,
        username: usernameState || post.author.username,
        displayName: displayName || post.author.displayName,
        avatar: avatarUrl || post.author.avatar,
        hasDpns: usernameState !== undefined ? usernameState !== null : post.author.hasDpns,
      },
    }),
    [post, usernameState, displayName, avatarUrl]
  )

  const [showLikesModal, setShowLikesModal] = useState(false)
  const { setReplyingTo, setComposeOpen, setQuotingPost } = useAppStore()
  const { open: openTipModal } = useTipModal()
  const { open: openRecoveryModal } = useRecoveryModal()
  const { open: openDeleteModal } = useDeleteConfirmationModal()
  // Whether each hashtag/mention index document actually landed on Platform.
  const { validations: hashtagValidations } = usePostFieldValidation('hashtag', post)
  const { validations: mentionValidations } = usePostFieldValidation('mention', post)
  const { isBlocked, isLoading: blockLoading, toggleBlock } = useBlock(post.author.id, {
    initialValue: progressiveEnrichment?.isBlocked ?? legacyEnrichment?.authorIsBlocked,
  })
  const { isFollowing, isLoading: followLoading, toggleFollow } = useFollow(post.author.id, {
    initialValue: progressiveEnrichment?.isFollowing ?? legacyEnrichment?.authorIsFollowing,
  })
  // Live follow state beats the enrichment snapshot as soon as useFollow
  // settles: the snapshot goes stale the moment the viewer unfollows, and a
  // stale true would leave this author's media ungated. While the hook is
  // resolving, the snapshot covers that window (undefined gates until then).
  const authorIsFollowing = followLoading ? progressiveEnrichment?.isFollowing ?? legacyEnrichment?.authorIsFollowing : isFollowing
  const mediaGate = useMediaGate(post.author.id, authorIsFollowing)
  // Batch-resolved when the loader attached one, otherwise fetched here.
  const { quotedPost, loading: quotedPostLoading, unavailable: quotedPostUnavailable } = useQuotedPost(post)
  // For replies, access is checked against the root post owner, not the reply author.
  const { canReply: canReplyToPrivate, reason: cantReplyReason } = useCanReplyToPrivate(post, rootPostOwnerId)

  const tipInfo = useMemo(() => tipService.parseTipContent(post.content), [post.content])
  const createdAtLabel = useRelativeTime(post.createdAt, { compact: true })
  // toISOString() throws on an invalid Date.
  const createdAtDate = new Date(post.createdAt)
  const createdAtValid = Number.isFinite(createdAtDate.getTime())

  // A native poll embed, or a legacy post that only links to the Pollr web app.
  // On a native poll post a Pollr URL in the body points at some other poll.
  const nativePollId = getEmbeddedPollId(post)
  const pollLink = useMemo(() => (nativePollId ? null : findPollrPollLink(post.content)), [nativePollId, post.content])
  const embeddedPollId = nativePollId ?? pollLink?.pollId ?? null
  // A legacy poll link is rendered as the poll itself, so drop the raw URL.
  const displayContent = useMemo(() => (pollLink ? stripPollrPollLink(post.content, pollLink.url) : post.content), [post.content, pollLink])

  const handleLike = () => {
    // On "Your Posts" the like button shows who liked instead.
    if (hideAvatar) {
      setShowLikesModal(true)
      return
    }
    if (requireAuth()) return engagement.toggleLike()
  }
  const handleRepost = () => {
    if (requireAuth()) return engagement.toggleRepost()
  }
  const handleBookmark = () => {
    if (requireAuth()) return engagement.toggleBookmark()
  }
  const handleQuote = () => {
    if (!requireAuth()) return
    setQuotingPost(enrichedPost)
    setComposeOpen(true)
  }
  const handleReply = () => {
    if (!requireAuth()) return
    if (!canReplyToPrivate) {
      toast.error(cantReplyReason || "Can't reply to this post")
      return
    }
    setReplyingTo(enrichedPost)
    setComposeOpen(true)
  }
  const handleShare = () => copy(`${window.location.origin}/post?id=${post.id}`, 'Link copied to clipboard')
  const handleTip = () => {
    if (requireAuth()) openTipModal(enrichedPost)
  }

  const handleDelete = () => {
    const authedUser = requireAuth()
    if (!authedUser) return
    openDeleteModal(post, async () => {
      let ok: boolean
      if (isReply) {
        const { replyService } = await import('@/lib/services/reply-service')
        ok = tombstones ? await replyService.tombstoneReply(post.id, authedUser.identityId) : await replyService.deleteReply(post.id, authedUser.identityId)
      } else {
        const { postService } = await import('@/lib/services/post-service')
        ok = tombstones ? await postService.tombstonePost(post.id, authedUser.identityId) : await postService.deletePost(post.id, authedUser.identityId)
      }
      if (!ok) throw new Error('Delete operation failed')
      toast.success(isReply ? 'Reply deleted' : 'Post deleted')
      // Detail and thread callers pass no onDelete, so the card must flip its
      // own rendering, or the pre-delete content would stay until a reload.
      if (tombstones) setLocallyTombstoned(true)
      onDelete?.(post.id)
    })
  }

  const handleCardClick = (e: React.MouseEvent) => {
    const url = `/post?id=${post.id}`
    // Hand the detail page what this card already shows, so it renders at once.
    useAppStore.getState().setPendingPostNavigation(enrichedPost, {
      username: usernameState,
      displayName,
      profileLoaded,
      avatarUrl,
      stats: progressiveEnrichment?.stats ?? { ...stats, views: post.views },
      interactions: progressiveEnrichment?.interactions ?? { liked: engagement.liked, reposted: engagement.reposted, bookmarked: engagement.bookmarked },
      isBlocked: progressiveEnrichment?.isBlocked ?? isBlocked,
      isFollowing: authorIsFollowing,
      replyTo: progressiveEnrichment?.replyTo,
    })
    if (e.ctrlKey || e.metaKey) window.open(url, '_blank')
    else router.push(url)
  }

  const authorLabel = usernameState ? `@${usernameState}` : displayName

  return (
    <article
      data-testid={`post-card-${post.id}`}
      onClick={handleCardClick}
      className="border-b border-gray-200 dark:border-gray-800 px-4 pt-3 pb-1 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors cursor-pointer"
    >
      {post.repostedBy && (
        <Link href={`/user?id=${post.repostedBy.id}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-2 text-sm text-gray-500 mb-2 ml-9 hover:underline">
          <ArrowPathIcon className="h-4 w-4" />
          <span>{post.repostedBy.username ? `@${post.repostedBy.username}` : post.repostedBy.displayName || 'Someone'} reposted</span>
        </Link>
      )}
      <div className="flex gap-3">
        {!hideAvatar && (
          <ProfileHoverCard userId={post.author.id} username={usernameState} displayName={displayName} avatarUrl={avatarUrl}>
            <Link href={`/user?id=${post.author.id}`} onClick={(e) => e.stopPropagation()} className="h-12 w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 block flex-shrink-0">
              <UserAvatar userId={post.author.id} size="lg" alt={displayName} preloadedUrl={avatarUrl || undefined} />
            </Link>
          </ProfileHoverCard>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 text-sm min-w-0">
              {!hideAvatar && (
                <PostAuthorLine
                  author={post.author}
                  usernameState={usernameState}
                  displayName={displayName}
                  avatarUrl={avatarUrl}
                  hasProfile={hasProfile}
                  profileLoaded={profileLoaded}
                />
              )}
              <time dateTime={createdAtValid ? createdAtDate.toISOString() : undefined} title={createdAtValid ? createdAtDate.toLocaleString() : undefined} className="text-gray-500 flex-shrink-0">
                {createdAtLabel}
              </time>
            </div>

            <div className="flex items-center gap-1 flex-shrink-0">
              {isPrivatePost(post) && (
                <span className="flex items-center gap-0.5 text-gray-500 mr-1">
                  <LockClosedIcon className="h-3.5 w-3.5" />
                </span>
              )}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <IconButton data-testid={`more-btn-${post.id}`} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                    <EllipsisHorizontalIcon className="h-5 w-5" />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="min-w-[200px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50" sideOffset={5}>
                    <DropdownMenu.Item
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleFollow().catch((error) => logger.error(error))
                      }}
                      disabled={followLoading}
                      className={cn(MENU_ITEM, 'disabled:opacity-50')}
                    >
                      {isFollowing ? 'Unfollow' : 'Follow'} {authorLabel}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onClick={(e) => {
                        e.stopPropagation()
                        // The engagements page needs the kind to know which doctypes to read.
                        router.push(`/post/engagements?id=${post.id}&kind=${targetKind}`)
                      }}
                      className={MENU_ITEM}
                    >
                      View post engagements
                    </DropdownMenu.Item>
                    {isOwnPost && (
                      <DropdownMenu.Item
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete()
                        }}
                        className={cn(MENU_ITEM, 'flex items-center gap-2 text-red-500')}
                      >
                        <TrashIcon className="h-4 w-4" />
                        Delete {isReply ? 'reply' : 'post'}
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Item
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleBlock().catch((error) => logger.error(error))
                      }}
                      disabled={blockLoading}
                      className={cn(MENU_ITEM, 'text-red-500 disabled:opacity-50')}
                    >
                      {isBlocked ? 'Unblock' : 'Block'} {authorLabel}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>

          <SensitiveContentGate postId={post.id} active={gateSensitive}>
            {isTombstoned ? (
              <p className="mt-2 text-sm italic text-gray-500 dark:text-gray-400">{isReply ? 'This reply was deleted.' : 'This post was deleted.'}</p>
            ) : tipInfo ? (
              <div className="mt-2">
                {/* TODO: drop the tooltip once the SDK exposes transition ids for on-chain verification. */}
                <TooltipBadge label="Unverified - awaiting SDK support" className="gap-1.5 px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-sm font-medium">
                  <CurrencyDollarIcon className="h-4 w-4" />
                  <span>Sent a tip of {tipService.formatDash(tipService.creditsToDash(tipInfo.amount))}</span>
                </TooltipBadge>
                {tipInfo.message && <PostContent content={tipInfo.message} className="mt-1" />}
              </div>
            ) : isPrivatePost(post) ? (
              <PrivatePostContent
                post={post}
                rootPostOwnerId={rootPostOwnerId}
                className="mt-1"
                hashtagValidations={hashtagValidations}
                onFailedHashtagClick={(hashtag) => openRecoveryModal('hashtag', post, hashtag)}
                mentionValidations={mentionValidations}
                onFailedMentionClick={(username) => openRecoveryModal('mention', post, username)}
                mediaGate={mediaGate}
              />
            ) : displayContent ? (
              <PostContent
                content={displayContent}
                className="mt-1"
                hashtagValidations={hashtagValidations}
                onFailedHashtagClick={(hashtag) => openRecoveryModal('hashtag', post, hashtag)}
                mentionValidations={mentionValidations}
                onFailedMentionClick={(username) => openRecoveryModal('mention', post, username)}
                mediaGate={mediaGate}
              />
            ) : null}

            {!isTombstoned && embeddedPollId && !isPrivatePost(post) && <PollCard pollId={embeddedPollId} postContent={displayContent} postAuthorId={post.author.id} />}

            {!isTombstoned && quotedPostLoading && <EmbeddedPostSkeleton />}
            {!isTombstoned && quotedPostUnavailable && <EmbeddedPostUnavailable />}
            {!isTombstoned && quotedPost && (isEmbeddedBlogPostLike(quotedPost) ? <EmbeddedBlogPostCard post={quotedPost} /> : <EmbeddedPostCard post={quotedPost} />)}

            {!isTombstoned && post.media && post.media.length > 0 && (
              <div className={cn('mt-3 grid gap-1 rounded-xl overflow-hidden', mediaGridCols(post.media.length))}>
                {post.media.map((media, index) => (
                  <div key={media.id} className={cn('relative aspect-video bg-gray-100 dark:bg-gray-900', post.media?.length === 3 && index === 0 && 'row-span-2')}>
                    <GatedPostMedia media={media} gate={mediaGate} />
                  </div>
                ))}
              </div>
            )}

            {/* Last, so the reply's own content and media stay together, and
                labelled so the embed does not read as a quote. */}
            {!isTombstoned && (parentPost || parentPostLoading) && (
              <div className="mt-3">
                <span className="flex items-center gap-1.5 text-sm text-gray-500">
                  <ChatBubbleOvalLeftIcon className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="truncate">Replying to{parentPost ? ` ${parentHandleOf(parentPost)}` : ''}</span>
                </span>
                {parentPost ? <EmbeddedPostCard post={parentPost} className="mt-1" /> : <EmbeddedPostSkeleton className="mt-1" />}
              </div>
            )}
          </SensitiveContentGate>

          <PostActionBar
            postId={post.id}
            isOwnPost={isOwnPost}
            reply={{ count: stats.replies, enabled: canReplyToPrivate, reason: cantReplyReason, onClick: handleReply }}
            repost={{ count: totalReposts, active: engagement.reposted, loading: engagement.repostLoading, allowed: repostable, onClick: handleRepost }}
            quote={{ onClick: handleQuote }}
            like={{ count: engagement.likes, active: engagement.liked, loading: engagement.likeLoading, onClick: handleLike }}
            tip={{ onClick: handleTip }}
            bookmark={bookmarkable ? { active: engagement.bookmarked, loading: engagement.bookmarkLoading, onClick: handleBookmark } : undefined}
            share={{ onClick: handleShare }}
          />
        </div>
      </div>

      <LikesModal isOpen={showLikesModal} onClose={() => setShowLikesModal(false)} postId={post.id} />
    </article>
  )
}
