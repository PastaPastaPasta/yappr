'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { MagnifyingGlassIcon, XMarkIcon, InformationCircleIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { LoadingState, useAsyncState } from '@/components/ui/loading-state'
import ErrorBoundary from '@/components/error-boundary'
import { followService, dpnsService, profileService } from '@/lib/services'
import { cacheManager } from '@/lib/cache-manager'
import { AvatarCanvas } from '@/components/ui/avatar-canvas'
import { generateAvatarV2 } from '@/lib/avatar-generator-v2'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WasmSdk } from '@dashevo/wasm-sdk'

// Helper wrapper for DPNS utility function
const dpns_convert_to_homograph_safe = (input: string): string => WasmSdk.dpnsConvertToHomographSafe(input);
import { AlsoKnownAs } from '@/components/ui/also-known-as'

interface FollowingUser {
  id: string
  username: string
  displayName: string
  bio?: string
  hasProfile?: boolean
  followersCount: number
  followingCount: number
  isFollowing: boolean
  allUsernames?: string[]
}

function FollowingPage() {
  const { user } = useAuth()
  const followingState = useAsyncState<FollowingUser[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FollowingUser[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [followingInProgress, setFollowingInProgress] = useState<Set<string>>(new Set())

  // Load following list
  const loadFollowing = useCallback(async (forceRefresh: boolean = false) => {
    const { setLoading, setError, setData } = followingState

    setLoading(true)
    setError(null)

    try {
      console.log('Following: Loading following list...')
      
      if (!user?.identityId) {
        setData([])
        setLoading(false)
        return
      }

      const cacheKey = `following_${user.identityId}`
      
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
      const follows = await followService.getFollowing(user.identityId, { limit: 50 })
      
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
      
      // Batch fetch all usernames and profiles (single DPNS query per user, not two)
      const [allUsernamesData, profiles] = await Promise.all([
        // Fetch all usernames for each identity
        Promise.all(identityIds.map(async (id) => {
          try {
            const usernames = await dpnsService.getAllUsernames(id)
            return { id, usernames }
          } catch (error) {
            console.error(`Failed to get all usernames for ${id}:`, error)
            return { id, usernames: [] }
          }
        })),
        // Fetch Yappr profiles
        profileService.getProfilesByIdentityIds(identityIds)
      ])

      // Derive best username from all usernames (avoids duplicate DPNS query)
      const dpnsNames = await Promise.all(allUsernamesData.map(async ({ id, usernames }) => {
        if (usernames.length === 0) return { id, username: null }
        const sorted = await dpnsService.sortUsernamesByContested(usernames)
        return { id, username: sorted[0] || null }
      }))

      // Create maps for easy lookup
      const dpnsMap = new Map(dpnsNames.map(item => [item.id, item.username]))
      const allUsernamesMap = new Map(allUsernamesData.map(item => [item.id, item.usernames]))
      const profileMap = new Map(profiles.map(p => [p.$ownerId || (p as any).ownerId, p]))
      
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
        
        return {
          id: followingId,
          username: username || `user_${followingId.slice(-6)}`,
          displayName: profile?.displayName || username || `User ${followingId.slice(-6)}`,
          bio: profile?.bio || (profile ? 'Yappr user' : 'Not yet on Yappr'),
          hasProfile: !!profile,
          followersCount: 0, // Would need to query this
          followingCount: 0, // Would need to query this
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
  }, [followingState.setLoading, followingState.setError, followingState.setData, user?.identityId])

  useEffect(() => {
    if (user) {
      loadFollowing()
    }
  }, [loadFollowing, user])

  const handleUnfollow = async (userId: string) => {
    console.log('Unfollowing user:', userId)
    // TODO: Implement unfollow functionality
  }

  const handleFollow = async (userId: string) => {
    if (!user?.identityId) return

    // Add to in-progress set
    setFollowingInProgress(prev => new Set(prev).add(userId))

    try {
      console.log('Following user:', userId)
      
      // Create follow document
      const result = await followService.followUser(user.identityId, userId)
      
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
    if (!searchQuery.trim()) {
      setSearchResults([])
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
        
        // Query Yappr profiles for all these identities
        let profiles: any[] = []
        if (uniqueIdentityIds.length > 0) {
          try {
            const { profileService } = await import('@/lib/services')
            // Query profiles where $ownerId is in the array of unique identity IDs
            profiles = await profileService.getProfilesByIdentityIds(uniqueIdentityIds)
            console.log('Found Yappr profiles:', profiles)
          } catch (error) {
            console.error('Error fetching profiles:', error)
          }
        }
        
        // Create a map of identity ID to profile for easy lookup
        const profileMap = new Map(profiles.map(p => [p.$ownerId || (p as any).ownerId, p]))
        
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
            // Sort names with contested ones first
            const sortedNames = await dpnsService.sortUsernamesByContested(names)
            const primaryUsername = sortedNames[0]

            return {
              id: ownerId,
              username: primaryUsername,
              displayName: profile?.displayName || primaryUsername,
              bio: profile?.bio || 'Not yet on Yappr',
              hasProfile: !!profile,
              followersCount: 0, // Would need to query this
              followingCount: 0, // Would need to query this
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
        searchUsers()
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [searchQuery, searchUsers])

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      
      <main className="flex-1 min-w-0 md:max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-black/80 backdrop-blur-xl">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold">Following</h1>
                  <p className="text-sm text-gray-500 mt-1">
                    {searchQuery ? 
                      `${searchResults.length} search result${searchResults.length === 1 ? '' : 's'}` :
                      followingState.loading ? 
                        'Loading...' :
                        `${followingState.data?.length || 0} ${followingState.data?.length === 1 ? 'user' : 'users'}`
                    }
                  </p>
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
          </header>

          <ErrorBoundary level="component">
            {/* Show search results when searching */}
            {searchQuery ? (
              <div>
                {isSearching ? (
                  <div className="p-8 text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
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
                          <div className="h-12 w-12 rounded-full overflow-hidden bg-gray-100">
                            <AvatarCanvas features={generateAvatarV2(searchUser.id)} size={48} />
                          </div>
                          
                          <div className="flex-1">
                            <div className="flex items-start justify-between">
                              <div>
                                <h3 className="font-semibold hover:underline cursor-pointer">
                                  {searchUser.displayName}
                                </h3>
                                <p className="text-sm text-gray-500">@{searchUser.username}</p>
                                {searchUser.allUsernames && searchUser.allUsernames.length > 1 && (
                                  <AlsoKnownAs 
                                    primaryUsername={searchUser.username} 
                                    allUsernames={searchUser.allUsernames}
                                    identityId={searchUser.id}
                                  />
                                )}
                                {searchUser.bio && (
                                  <div className="flex items-start gap-1 mt-1">
                                    <p className="text-sm flex-1">{searchUser.bio}</p>
                                    {!searchUser.hasProfile && (
                                      <TooltipProvider>
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <InformationCircleIcon className="h-4 w-4 text-gray-400 cursor-help flex-shrink-0 mt-0.5" />
                                          </TooltipTrigger>
                                          <TooltipContent side="top" className="max-w-xs">
                                            <p>This user hasn&apos;t created a Yappr profile yet, but you can still follow them. They&apos;ll see your follow when they join!</p>
                                          </TooltipContent>
                                        </Tooltip>
                                      </TooltipProvider>
                                    )}
                                  </div>
                                )}
                              </div>
                              
                              {searchUser.isFollowing ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleUnfollow(searchUser.id)}
                                  className="ml-4"
                                >
                                  Following
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  onClick={() => handleFollow(searchUser.id)}
                                  className="ml-4"
                                  disabled={followingInProgress.has(searchUser.id)}
                                >
                                  {followingInProgress.has(searchUser.id) ? (
                                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                                  ) : (
                                    'Follow'
                                  )}
                                </Button>
                              )}
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
                loading={followingState.loading}
                error={followingState.error}
                isEmpty={!followingState.loading && followingState.data?.length === 0}
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
                      <div className="h-12 w-12 rounded-full overflow-hidden bg-gray-100">
                        <AvatarCanvas features={generateAvatarV2(followingUser.id)} size={48} />
                      </div>
                      
                      <div className="flex-1">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-semibold hover:underline cursor-pointer">
                              {followingUser.displayName}
                            </h3>
                            <p className="text-sm text-gray-500">@{followingUser.username}</p>
                            {followingUser.allUsernames && followingUser.allUsernames.length > 1 && (
                              <AlsoKnownAs 
                                primaryUsername={followingUser.username} 
                                allUsernames={followingUser.allUsernames}
                                identityId={followingUser.id}
                              />
                            )}
                            {followingUser.bio && (
                              <div className="flex items-start gap-1 mt-1">
                                <p className="text-sm flex-1">{followingUser.bio}</p>
                                {!followingUser.hasProfile && (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <InformationCircleIcon className="h-4 w-4 text-gray-400 cursor-help flex-shrink-0 mt-0.5" />
                                      </TooltipTrigger>
                                      <TooltipContent side="top" className="max-w-xs">
                                        <p>This user hasn&apos;t created a Yappr profile yet, but you&apos;re following them. They&apos;ll see your follow when they join!</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                )}
                              </div>
                            )}
                            <div className="flex gap-4 mt-2 text-sm text-gray-500">
                              <span>
                                <strong className="text-gray-900 dark:text-gray-100">
                                  {formatNumber(followingUser.followersCount)}
                                </strong> followers
                              </span>
                              <span>
                                <strong className="text-gray-900 dark:text-gray-100">
                                  {formatNumber(followingUser.followingCount)}
                                </strong> following
                              </span>
                            </div>
                          </div>
                          
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleUnfollow(followingUser.id)}
                            className="ml-4"
                          >
                            Following
                          </Button>
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

      <RightSidebar />
    </div>
  )
}

export default withAuth(FollowingPage)