'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeftIcon, AtSymbolIcon } from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { PostCard } from '@/components/post/post-card'
import { Spinner } from '@/components/ui/spinner'
import { formatNumber } from '@/lib/utils'
import { mentionService } from '@/lib/services/mention-service'
import { Post } from '@/lib/types'
import { useAuth } from '@/contexts/auth-context'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { dpnsService } from '@/lib/services/dpns-service'
import { useSettingsStore } from '@/lib/store'
import { filterHiddenSensitive } from '@/lib/sensitive-content'
import type { PostMentionDocument } from '@/lib/services/mention-service'
import { useHydratedPages } from '@/hooks/use-hydrated-pages'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { InfiniteScrollSentinel } from '@/components/ui/infinite-scroll-sentinel'

/** Mentioning posts fetched and enriched per page. */
const PAGE_SIZE = 30

function MentionsPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const userId = searchParams.get('user')
  const { user: currentUser } = useAuth()
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode)

  const [isLoading, setIsLoading] = useState(true)
  const [displayUsername, setDisplayUsername] = useState<string | null>(null)
  const viewerId = currentUser?.identityId

  // Default to current user if no user specified
  const targetUserId = userId || currentUser?.identityId

  // Resolve username for display
  useEffect(() => {
    if (targetUserId) {
      dpnsService.resolveUsername(targetUserId)
        .then(username => setDisplayUsername(username))
        .catch(() => setDisplayUsername(null))
    }
  }, [targetUserId])

  // One page of mentions: the mentioning posts (and v10 replies), authentic
  // only, newest first, enriched, without authors the viewer blocks.
  const hydrateMentions = useCallback(async (mentionDocs: PostMentionDocument[]): Promise<Post[]> => {
    const { postService } = await import('@/lib/services/post-service')
    const { posts: fetchedPosts, preloaded } = await mentionService.loadMentioningPosts(mentionDocs)
    const enrichedPosts = await postService.enrichPostsBatch(fetchedPosts, preloaded)
    if (!viewerId || enrichedPosts.length === 0) return enrichedPosts
    const authorIds = Array.from(new Set(enrichedPosts.map(p => p.author.id)))
    const blockedMap = await checkBlockedForAuthors(viewerId, authorIds)
    return enrichedPosts.filter(post => !blockedMap.get(post.author.id))
  }, [viewerId])
  const mentions = useHydratedPages(hydrateMentions, PAGE_SIZE)
  const { reset: resetMentions } = mentions
  const posts = mentions.pages?.items ?? []
  // Posts shown, not mention records: anyone can write a record naming this
  // user, and forged, blocked and deleted ones drop out as pages load.
  const mentionCount = posts.length
  const scroll = useInfiniteScroll({
    hasMore: mentions.hasMore,
    isLoading: mentions.loadingMore,
    onLoadMore: mentions.loadMore,
    resetKey: targetUserId,
  })

  useEffect(() => {
    // A read for the previous user must not land in this one's list.
    let cancelled = false
    const loadMentionedPosts = async () => {
      if (!targetUserId) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      try {
        // Every mention of this user (no cap), newest first; posts load a page at a time.
        const mentionDocs = await mentionService.getPostsMentioningUser(targetUserId)
        if (!cancelled) await resetMentions(mentionDocs)
      } catch (error) {
        logger.error('Failed to load mentioned posts:', error)
        if (!cancelled) await resetMentions([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    loadMentionedPosts().catch(err => logger.error('Failed to load mentioned posts:', err))
    return () => { cancelled = true }
  }, [targetUserId, hydrateMentions, resetMentions])

  // If not logged in and no user specified
  if (!targetUserId) {
    return (
      <PageShell>
            <div className="p-12 text-center">
              <AtSymbolIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">No user specified</h2>
              <p className="text-gray-500">
                Log in to see posts that mention you
              </p>
            </div>
      </PageShell>
    )
  }

  const isCurrentUser = currentUser?.identityId === targetUserId
  const headerTitle = isCurrentUser
    ? 'Mentions'
    : displayUsername
      ? `Mentions of @${displayUsername}`
      : 'Mentions'

  return (
    <PageShell>
          {/* Header */}
          <PageHeader>
            <div className="flex items-center gap-4 p-4">
              <button
                aria-label="Back"
                onClick={() => router.back()}
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-xl font-bold flex items-center gap-1">
                  <AtSymbolIcon className="h-5 w-5 text-yappr-500" />
                  {headerTitle}
                </h1>
                <p className="text-sm text-gray-500">
                  {formatNumber(mentionCount)}{mentions.hasMore ? '+' : ''} {mentionCount === 1 && !mentions.hasMore ? 'post' : 'posts'}
                </p>
              </div>
            </div>
          </PageHeader>

          {/* Content */}
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {isLoading ? (
              <div className="p-8 text-center">
                <Spinner size="md" className="mx-auto mb-4" />
                <p className="text-gray-500">Loading mentions...</p>
              </div>
            ) : posts.length === 0 && !mentions.hasMore ? (
              <div className="p-12 text-center">
                <AtSymbolIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                <h2 className="text-xl font-semibold mb-2">No mentions yet</h2>
                <p className="text-gray-500 mb-4">
                  {isCurrentUser
                    ? 'When people mention you in their posts, they will appear here'
                    : `No posts mentioning this user yet`
                  }
                </p>
              </div>
            ) : (
              <>
                {filterHiddenSensitive(posts, sensitiveContentMode, viewerId).map((post, index) => (
                  <motion.div
                    key={post.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: (index % PAGE_SIZE) * 0.05 }}
                  >
                    <PostCard post={post} />
                  </motion.div>
                ))}
                {mentions.hasMore && (
                  <InfiniteScrollSentinel
                    sentinelRef={scroll.sentinelRef}
                    isLoading={mentions.loadingMore}
                    isSuspended={scroll.isSuspended}
                    onLoadMore={scroll.loadMore}
                  />
                )}
              </>
            )}
          </div>
    </PageShell>
  )
}

export default function MentionsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[calc(100vh-40px)] flex items-center justify-center">
        <Spinner size="md" />
      </div>
    }>
      <MentionsPageContent />
    </Suspense>
  )
}
