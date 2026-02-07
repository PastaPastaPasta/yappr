'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { LoadingState, useAsyncState } from '@/components/ui/loading-state'
import ErrorBoundary from '@/components/error-boundary'
import { followService, dpnsService, unifiedProfileService, likeService, repostService, postService } from '@/lib/services'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import * as Tooltip from '@radix-ui/react-tooltip'
import toast from 'react-hot-toast'
import { useSettingsStore } from '@/lib/store'

type TabType = 'quotes' | 'reposts' | 'likes'

interface EngagementUser {
  id: string
  username: string
  displayName: string
  bio?: string
  hasDpnsName: boolean
  hasProfile: boolean
  isFollowing: boolean
  // For quotes tab
  quoteContent?: string
  quotePostId?: string
}

/**
 * Batch resolve user data for a list of owner IDs.
 * Returns engagement user objects with DPNS names, profiles, and follow status.
 */
async function resolveEngagementUsers(
  ownerIds: string[],
  currentUserId: string | undefined
): Promise<Pick<EngagementUser, 'id' | 'username' | 'displayName' | 'bio' | 'hasDpnsName' | 'hasProfile' | 'isFollowing'>[]> {
  const [dpnsNamesMap, profiles, followStatus] = await Promise.all([
    dpnsService.resolveUsernamesBatch(ownerIds),
    unifiedProfileService.getProfilesByIdentityIds(ownerIds),
    currentUserId
      ? followService.getFollowStatusBatch(ownerIds, currentUserId)
      : Promise.resolve(new Map<string, boolean>())
  ])

  const profileMap = new Map(profiles.map((p: any) => [p.$ownerId || p.ownerId, p]))

  return ownerIds.map((id) => {
    const username = dpnsNamesMap.get(id) || null
    const profile = profileMap.get(id)
    const profileData = (profile as any)?.data || profile
    const profileDisplayName = profileData?.displayName

    return {
      id,
      username: username || id.slice(-8),
      displayName: profileDisplayName || username || `User ${id.slice(-8)}`,
      bio: profileData?.bio,
      hasDpnsName: !!username,
      hasProfile: !!profileDisplayName,
      isFollowing: followStatus.get(id) || false
    }
  })
}

function EngagementsPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const postId = searchParams.get('id')

  const [activeTab, setActiveTab] = useState<TabType>('likes')

  // Separate state for each tab - null means not yet loaded
  const quotesState = useAsyncState<EngagementUser[]>(null)
  const repostsState = useAsyncState<EngagementUser[]>(null)
  const likesState = useAsyncState<EngagementUser[]>(null)

  const [actionInProgress, setActionInProgress] = useState<Set<string>>(new Set())

  // Load likes
  const loadLikes = useCallback(async () => {
    if (!postId) return

    const { setLoading, setError, setData } = likesState
    setLoading(true)
    setError(null)

    try {
      const likes = await likeService.getPostLikes(postId)
      const ownerIds = likes.map(l => l.$ownerId).filter(Boolean)

      if (ownerIds.length === 0) {
        setData([])
        return
      }

      const users = await resolveEngagementUsers(ownerIds, user?.identityId)
      setData(users)
    } catch (error) {
      console.error('Failed to load likes:', error)
      setError(error instanceof Error ? error.message : 'Failed to load likes')
    } finally {
      setLoading(false)
    }
  }, [postId, user?.identityId, likesState])

  // Load reposts
  const loadReposts = useCallback(async () => {
    if (!postId) return

    const { setLoading, setError, setData } = repostsState
    setLoading(true)
    setError(null)

    try {
      const reposts = await repostService.getPostReposts(postId)
      const ownerIds = reposts.map(r => r.$ownerId).filter(Boolean)

      if (ownerIds.length === 0) {
        setData([])
        return
      }

      const users = await resolveEngagementUsers(ownerIds, user?.identityId)
      setData(users)
    } catch (error) {
      console.error('Failed to load reposts:', error)
      setError(error instanceof Error ? error.message : 'Failed to load reposts')
    } finally {
      setLoading(false)
    }
  }, [postId, user?.identityId, repostsState])

  // Load quotes
  const loadQuotes = useCallback(async () => {
    if (!postId) return

    const { setLoading, setError, setData } = quotesState
    setLoading(true)
    setError(null)

    try {
      const quotePosts = await postService.getQuotePosts(postId)

      if (quotePosts.length === 0) {
        setData([])
        return
      }

      const ownerIds = quotePosts.map(p => p.author.id).filter(Boolean)
      const baseUsers = await resolveEngagementUsers(ownerIds, user?.identityId)

      // Create Map for O(1) lookups - avoids index mismatch when filter(Boolean) removes IDs
      const baseUsersMap = new Map(baseUsers.map(u => [u.id, u]))

      // Add quote-specific fields by joining with quotePosts data using ID-based lookup
      const users: EngagementUser[] = quotePosts.map((post) => ({
        ...(baseUsersMap.get(post.author.id) || {
          id: post.author.id,
          username: post.author.id?.slice(-8) || 'unknown',
          displayName: 'User ' + (post.author.id?.slice(-8) || 'unknown'),
          hasDpnsName: false,
          hasProfile: false,
          isFollowing: false
        }),
        quoteContent: post.content,
        quotePostId: post.id
      }))

      setData(users)
    } catch (error) {
      console.error('Failed to load quotes:', error)
      setError(error instanceof Error ? error.message : 'Failed to load quotes')
    } finally {
      setLoading(false)
    }
  }, [postId, user?.identityId, quotesState])

  // Load data for active tab (only if not yet loaded)
  useEffect(() => {
    if (!postId) return

    switch (activeTab) {
      case 'likes':
        if (likesState.data === null) {
          loadLikes().catch(err => console.error('Failed to load likes:', err))
        }
        break
      case 'reposts':
        if (repostsState.data === null) {
          loadReposts().catch(err => console.error('Failed to load reposts:', err))
        }
        break
      case 'quotes':
        if (quotesState.data === null) {
          loadQuotes().catch(err => console.error('Failed to load quotes:', err))
        }
        break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, postId])

  const handleFollow = async (userId: string) => {
    const authedUser = requireAuth('follow')
    if (!authedUser) return

    setActionInProgress(prev => new Set(prev).add(userId))

    try {
      const result = await followService.followUser(authedUser.identityId, userId)
      if (result.success) {
        // Update local state in all tabs
        const updateUsers = (users: EngagementUser[] | null) =>
          (users || []).map(u => u.id === userId ? { ...u, isFollowing: true } : u)

        likesState.setData(updateUsers)
        repostsState.setData(updateUsers)
        quotesState.setData(updateUsers)
        toast.success('Following!')
      } else {
        toast.error('Failed to follow user')
      }
    } catch (error) {
      console.error('Error following user:', error)
      toast.error('Failed to follow user')
    } finally {
      setActionInProgress(prev => {
        const newSet = new Set(prev)
        newSet.delete(userId)
        return newSet
      })
    }
  }

  const handleUnfollow = async (userId: string) => {
    const authedUser = requireAuth('follow')
    if (!authedUser) return

    setActionInProgress(prev => new Set(prev).add(userId))

    try {
      const result = await followService.unfollowUser(authedUser.identityId, userId)
      if (result.success) {
        // Update local state in all tabs
        const updateUsers = (users: EngagementUser[] | null) =>
          (users || []).map(u => u.id === userId ? { ...u, isFollowing: false } : u)

        likesState.setData(updateUsers)
        repostsState.setData(updateUsers)
        quotesState.setData(updateUsers)
        toast.success('Unfollowed')
      } else {
        toast.error('Failed to unfollow user')
      }
    } catch (error) {
      console.error('Error unfollowing user:', error)
      toast.error('Failed to unfollow user')
    } finally {
      setActionInProgress(prev => {
        const newSet = new Set(prev)
        newSet.delete(userId)
        return newSet
      })
    }
  }

  const getCurrentState = () => {
    switch (activeTab) {
      case 'quotes': return quotesState
      case 'reposts': return repostsState
      case 'likes': return likesState
    }
  }

  const getCurrentLoader = () => {
    switch (activeTab) {
      case 'quotes': return loadQuotes
      case 'reposts': return loadReposts
      case 'likes': return loadLikes
    }
  }

  const getEmptyText = () => {
    switch (activeTab) {
      case 'quotes': return 'No quotes yet'
      case 'reposts': return 'No reposts yet'
      case 'likes': return 'No likes yet'
    }
  }

  const getEmptyDescription = () => {
    switch (activeTab) {
      case 'quotes': return 'When people quote this post, they\'ll appear here.'
      case 'reposts': return 'When people repost this post, they\'ll appear here.'
      case 'likes': return 'When people like this post, they\'ll appear here.'
    }
  }

  const currentState = getCurrentState()
  const currentLoader = getCurrentLoader()

  if (!postId) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex items-center justify-center">
        <p className="text-gray-500">Post not found</p>
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-gray-900/80 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="px-4 py-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => router.back()}
                  className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                >
                  <ArrowLeftIcon className="h-5 w-5" />
                </button>
                <h1 className="text-xl font-display font-bold">Post engagements</h1>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 dark:border-gray-800">
              {(['quotes', 'reposts', 'likes'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'flex-1 py-4 text-center font-medium transition-colors relative',
                    activeTab === tab
                      ? 'text-gray-900 dark:text-white'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  )}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {activeTab === tab && (
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-14 h-1 bg-yappr-500 rounded-full" />
                  )}
                </button>
              ))}
            </div>
          </header>

          <ErrorBoundary level="component">
            <LoadingState
              loading={currentState.loading || currentState.data === null}
              error={currentState.error}
              isEmpty={!currentState.loading && currentState.data !== null && currentState.data.length === 0}
              onRetry={currentLoader}
              loadingText={`Loading ${activeTab}...`}
              emptyText={getEmptyText()}
              emptyDescription={getEmptyDescription()}
            >
              <div>
                {currentState.data?.map((engagement) => (
                  <motion.div
                    key={`${activeTab}-${engagement.id}-${engagement.quotePostId || ''}`}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="border-b border-gray-200 dark:border-gray-800 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => router.push(`/user?id=${engagement.id}`)}
                        className="h-12 w-12 rounded-full overflow-hidden bg-white dark:bg-gray-900 cursor-pointer hover:opacity-80 transition-opacity flex-shrink-0"
                      >
                        <UserAvatar userId={engagement.id} size="lg" alt={engagement.displayName} />
                      </button>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between">
                          <div className="min-w-0 flex-1">
                            <h3
                              onClick={() => router.push(`/user?id=${engagement.id}`)}
                              className="font-semibold hover:underline cursor-pointer truncate"
                            >
                              {engagement.displayName}
                            </h3>
                            {engagement.hasDpnsName ? (
                              // Has DPNS: show @username
                              <p
                                onClick={() => router.push(`/user?id=${engagement.id}`)}
                                className="text-sm text-gray-500 hover:underline cursor-pointer"
                              >
                                @{engagement.username}
                              </p>
                            ) : !engagement.hasProfile ? (
                              // No DPNS and no profile: show identity ID
                              <Tooltip.Provider>
                                <Tooltip.Root>
                                  <Tooltip.Trigger asChild>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        navigator.clipboard.writeText(engagement.id).catch(console.error)
                                        toast.success('Identity ID copied')
                                      }}
                                      className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-mono"
                                    >
                                      {engagement.id.slice(0, 8)}...{engagement.id.slice(-6)}
                                    </button>
                                  </Tooltip.Trigger>
                                  <Tooltip.Portal>
                                    <Tooltip.Content
                                      className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                                      sideOffset={5}
                                    >
                                      Click to copy full identity ID
                                    </Tooltip.Content>
                                  </Tooltip.Portal>
                                </Tooltip.Root>
                              </Tooltip.Provider>
                            ) : null /* Has profile but no DPNS: display name is sufficient */}
                            {engagement.bio && (
                              <p className="text-sm mt-1 text-gray-600 dark:text-gray-400 line-clamp-2">
                                {engagement.bio}
                              </p>
                            )}

                            {/* Show quote content for quotes tab */}
                            {activeTab === 'quotes' && engagement.quoteContent && (
                              <button
                                onClick={() => router.push(`/post?id=${engagement.quotePostId}`)}
                                className="mt-2 p-2 bg-gray-50 dark:bg-gray-900 rounded-lg text-sm text-left w-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                              >
                                <p className="text-gray-600 dark:text-gray-400 line-clamp-2">
                                  &ldquo;{engagement.quoteContent}&rdquo;
                                </p>
                              </button>
                            )}
                          </div>

                          {/* Follow/Unfollow button */}
                          {user?.identityId !== engagement.id && (
                            engagement.isFollowing ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleUnfollow(engagement.id)}
                                className="ml-4 flex-shrink-0"
                                disabled={actionInProgress.has(engagement.id)}
                              >
                                {actionInProgress.has(engagement.id) ? (
                                  <Spinner size="sm" />
                                ) : (
                                  'Following'
                                )}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                onClick={() => handleFollow(engagement.id)}
                                className="ml-4 flex-shrink-0"
                                disabled={actionInProgress.has(engagement.id)}
                              >
                                {actionInProgress.has(engagement.id) ? (
                                  <Spinner size="sm" className="border-white" />
                                ) : (
                                  'Follow'
                                )}
                              </Button>
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </LoadingState>
          </ErrorBoundary>
        </main>
      </div>

      <RightSidebar />
    </div>
  )
}

function EngagementsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[calc(100vh-40px)] flex items-center justify-center">
        <Spinner size="md" />
      </div>
    }>
      <EngagementsPageContent />
    </Suspense>
  )
}

export default withAuth(EngagementsPage)
