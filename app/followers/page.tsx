'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
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
import { AlsoKnownAs } from '@/components/ui/also-known-as'

interface Follower {
  id: string
  username: string
  displayName: string
  bio?: string
  hasProfile?: boolean
  followersCount: number
  followingCount: number
  isFollowingBack: boolean
  allUsernames?: string[]
}

function FollowersPage() {
  const { user } = useAuth()
  const followersState = useAsyncState<Follower[]>([])

  // Load followers list
  const loadFollowers = useCallback(async (forceRefresh: boolean = false) => {
    const { setLoading, setError, setData } = followersState

    setLoading(true)
    setError(null)

    try {
      console.log('Followers: Loading followers list...')
      
      if (!user?.identityId) {
        setData([])
        setLoading(false)
        return
      }

      const cacheKey = `followers_${user.identityId}`
      
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
      const follows = await followService.getFollowers(user.identityId, { limit: 50 })
      
      console.log('Followers: Raw follows from platform:', follows)

      // Get unique identity IDs from followers
      const identityIds = follows
        .map(f => f.$ownerId || (f as any).ownerId)
        .filter(Boolean)
      
      if (identityIds.length === 0) {
        setData([])
        setLoading(false)
        return
      }
      
      // Batch fetch DPNS names, all usernames, and profiles
      const [dpnsNames, allUsernamesData, profiles] = await Promise.all([
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
      
      // Check if we follow them back
      const followingBack = await Promise.all(
        identityIds.map(id => followService.isFollowing(id, user.identityId))
      )
      const followingBackMap = new Map(identityIds.map((id, index) => [id, followingBack[index]]))
      
      // Create maps for easy lookup
      const dpnsMap = new Map(dpnsNames.map(item => [item.id, item.username]))
      const allUsernamesMap = new Map(allUsernamesData.map(item => [item.id, item.usernames]))
      const profileMap = new Map(profiles.map(p => [p.$ownerId || (p as any).ownerId, p]))
      
      // Create enriched user data
      const followers = follows.map((follow: any) => {
        const followerId = follow.$ownerId || follow.ownerId
        if (!followerId) {
          console.warn('Follow document missing ownerId:', follow)
          return null
        }
        
        const username = dpnsMap.get(followerId)
        const allUsernames = allUsernamesMap.get(followerId) || []
        const profile = profileMap.get(followerId)
        
        return {
          id: followerId,
          username: username || `user_${followerId.slice(-6)}`,
          displayName: profile?.displayName || username || `User ${followerId.slice(-6)}`,
          bio: profile?.bio || (profile ? 'Yappr user' : 'Not yet on Yappr'),
          hasProfile: !!profile,
          followersCount: 0, // Would need to query this
          followingCount: 0, // Would need to query this
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
  }, [followersState.setLoading, followersState.setError, followersState.setData, user?.identityId])

  useEffect(() => {
    if (user) {
      loadFollowers()
    }
  }, [loadFollowers, user])

  const handleFollow = async (userId: string) => {
    console.log('Following user:', userId)
    // TODO: Implement follow functionality
  }

  const handleUnfollow = async (userId: string) => {
    console.log('Unfollowing user:', userId)
    // TODO: Implement unfollow functionality
  }

  return (
    <div className="min-h-screen flex">
      <Sidebar />
      
      <div className="flex-1 flex justify-center">
        <main className="w-full max-w-[600px] border-x border-gray-200 dark:border-gray-800">
          <header className="sticky top-0 z-40 bg-white/80 dark:bg-black/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
            <div className="px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold">Followers</h1>
                  <p className="text-sm text-gray-500 mt-1">
                    {followersState.loading ? 
                      'Loading...' :
                      `${followersState.data?.length || 0} ${followersState.data?.length === 1 ? 'follower' : 'followers'}`
                    }
                  </p>
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
              loading={followersState.loading}
              error={followersState.error}
              isEmpty={!followersState.loading && followersState.data?.length === 0}
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
                      <div className="h-12 w-12 rounded-full overflow-hidden bg-gray-100">
                        <AvatarCanvas features={generateAvatarV2(follower.id)} size={48} />
                      </div>
                      
                      <div className="flex-1">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-semibold hover:underline cursor-pointer">
                              {follower.displayName}
                            </h3>
                            <p className="text-sm text-gray-500">@{follower.username}</p>
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
                              <span>
                                <strong className="text-gray-900 dark:text-gray-100">
                                  {formatNumber(follower.followersCount)}
                                </strong> followers
                              </span>
                              <span>
                                <strong className="text-gray-900 dark:text-gray-100">
                                  {formatNumber(follower.followingCount)}
                                </strong> following
                              </span>
                            </div>
                          </div>
                          
                          {follower.isFollowingBack ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleUnfollow(follower.id)}
                              className="ml-4"
                            >
                              Following
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              onClick={() => handleFollow(follower.id)}
                              className="ml-4"
                            >
                              Follow back
                            </Button>
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