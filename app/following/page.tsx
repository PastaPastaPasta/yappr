'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { MagnifyingGlassIcon, XMarkIcon, ArrowPathIcon, ArrowLeftIcon } from '@heroicons/react/24/outline'
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
import toast from 'react-hot-toast'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import * as RadixTooltip from '@radix-ui/react-tooltip'
import { WasmSdk } from '@dashevo/wasm-sdk'

// Helper wrapper for DPNS utility function with error handling
const dpns_convert_to_homograph_safe = (input: string): string => {
  try {
    return WasmSdk.dpnsConvertToHomographSafe(input)
  } catch (e) {
    // SDK may not be initialized yet, return original input as fallback
    console.warn('WASM SDK not initialized for homograph conversion, using original input')
    return input
  }
}
import { AlsoKnownAs } from '@/components/ui/also-known-as'
import { ProfileHoverCard } from '@/components/profile/profile-hover-card'
import { useSettingsStore } from '@/lib/store'

interface FollowingUser {
  id: string
  username: string
  displayName: string
  bio?: string
  hasProfile?: boolean
  hasDpnsName: boolean
  followersCount: number
  followingCount: number
  isFollowing: boolean
  allUsernames?: string[]
}

function FollowingPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const followingState = useAsyncState<FollowingUser[]>(null)
  // Extract stable setter functions to avoid infinite loop in useCallback dependencies
  const { setLoading, setError, setData } = followingState
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FollowingUser[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [followingInProgress, setFollowingInProgress] = useState<Set<string>>(new Set())
  const [targetUserName, setTargetUserName] = useState<string | null>(null)

  // Get target user ID from URL params (if viewing another user's following list)
  const targetUserId = searchParams.get('id')
  const isOwnProfile = !targetUserId || targetUserId === user?.identityId

  // Load following list
  const loadFollowing = useCallback(async (forceRefresh: boolean = false) => {
    setLoading(true)
    setError(null)

    try {
      // Determine whose following list to load
      const userIdToLoad = targetUserId || user?.identityId

      if (!userIdToLoad) {
        setData([])
        setLoading(false)
        return
      }

      console.log('Following: Loading following list for:', userIdToLoad)

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

      const cacheKey = `following_${userIdToLoad}`

      // Check cache first unless force refresh
      if (!forceRefresh) {
        const cached = cacheManager.get<FollowingUser[]>('following', cacheKey)
        if (cached) {
          console.log('Following: Using cached data')
          setData(cached)
          setLoading(false)
          return
        }
      }

      // Use followService to get following list
      const follows = await followService.getFollowing(userIdToLoad)
      
      console.log('Following: Raw follows from platform:', follows)

      // Get unique identity IDs from follows
      const identityIds = follows
        .map(f => f.followingId)
        .filter(Boolean)
      
      if (identityIds.length === 0) {
        setData([])
        setLoading(false)
        return
      }
      
      // Batch fetch all usernames, best usernames, profiles, and follower/following counts
      const [allUsernamesData, bestUsernamesMap, profiles, followerCounts, followingCounts] = await Promise.all([
        // Fetch all usernames for each identity (for "Also known as" feature), sorted consistently
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
        // Batch resolve best usernames efficiently (returns contested names first)
        dpnsService.resolveUsernamesBatch(identityIds),
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

      // Convert best usernames map to the expected format
      const dpnsNames = identityIds.map(id => ({
        id,
        username: bestUsernamesMap.get(id) || null
      }))

      // Create maps for easy lookup
      const dpnsMap = new Map(dpnsNames.map(item => [item.id, item.username]))
      const allUsernamesMap = new Map(allUsernamesData.map(item => [item.id, item.usernames]))
      const profileMap = new Map(profiles.map(p => [p.$ownerId || (p as any).ownerId, p]))
      const followerCountMap = new Map(followerCounts.map(item => [item.id, item.count]))
      const followingCountMap = new Map(followingCounts.map(item => [item.id, item.count]))
      
      // Create enriched user data
      const followingUsers = follows.map((follow: any) => {
        const followingId = follow.followingId
        if (!followingId) {
          console.warn('Follow document missing followingId:', follow)
          return null
        }
        
        const username = dpnsMap.get(followingId)
        const allUsernames = allUsernamesMap.get(followingId) || []
        const profile = profileMap.get(followingId)
        // Handle both formats: direct properties or nested in data
        const profileData = (profile as any)?.data || profile

        return {
          id: followingId,
          username: username || followingId.slice(-8),
          displayName: profileData?.displayName || username || `User ${followingId.slice(-8)}`,
          bio: profileData?.bio || (profile ? 'Yappr user' : 'Not yet on Yappr'),
          hasProfile: !!profile,
          hasDpnsName: !!username,
          followersCount: followerCountMap.get(followingId) || 0,
          followingCount: followingCountMap.get(followingId) || 0,
          isFollowing: true,
          allUsernames: allUsernames
        }
      }).filter(Boolean) as FollowingUser[] // Remove any null entries

      // Cache the results
      cacheManager.set('following', cacheKey, followingUsers)

      setData(followingUsers)
      console.log(`Following: Successfully loaded ${followingUsers.length} following`)

    } catch (error) {
      console.error('Following: Failed to load following list:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }, [setLoading, setError, setData, user?.identityId, targetUserId])

  useEffect(() => {
    // Load when we have a user (for own profile) or a targetUserId (for viewing others)
    if (user || targetUserId) {
      loadFollowing().catch(err => console.error('Failed to load following:', err))
    }
  }, [loadFollowing, user, targetUserId])

  const handleUnfollow = async (userId: string) => {
    const authedUser = requireAuth('follow')
    if (!authedUser) return

    // Add to in-progress set for UI feedback
    setFollowingInProgress(prev => new Set(prev).add(userId))

    try {
      console.log('Unfollowing user:', userId)

      const result = await followService.unfollowUser(authedUser.identityId, userId)

      if (result.success) {
        // Update local state to remove from following list
        followingState.setData((prev: FollowingUser[] | null) =>
          (prev || []).filter(u => u.id !== userId)
        )
        // Also update search results if present
        setSearchResults(prev =>
          prev.map(u => u.id === userId ? { ...u, isFollowing: false } : u)
        )
        // Invalidate cache
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
      setFollowingInProgress(prev => {
        const newSet = new Set(prev)
        newSet.delete(userId)
        return newSet
      })
    }
  }

  const handleFollow = async (userId: string) => {
    const authedUser = requireAuth('follow')
    if (!authedUser) return

    // Add to in-progress set
    setFollowingInProgress(prev => new Set(prev).add(userId))

    try {
      console.log('Following user:', userId)

      // Create follow document
      const result = await followService.followUser(authedUser.identityId, userId)
      
      if (result.success) {
        // Update the search results to reflect the new follow status
        setSearchResults(prev => 
          prev.map(u => u.id === userId ? { ...u, isFollowing: true } : u)
        )
        
        // Force refresh the following list to show the new follow
        await loadFollowing(true)
      } else {
        console.error('Failed to follow user:', result.error)
        // You could show an error toast here
      }
    } catch (error) {
      console.error('Error following user:', error)
    } finally {
      // Remove from in-progress set
      setFollowingInProgress(prev => {
        const newSet = new Set(prev)
        newSet.delete(userId)
        return newSet
      })
    }
  }

  // Search for DPNS users
  const searchUsers = useCallback(async () => {
    const trimmedQuery = searchQuery.trim()
    if (!trimmedQuery) {
      setSearchResults([])
      setSearchError(null)
      return
    }

    // Require at least 3 characters to search (like DashPay)
    if (trimmedQuery.length < 3) {
      setSearchResults([])
      setSearchError(null)
      return
    }

    setIsSearching(true)
    setSearchError(null)

    try {
      // Convert search query to homograph-safe characters
      const homographSafeQuery = dpns_convert_to_homograph_safe(searchQuery.trim())
      console.log('Searching for DPNS names starting with:', searchQuery, '-> homograph-safe:', homographSafeQuery)
      
      // Search for usernames with details
      const searchResults = await dpnsService.searchUsernamesWithDetails(homographSafeQuery, 20)
      
      if (searchResults.length > 0) {
        console.log('Found DPNS search results:', searchResults)
        
        // Get all unique identity IDs from search results
        const uniqueIdentityIds = Array.from(new Set(searchResults.map(r => r.ownerId).filter(id => id)))
        
        // Query Yappr profiles and follower/following counts for all these identities
        let profiles: any[] = []
        let followerCounts: { id: string; count: number }[] = []
        let followingCounts: { id: string; count: number }[] = []
        if (uniqueIdentityIds.length > 0) {
          try {
            const { unifiedProfileService } = await import('@/lib/services')
            // Query profiles and counts in parallel
            const [profilesResult, followerCountsResult, followingCountsResult] = await Promise.all([
              unifiedProfileService.getProfilesByIdentityIds(uniqueIdentityIds),
              Promise.all(uniqueIdentityIds.map(async (id) => {
                try {
                  const count = await followService.countFollowers(id)
                  return { id, count }
                } catch (error) {
                  return { id, count: 0 }
                }
              })),
              Promise.all(uniqueIdentityIds.map(async (id) => {
                try {
                  const count = await followService.countFollowing(id)
                  return { id, count }
                } catch (error) {
                  return { id, count: 0 }
                }
              }))
            ])
            profiles = profilesResult
            followerCounts = followerCountsResult
            followingCounts = followingCountsResult
            console.log('Found Yappr profiles:', profiles)
          } catch (error) {
            console.error('Error fetching profiles:', error)
          }
        }

        // Create maps for easy lookup
        const profileMap = new Map(profiles.map(p => [p.$ownerId || (p as any).ownerId, p]))
        const followerCountMap = new Map(followerCounts.map(item => [item.id, item.count]))
        const followingCountMap = new Map(followingCounts.map(item => [item.id, item.count]))
        
        // Group DPNS names by owner to handle multiple names per owner
        const ownerToNames = new Map<string, string[]>()
        searchResults.forEach(result => {
          const names = ownerToNames.get(result.ownerId) || []
          names.push(result.username)
          ownerToNames.set(result.ownerId, names)
        })
        
        // Create user objects - one per unique owner
        const searchUsers: FollowingUser[] = await Promise.all(
          Array.from(ownerToNames.entries()).map(async ([ownerId, names]) => {
            const profile = profileMap.get(ownerId)
            // Handle both formats: direct properties or nested in data
            const profileData = (profile as any)?.data || profile
            // Sort names with contested ones first
            const sortedNames = await dpnsService.sortUsernamesByContested(names)
            const primaryUsername = sortedNames[0]

            return {
              id: ownerId,
              username: primaryUsername,
              displayName: profileData?.displayName || primaryUsername,
              bio: profileData?.bio || (profile ? 'Yappr user' : 'Not yet on Yappr'),
              hasProfile: !!profile,
              hasDpnsName: true, // Search results are always from DPNS
              followersCount: followerCountMap.get(ownerId) || 0,
              followingCount: followingCountMap.get(ownerId) || 0,
              isFollowing: followingState.data?.some(u => u.id === ownerId) || false,
              allUsernames: sortedNames
            }
          })
        )
        
        setSearchResults(searchUsers)
      } else {
        setSearchResults([])
        setSearchError('No users found with that name')
      }
    } catch (error) {
      console.error('Search error:', error)
      setSearchError('Failed to search for user')
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }, [searchQuery, followingState.data])

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery) {
        searchUsers().catch(err => console.error('Failed to search users:', err))
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [searchQuery, searchUsers])

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
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
                      {isOwnProfile ? 'Following' : `@${targetUserName || 'User'}'s Following`}
                    </h1>
                    <p className="text-sm text-gray-500 mt-1">
                      {searchQuery ?
                        `${searchResults.length} search result${searchResults.length === 1 ? '' : 's'}` :
                        followingState.loading ?
                          'Loading...' :
                          `${followingState.data?.length || 0} ${followingState.data?.length === 1 ? 'user' : 'users'}`
                      }
                    </p>
                  </div>
                </div>
                {!searchQuery && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => loadFollowing(true)}
                    disabled={followingState.loading}
                  >
                    <ArrowPathIcon className={`h-4 w-4 ${followingState.loading ? 'animate-spin' : ''}`} />
                  </Button>
                )}
              </div>
            </div>

            {/* Only show search bar when viewing own following list */}
            {isOwnProfile && (
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                <div className="relative">
                  <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500" />
                  <Input
                    type="text"
                    placeholder="Search for people to follow"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 pr-10"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => {
                        setSearchQuery('')
                        setSearchResults([])
                        setSearchError(null)
                      }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                    >
                      <XMarkIcon className="h-4 w-4 text-gray-500" />
                    </button>
                  )}
                </div>
                {searchError && (
                  <p className="text-sm text-red-500 mt-2">{searchError}</p>
                )}
              </div>
            )}
          </header>

          <ErrorBoundary level="component">
            {/* Show search results when searching */}
            {searchQuery ? (
              <div>
                {isSearching ? (
                  <div className="p-8 text-center">
                    <Spinner size="md" className="mx-auto mb-4" />
                    <p className="text-gray-500">Searching for DPNS users...</p>
                  </div>
                ) : searchResults.length > 0 ? (
                  <div>
                    <div className="px-4 py-2 bg-gray-50 dark:bg-gray-950 text-sm text-gray-500">
                      Search Results
                    </div>
                    {searchResults.map((searchUser) => (
                      <motion.div
                        key={searchUser.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="border-b border-gray-200 dark:border-gray-800 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors"
                      >
                        <div className="flex items-start gap-3">
                          <ProfileHoverCard
                            userId={searchUser.id}
                            username={searchUser.username}
                            displayName={searchUser.displayName}
                          >
                            <button
                              onClick={() => router.push(`/user?id=${searchUser.id}`)}
                              className="h-12 w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 cursor-pointer hover:opacity-80 transition-opacity"
                            >
                              <UserAvatar userId={searchUser.id} size="lg" alt={searchUser.displayName} />
                            </button>
                          </ProfileHoverCard>

                          <div className="flex-1">
                            <div className="flex items-start justify-between">
                              <div>
                                <ProfileHoverCard
                                  userId={searchUser.id}
                                  username={searchUser.username}
                                  displayName={searchUser.displayName}
                                >
                                  <h3
                                    onClick={() => router.push(`/user?id=${searchUser.id}`)}
                                    className="font-semibold hover:underline cursor-pointer"
                                  >
                                    {searchUser.displayName}
                                  </h3>
                                </ProfileHoverCard>
                                <ProfileHoverCard
                                  userId={searchUser.id}
                                  username={searchUser.username}
                                  displayName={searchUser.displayName}
                                >
                                  <p
                                    onClick={() => router.push(`/user?id=${searchUser.id}`)}
                                    className="text-sm text-gray-500 hover:underline cursor-pointer"
                                  >
                                    @{searchUser.username}
                                  </p>
                                </ProfileHoverCard>
                                {searchUser.allUsernames && searchUser.allUsernames.length > 1 && (
                                  <AlsoKnownAs
                                    primaryUsername={searchUser.username}
                                    allUsernames={searchUser.allUsernames}
                                    identityId={searchUser.id}
                                  />
                                )}
                                {/* Only show bio if it's an actual bio, not fallback text */}
                                {searchUser.bio && searchUser.bio !== 'Yappr user' && searchUser.bio !== 'Not yet on Yappr' && (
                                  <p className="text-sm mt-1">{searchUser.bio}</p>
                                )}
                              </div>

                              <div className="flex flex-col items-end gap-1">
                                {searchUser.isFollowing ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleUnfollow(searchUser.id)}
                                    disabled={followingInProgress.has(searchUser.id)}
                                  >
                                    {followingInProgress.has(searchUser.id) ? (
                                      <Spinner size="sm" className="border-gray-600" />
                                    ) : (
                                      'Following'
                                    )}
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    onClick={() => handleFollow(searchUser.id)}
                                    disabled={followingInProgress.has(searchUser.id)}
                                  >
                                    {followingInProgress.has(searchUser.id) ? (
                                      <Spinner size="sm" className="border-white" />
                                    ) : (
                                      'Follow'
                                    )}
                                  </Button>
                                )}
                                {!searchUser.hasProfile && (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="text-xs text-gray-400 cursor-help">Not on Yappr yet</span>
                                      </TooltipTrigger>
                                      <TooltipContent side="bottom" className="max-w-xs">
                                        <p>This user hasn&apos;t created a Yappr profile yet, but you can still follow them. They&apos;ll see your follow when they join!</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                ) : searchError ? (
                  <div className="p-8 text-center">
                    <p className="text-gray-500">{searchError}</p>
                  </div>
                ) : null}
              </div>
            ) : (
              /* Show following list when not searching */
              <LoadingState
                loading={followingState.loading || followingState.data === null}
                error={followingState.error}
                isEmpty={!followingState.loading && followingState.data !== null && followingState.data.length === 0}
                onRetry={loadFollowing}
                loadingText="Loading following list..."
                emptyText="Not following anyone yet"
                emptyDescription="Find interesting people to follow on Yappr"
              >
                <div>
                  {followingState.data?.map((followingUser) => (
                  <motion.div
                    key={followingUser.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="border-b border-gray-200 dark:border-gray-800 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <ProfileHoverCard
                        userId={followingUser.id}
                        username={followingUser.hasDpnsName ? followingUser.username : null}
                        displayName={followingUser.displayName}
                      >
                        <button
                          onClick={() => router.push(`/user?id=${followingUser.id}`)}
                          className="h-12 w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 cursor-pointer hover:opacity-80 transition-opacity"
                        >
                          <UserAvatar userId={followingUser.id} size="lg" alt={followingUser.displayName} />
                        </button>
                      </ProfileHoverCard>

                      <div className="flex-1">
                        <div className="flex items-start justify-between">
                          <div>
                            <ProfileHoverCard
                              userId={followingUser.id}
                              username={followingUser.hasDpnsName ? followingUser.username : null}
                              displayName={followingUser.displayName}
                            >
                              <h3
                                onClick={() => router.push(`/user?id=${followingUser.id}`)}
                                className="font-semibold hover:underline cursor-pointer"
                              >
                                {followingUser.displayName}
                              </h3>
                            </ProfileHoverCard>
                            {followingUser.hasDpnsName ? (
                              <ProfileHoverCard
                                userId={followingUser.id}
                                username={followingUser.username}
                                displayName={followingUser.displayName}
                              >
                                <p
                                  onClick={() => router.push(`/user?id=${followingUser.id}`)}
                                  className="text-sm text-gray-500 hover:underline cursor-pointer"
                                >
                                  @{followingUser.username}
                                </p>
                              </ProfileHoverCard>
                            ) : (
                              <RadixTooltip.Provider>
                                <RadixTooltip.Root>
                                  <RadixTooltip.Trigger asChild>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        navigator.clipboard.writeText(followingUser.id).catch(console.error)
                                        toast.success('Identity ID copied')
                                      }}
                                      className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-mono"
                                    >
                                      {followingUser.id.slice(0, 8)}...{followingUser.id.slice(-6)}
                                    </button>
                                  </RadixTooltip.Trigger>
                                  <RadixTooltip.Portal>
                                    <RadixTooltip.Content
                                      className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                                      sideOffset={5}
                                    >
                                      Click to copy full identity ID
                                    </RadixTooltip.Content>
                                  </RadixTooltip.Portal>
                                </RadixTooltip.Root>
                              </RadixTooltip.Provider>
                            )}
                            {followingUser.allUsernames && followingUser.allUsernames.length > 1 && (
                              <AlsoKnownAs
                                primaryUsername={followingUser.username}
                                allUsernames={followingUser.allUsernames}
                                identityId={followingUser.id}
                              />
                            )}
                            {/* Only show bio if it's an actual bio, not fallback text */}
                            {followingUser.bio && followingUser.bio !== 'Yappr user' && followingUser.bio !== 'Not yet on Yappr' && (
                              <p className="text-sm mt-1">{followingUser.bio}</p>
                            )}
                            <div className="flex gap-4 mt-2 text-sm text-gray-500">
                              <button
                                onClick={() => router.push(`/followers?id=${followingUser.id}`)}
                                className="hover:underline"
                              >
                                <strong className="text-gray-900 dark:text-gray-100">
                                  {formatNumber(followingUser.followersCount)}
                                </strong> followers
                              </button>
                              <button
                                onClick={() => router.push(`/following?id=${followingUser.id}`)}
                                className="hover:underline"
                              >
                                <strong className="text-gray-900 dark:text-gray-100">
                                  {formatNumber(followingUser.followingCount)}
                                </strong> following
                              </button>
                            </div>
                          </div>

                          {/* Only show action buttons when viewing own following list */}
                          {isOwnProfile && (
                            <div className="flex flex-col items-end gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleUnfollow(followingUser.id)}
                                disabled={followingInProgress.has(followingUser.id)}
                              >
                                {followingInProgress.has(followingUser.id) ? (
                                  <Spinner size="sm" className="border-gray-600" />
                                ) : (
                                  'Following'
                                )}
                              </Button>
                              {!followingUser.hasProfile && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="text-xs text-gray-400 cursor-help">Not on Yappr yet</span>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom" className="max-w-xs">
                                      <p>This user hasn&apos;t created a Yappr profile yet, but you&apos;re following them. They&apos;ll see your follow when they join!</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
                </div>
              </LoadingState>
            )}
          </ErrorBoundary>
        </main>
      </div>

      <RightSidebar />
    </div>
  )
}

export default withAuth(FollowingPage)