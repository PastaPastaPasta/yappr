'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowPathIcon, ArrowLeftIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { LoadingState, useAsyncState } from '@/components/ui/loading-state'
import ErrorBoundary from '@/components/error-boundary'
import { followService, dpnsService, unifiedProfileService } from '@/lib/services'
import { cacheManager } from '@/lib/cache-manager'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { formatNumber } from '@/lib/utils'
import { AlsoKnownAs } from '@/components/ui/also-known-as'
import { ProfileHoverCard } from '@/components/profile/profile-hover-card'
import * as Tooltip from '@radix-ui/react-tooltip'
import toast from 'react-hot-toast'
import { useSettingsStore } from '@/lib/store'

interface Follower {
  id: string
  username: string
  displayName: string
  bio?: string
  hasProfile?: boolean
  hasDpnsName: boolean
  followersCount: number
  followingCount: number
  isFollowingBack: boolean
  allUsernames?: string[]
}

function FollowersPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const followersState = useAsyncState<Follower[]>(null)
  // Extract stable setter functions to avoid infinite loop in useCallback dependencies
  const { setLoading, setError, setData } = followersState
  const [actionInProgress, setActionInProgress] = useState<Set<string>>(new Set())
  const [targetUserName, setTargetUserName] = useState<string | null>(null)

  // Get target user ID from URL params (if viewing another user's followers list)
  const targetUserId = searchParams.get('id')
  const isOwnProfile = !targetUserId || targetUserId === user?.identityId

  // Load followers list
  const loadFollowers = useCallback(async (forceRefresh: boolean = false) => {
    setLoading(true)
    setError(null)

    try {
      // Determine whose followers list to load
      const userIdToLoad = targetUserId || user?.identityId

      if (!userIdToLoad) {
        setData([])
        setLoading(false)
        return
      }

      console.log('Followers: Loading followers list for:', userIdToLoad)

      // If viewing another user, fetch their username for the header
      if (targetUserId && targetUserId !== user?.identityId) {
        try {
          const username = await dpnsService.resolveUsername(targetUserId)
          setTargetUserName(username || `User ${targetUserId.slice(-6)}`)
        } catch (error) {
          console.error('Failed to resolve target user name:', error)
          setTargetUserName(`User ${targetUserId.slice(-6)}`)
        }
      }

      const cacheKey = `followers_${userIdToLoad}`

      // Check cache first unless force refresh
      if (!forceRefresh) {
        const cached = cacheManager.get<Follower[]>('followers', cacheKey)
        if (cached) {
          console.log('Followers: Using cached data')
          setData(cached)
          setLoading(false)
          return
        }
      }

      // Use followService to get followers list
      const follows = await followService.getFollowers(userIdToLoad)
      
      console.log('Followers: Raw follows from platform:', follows)

      // Get unique identity IDs from followers
      const identityIds = follows
        .map(f => f.$ownerId)
        .filter(Boolean)
      
      if (identityIds.length === 0) {
        setData([])
        setLoading(false)
        return
      }
      
      // Batch fetch DPNS names, all usernames, and profiles
      const [dpnsNames, allUsernamesData, profiles, followerCounts, followingCounts] = await Promise.all([
        // Fetch best DPNS names for all identities
        Promise.all(identityIds.map(async (id) => {
          try {
            const username = await dpnsService.resolveUsername(id)
            return { id, username }
          } catch (error) {
            console.error(`Failed to resolve DPNS for ${id}:`, error)
            return { id, username: null }
          }
        })),
        // Fetch all usernames for each identity (sorted consistently)
        Promise.all(identityIds.map(async (id) => {
          try {
            const usernames = await dpnsService.getAllUsernames(id)
            if (usernames.length > 1) {
              // Sort usernames: contested first, then shortest, then alphabetically
              const sortedUsernames = await dpnsService.sortUsernamesByContested(usernames)
              return { id, usernames: sortedUsernames }
            }
            return { id, usernames }
          } catch (error) {
            console.error(`Failed to get all usernames for ${id}:`, error)
            return { id, usernames: [] }
          }
        })),
        // Fetch Yappr profiles
        unifiedProfileService.getProfilesByIdentityIds(identityIds),
        // Fetch follower counts for all users
        Promise.all(identityIds.map(async (id) => {
          try {
            const count = await followService.countFollowers(id)
            return { id, count }
          } catch (error) {
            console.error(`Failed to get follower count for ${id}:`, error)
            return { id, count: 0 }
          }
        })),
        // Fetch following counts for all users
        Promise.all(identityIds.map(async (id) => {
          try {
            const count = await followService.countFollowing(id)
            return { id, count }
          } catch (error) {
            console.error(`Failed to get following count for ${id}:`, error)
            return { id, count: 0 }
          }
        }))
      ])
      
      // Check if we follow them back (only relevant when viewing own followers)
      let followingBackMap = new Map<string, boolean>()
      if (isOwnProfile && user?.identityId) {
        const followingBack = await Promise.all(
          identityIds.map(id => followService.isFollowing(id, user.identityId))
        )
        followingBackMap = new Map(identityIds.map((id, index) => [id, followingBack[index]]))
      }
      
      // Create maps for easy lookup
      const dpnsMap = new Map(dpnsNames.map(item => [item.id, item.username]))
      const allUsernamesMap = new Map(allUsernamesData.map(item => [item.id, item.usernames]))
      const profileMap = new Map(profiles.map(p => [p.$ownerId, p]))
      const followerCountMap = new Map(followerCounts.map(item => [item.id, item.count]))
      const followingCountMap = new Map(followingCounts.map(item => [item.id, item.count]))

      // Create enriched user data
      const followers = follows.map(follow => {
        const followerId = follow.$ownerId
        if (!followerId) {
          console.warn('Follow document missing ownerId:', follow)
          return null
        }

        const username = dpnsMap.get(followerId)
        const allUsernames = allUsernamesMap.get(followerId) || []
        const profile = profileMap.get(followerId)

        return {
          id: followerId,
          username: username || followerId.slice(-8),
          displayName: profile?.displayName || username || `User ${followerId.slice(-8)}`,
          bio: profile?.bio || (profile ? 'Yappr user' : 'Not yet on Yappr'),
          hasProfile: !!profile,
          hasDpnsName: !!username,
          followersCount: followerCountMap.get(followerId) || 0,
          followingCount: followingCountMap.get(followerId) || 0,
          isFollowingBack: followingBackMap.get(followerId) || false,
          allUsernames: allUsernames
        }
      }).filter(Boolean) as Follower[] // Remove any null entries

      // Cache the results
      cacheManager.set('followers', cacheKey, followers)

      setData(followers)
      console.log(`Followers: Successfully loaded ${followers.length} followers`)

    } catch (error) {
      console.error('Followers: Failed to load followers list:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }, [setLoading, setError, setData, isOwnProfile, user?.identityId, targetUserId])

  useEffect(() => {
    // Load when we have a user (for own profile) or a targetUserId (for viewing others)
    if (user || targetUserId) {
      loadFollowers().catch(err => console.error('Failed to load followers:', err))
    }
  }, [loadFollowers, user, targetUserId])

  const handleFollow = async (userId: string) => {
    const authedUser = requireAuth('follow')
    if (!authedUser) return

    setActionInProgress(prev => new Set(prev).add(userId))

    try {
      console.log('Following user:', userId)
      const result = await followService.followUser(authedUser.identityId, userId)

      if (result.success) {
        // Update local state - mark as following back
        followersState.setData((prev: Follower[] | null) =>
          (prev || []).map(f => f.id === userId ? { ...f, isFollowingBack: true } : f)
        )
        // Invalidate following cache since we added a new follow
        cacheManager.delete('following', `following_${authedUser.identityId}`)
        toast.success('Following!')
      } else {
        console.error('Failed to follow user:', result.error)
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
      console.log('Unfollowing user:', userId)
      const result = await followService.unfollowUser(authedUser.identityId, userId)

      if (result.success) {
        // Update local state - mark as not following back
        followersState.setData((prev: Follower[] | null) =>
          (prev || []).map(f => f.id === userId ? { ...f, isFollowingBack: false } : f)
        )
        // Invalidate following cache
        cacheManager.delete('following', `following_${authedUser.identityId}`)
        toast.success('Unfollowed')
      } else {
        console.error('Failed to unfollow user:', result.error)
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

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {!isOwnProfile && (
                    <button
                      onClick={() => router.back()}
                      className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                    >
                      <ArrowLeftIcon className="h-5 w-5" />
                    </button>
                  )}
                  <div>
                    <h1 className="text-xl font-bold">
                      {isOwnProfile ? 'Followers' : `@${targetUserName || 'User'}'s Followers`}
                    </h1>
                    <p className="text-sm text-gray-500 mt-1">
                      {followersState.loading ?
                        'Loading...' :
                        `${followersState.data?.length || 0} ${followersState.data?.length === 1 ? 'follower' : 'followers'}`
                      }
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadFollowers(true)}
                  disabled={followersState.loading}
                >
                  <ArrowPathIcon className={`h-4 w-4 ${followersState.loading ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>
          </header>

          <ErrorBoundary level="component">
            <LoadingState
              loading={followersState.loading || followersState.data === null}
              error={followersState.error}
              isEmpty={!followersState.loading && followersState.data !== null && followersState.data.length === 0}
              onRetry={loadFollowers}
              loadingText="Loading followers..."
              emptyText="No followers yet"
              emptyDescription="Share interesting content to gain followers"
            >
              <div>
                {followersState.data?.map((follower) => (
                  <motion.div
                    key={follower.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="border-b border-gray-200 dark:border-gray-800 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <ProfileHoverCard
                        userId={follower.id}
                        username={follower.hasDpnsName ? follower.username : null}
                        displayName={follower.displayName}
                      >
                        <button
                          onClick={() => router.push(`/user?id=${follower.id}`)}
                          className="h-12 w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 cursor-pointer hover:opacity-80 transition-opacity"
                        >
                          <UserAvatar userId={follower.id} size="lg" alt={follower.displayName} />
                        </button>
                      </ProfileHoverCard>

                      <div className="flex-1">
                        <div className="flex items-start justify-between">
                          <div>
                            <ProfileHoverCard
                              userId={follower.id}
                              username={follower.hasDpnsName ? follower.username : null}
                              displayName={follower.displayName}
                            >
                              <h3
                                onClick={() => router.push(`/user?id=${follower.id}`)}
                                className="font-semibold hover:underline cursor-pointer"
                              >
                                {follower.displayName}
                              </h3>
                            </ProfileHoverCard>
                            {follower.hasDpnsName ? (
                              <ProfileHoverCard
                                userId={follower.id}
                                username={follower.username}
                                displayName={follower.displayName}
                              >
                                <p
                                  onClick={() => router.push(`/user?id=${follower.id}`)}
                                  className="text-sm text-gray-500 hover:underline cursor-pointer"
                                >
                                  @{follower.username}
                                </p>
                              </ProfileHoverCard>
                            ) : (
                              <Tooltip.Provider>
                                <Tooltip.Root>
                                  <Tooltip.Trigger asChild>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        navigator.clipboard.writeText(follower.id).catch(console.error)
                                        toast.success('Identity ID copied')
                                      }}
                                      className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-mono"
                                    >
                                      {follower.id.slice(0, 8)}...{follower.id.slice(-6)}
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
                            )}
                            {follower.allUsernames && follower.allUsernames.length > 1 && (
                              <AlsoKnownAs 
                                primaryUsername={follower.username} 
                                allUsernames={follower.allUsernames}
                                identityId={follower.id}
                              />
                            )}
                            {follower.bio && (
                              <p className="text-sm mt-1">{follower.bio}</p>
                            )}
                            <div className="flex gap-4 mt-2 text-sm text-gray-500">
                              <button
                                onClick={() => router.push(`/followers?id=${follower.id}`)}
                                className="hover:underline"
                              >
                                <strong className="text-gray-900 dark:text-gray-100">
                                  {formatNumber(follower.followersCount)}
                                </strong> followers
                              </button>
                              <button
                                onClick={() => router.push(`/following?id=${follower.id}`)}
                                className="hover:underline"
                              >
                                <strong className="text-gray-900 dark:text-gray-100">
                                  {formatNumber(follower.followingCount)}
                                </strong> following
                              </button>
                            </div>
                          </div>

                          {/* Only show action buttons when viewing own followers list */}
                          {isOwnProfile && (
                            follower.isFollowingBack ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleUnfollow(follower.id)}
                                className="ml-4"
                                disabled={actionInProgress.has(follower.id)}
                              >
                                {actionInProgress.has(follower.id) ? (
                                  <Spinner size="sm" className="border-gray-600" />
                                ) : (
                                  'Following'
                                )}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                onClick={() => handleFollow(follower.id)}
                                className="ml-4"
                                disabled={actionInProgress.has(follower.id)}
                              >
                                {actionInProgress.has(follower.id) ? (
                                  <Spinner size="sm" className="border-white" />
                                ) : (
                                  'Follow back'
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

export default withAuth(FollowersPage)