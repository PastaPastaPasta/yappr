'use client'

import { useState, useEffect, useMemo } from 'react'
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
} from '@heroicons/react/24/outline'
import { HeartIcon as HeartIconSolid, BookmarkIcon as BookmarkIconSolid } from '@heroicons/react/24/solid'
import { Post } from '@/lib/types'
import { formatTime, formatNumber } from '@/lib/utils'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { IconButton } from '@/components/ui/icon-button'
import { getInitials, cn } from '@/lib/utils'
import { useAppStore } from '@/lib/store'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/auth-context'
import { UserAvatar } from '@/components/ui/avatar-image'
import { LikesModal } from './likes-modal'
import { PostContent } from './post-content'
import { useTipModal } from '@/hooks/use-tip-modal'
import { useBlock } from '@/hooks/use-block'
import { useFollow } from '@/hooks/use-follow'
import { tipService } from '@/lib/services/tip-service'

interface PostCardProps {
  post: Post
  hideAvatar?: boolean
  isOwnPost?: boolean
}

export function PostCard({ post, hideAvatar = false, isOwnPost: isOwnPostProp }: PostCardProps) {
  const router = useRouter()
  const { user } = useAuth()

  // Compute isOwnPost from auth context if not explicitly provided
  const isOwnPost = isOwnPostProp ?? (user?.identityId === post.author.id)
  const [liked, setLiked] = useState(post.liked || false)
  const [likes, setLikes] = useState(post.likes)
  const [reposted, setReposted] = useState(post.reposted || false)
  const [reposts, setReposts] = useState(post.reposts)
  const [bookmarked, setBookmarked] = useState(post.bookmarked || false)
  const [showLikesModal, setShowLikesModal] = useState(false)
  const [likeLoading, setLikeLoading] = useState(false)
  const [repostLoading, setRepostLoading] = useState(false)
  const [bookmarkLoading, setBookmarkLoading] = useState(false)
  const { setReplyingTo, setComposeOpen } = useAppStore()
  const { open: openTipModal } = useTipModal()
  const { isBlocked, isLoading: blockLoading, toggleBlock } = useBlock(post.author.id)
  const { isFollowing, isLoading: followLoading, toggleFollow } = useFollow(post.author.id)

  // Sync local state with prop changes (e.g., when parent enriches post data)
  useEffect(() => {
    setLiked(post.liked || false)
    setLikes(post.likes)
    setReposted(post.reposted || false)
    setReposts(post.reposts)
    setBookmarked(post.bookmarked || false)
  }, [post.liked, post.likes, post.reposted, post.reposts, post.bookmarked])

  // Check if this post is a tip and parse tip info
  const tipInfo = useMemo(() => tipService.parseTipContent(post.content), [post.content])
  const isTipPost = !!tipInfo

  const handleLike = async () => {
    if (hideAvatar) {
      // On "Your Posts" tab, show who liked instead of liking
      setShowLikesModal(true)
      return
    }

    if (!user) {
      toast.error('Please log in to like posts')
      return
    }

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
        ? await likeService.unlikePost(post.id, user.identityId)
        : await likeService.likePost(post.id, user.identityId)

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
    if (!user) {
      toast.error('Please log in to repost')
      return
    }

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
        ? await repostService.removeRepost(post.id, user.identityId)
        : await repostService.repostPost(post.id, user.identityId)

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

  const handleBookmark = async () => {
    if (!user) {
      toast.error('Please log in to bookmark posts')
      return
    }

    if (bookmarkLoading) return

    const wasBookmarked = bookmarked

    // Optimistic update
    setBookmarked(!wasBookmarked)
    setBookmarkLoading(true)

    try {
      const { bookmarkService } = await import('@/lib/services/bookmark-service')
      const success = wasBookmarked
        ? await bookmarkService.removeBookmark(post.id, user.identityId)
        : await bookmarkService.bookmarkPost(post.id, user.identityId)

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
    setReplyingTo(post)
    setComposeOpen(true)
  }

  const handleShare = () => {
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
    navigator.clipboard.writeText(`${baseUrl}/post?id=${post.id}`)
    toast.success('Link copied to clipboard')
  }

  const handleTip = () => {
    if (!user) {
      toast.error('Please log in to send tips')
      return
    }
    openTipModal(post)
  }

  const handleCardClick = () => {
    router.push(`/post?id=${post.id}`)
  }

  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={handleCardClick}
      className="border-b border-gray-200 dark:border-gray-800 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors cursor-pointer"
    >
      <div className="flex gap-3">
        {!hideAvatar && (
          <Link
            href={`/user?id=${post.author.id}`}
            onClick={(e) => e.stopPropagation()}
            className="h-12 w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 block flex-shrink-0"
          >
            <UserAvatar userId={post.author.id} size="lg" alt={post.author.displayName} />
          </Link>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 text-sm min-w-0">
              {!hideAvatar && (
                <>
                  {(post.author as any).hasDpns === undefined ? (
                    // Still loading - show skeleton for display name
                    <span className="inline-block w-24 h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                  ) : (
                    <Link
                      href={`/user?id=${post.author.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-semibold hover:underline truncate"
                    >
                      {post.author.displayName}
                    </Link>
                  )}
                  {post.author.verified && (
                    <svg className="h-4 w-4 text-yappr-500 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z" />
                    </svg>
                  )}
                  {(post.author as any).hasDpns ? (
                    <Link
                      href={`/user?id=${post.author.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-gray-500 hover:underline truncate"
                    >
                      @{post.author.username}
                    </Link>
                  ) : (post.author as any).hasDpns === false ? (
                    // Explicitly no DPNS - show identity ID
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              navigator.clipboard.writeText(post.author.id)
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
                  ) : (
                    // Still loading - show skeleton
                    <span className="inline-block w-20 h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-1 flex-shrink-0">
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
                    onClick={(e) => { e.stopPropagation(); toggleFollow(); }}
                    disabled={followLoading}
                    className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none disabled:opacity-50"
                  >
                    {isFollowing ? 'Unfollow' : 'Follow'} {(post.author as any).hasDpns ? `@${post.author.username}` : post.author.displayName}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none">
                    Add to Lists
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none">
                    Mute {(post.author as any).hasDpns ? `@${post.author.username}` : post.author.displayName}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={(e) => { e.stopPropagation(); toggleBlock(); }}
                    disabled={blockLoading}
                    className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none text-red-500 disabled:opacity-50"
                  >
                    {isBlocked ? 'Unblock' : 'Block'} {(post.author as any).hasDpns ? `@${post.author.username}` : post.author.displayName}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            </div>
          </div>

          {post.replyTo && !isTipPost && (
            <Link
              href={`/post?id=${post.replyTo.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sm text-gray-500 hover:underline mt-1 block"
            >
              Replying to <span className="text-yappr-500">@{post.replyTo.author.username}</span>
            </Link>
          )}

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
                        {post.replyTo && (
                          <> to <Link
                            href={`/user?id=${post.replyTo.author.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-semibold hover:underline"
                          >
                            @{post.replyTo.author.username || post.replyTo.author.displayName}
                          </Link></>
                        )}
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
          ) : (
            <PostContent content={post.content} className="mt-1" />
          )}

          {post.quotedPost && (
            <div className="mt-3 border border-gray-200 dark:border-gray-800 rounded-xl p-3 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors">
              <div className="flex items-center gap-1 text-sm text-gray-500">
                <Link
                  href={`/user?id=${post.quotedPost.author.id}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Avatar className="h-5 w-5">
                    <AvatarImage src={post.quotedPost.author.avatar} />
                    <AvatarFallback>{getInitials(post.quotedPost.author.displayName)}</AvatarFallback>
                  </Avatar>
                </Link>
                <Link
                  href={`/user?id=${post.quotedPost.author.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="font-semibold text-gray-900 dark:text-gray-100 hover:underline"
                >
                  {post.quotedPost.author.displayName}
                </Link>
                <Link
                  href={`/user?id=${post.quotedPost.author.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="hover:underline"
                >
                  @{post.quotedPost.author.username}
                </Link>
                <span>·</span>
                <span>{formatTime(post.quotedPost.createdAt)}</span>
              </div>
              <PostContent content={post.quotedPost.content} className="mt-1 text-sm" />
            </div>
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
                    post.media!.length === 3 && index === 0 && 'row-span-2'
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
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleReply(); }}
                    className="group flex items-center gap-1 p-2 rounded-full hover:bg-yappr-50 dark:hover:bg-yappr-950 transition-colors"
                  >
                    <ChatBubbleOvalLeftIcon className="h-5 w-5 text-gray-500 group-hover:text-yappr-500 transition-colors" />
                    <span className="text-sm text-gray-500 group-hover:text-yappr-500 transition-colors">
                      {post.replies > 0 && formatNumber(post.replies)}
                    </span>
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                    sideOffset={5}
                  >
                    Reply
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>

              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRepost(); }}
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
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                    sideOffset={5}
                  >
                    Repost
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>

              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleLike(); }}
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
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                    sideOffset={5}
                  >
                    Like
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>

              {/* Tip button - disabled for own posts */}
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
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
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                    sideOffset={5}
                  >
                    {isOwnPost ? "Can't tip yourself" : "Tip"}
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>

              <div className="flex items-center gap-1">
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleBookmark(); }}
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
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                      sideOffset={5}
                    >
                      Bookmark
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>

                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleShare(); }}
                      className="p-2 rounded-full hover:bg-yappr-50 dark:hover:bg-yappr-950 transition-colors"
                    >
                      <ArrowUpTrayIcon className="h-5 w-5 text-gray-500 hover:text-yappr-500 transition-colors" />
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                      sideOffset={5}
                    >
                      Share
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
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