'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeftIcon,
  CalendarIcon,
  MapPinIcon,
  LinkIcon,
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { PostCard } from '@/components/post/post-card'
import { formatNumber } from '@/lib/utils'
import { AvatarCanvas } from '@/components/ui/avatar-canvas'
import {
  generateAvatarV2,
  decodeAvatarFeaturesV2
} from '@/lib/avatar-generator-v2'
import { useAuth } from '@/contexts/auth-context'
import toast from 'react-hot-toast'
import * as Tooltip from '@radix-ui/react-tooltip'
import type { Post } from '@/lib/types'

interface ProfileData {
  displayName: string
  bio?: string
  location?: string
  website?: string
  avatarData?: string
  followersCount: number
  followingCount: number
}

function UserProfileContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const userId = searchParams.get('id')
  const { user: currentUser } = useAuth()

  const isOwnProfile = currentUser?.identityId === userId

  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [hasDpns, setHasDpns] = useState(false)
  const [posts, setPosts] = useState<Post[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isFollowing, setIsFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)

  const avatarFeatures = userId && profile?.avatarData
    ? decodeAvatarFeaturesV2(profile.avatarData)
    : generateAvatarV2(userId || 'default')

  const displayName = profile?.displayName || (userId ? `User ${userId.slice(-6)}` : 'Unknown')

  useEffect(() => {
    if (!userId) return

    const loadProfileData = async () => {
      try {
        setIsLoading(true)

        const { profileService, postService } = await import('@/lib/services')

        // Fetch profile and posts in parallel
        const [profileResult, postsResult] = await Promise.all([
          profileService.getProfile(userId).catch(() => null),
          postService.getUserPosts(userId, { limit: 50 }).catch(() => ({ documents: [], hasMore: false }))
        ])

        // Process profile
        let profileDisplayName = `User ${userId.slice(-6)}`
        let profileAvatarData: string | undefined

        if (profileResult) {
          profileDisplayName = profileResult.displayName || profileDisplayName
          profileAvatarData = profileResult.avatarData
          setProfile({
            displayName: profileDisplayName,
            bio: profileResult.bio,
            location: profileResult.location,
            website: profileResult.website,
            avatarData: profileAvatarData,
            followersCount: 0,
            followingCount: 0,
          })
        }

        // Process posts
        const postDocs = postsResult.documents || []
        if (postDocs.length > 0) {
          const transformedPosts: Post[] = postDocs.map((doc: any) => {
            const authorIdStr = doc.$ownerId || doc.ownerId || userId
            return {
              id: doc.$id || doc.id,
              content: doc.content || '',
              author: {
                id: authorIdStr,
                username: `user_${authorIdStr.slice(-6)}`,
                displayName: profileDisplayName,
                avatar: '',
                avatarData: profileAvatarData,
                verified: false,
                followers: 0,
                following: 0,
                joinedAt: new Date(),
              },
              createdAt: new Date(doc.$createdAt || doc.createdAt || Date.now()),
              likes: 0,
              reposts: 0,
              replies: 0,
              views: 0,
            }
          })
          setPosts(transformedPosts)
        }

        // Try to resolve DPNS username
        try {
          const { dpnsService } = await import('@/lib/services/dpns-service')
          const resolvedUsername = await dpnsService.resolveUsername(userId)
          if (resolvedUsername) {
            setUsername(resolvedUsername)
            setHasDpns(true)
            // Update posts with hasDpns flag
            setPosts(currentPosts => currentPosts.map(post => ({
              ...post,
              author: {
                ...post.author,
                username: resolvedUsername,
                hasDpns: true
              } as any
            })))
          }
        } catch (e) {
          // DPNS resolution is optional
        }

      } catch (error) {
        console.error('Failed to load profile:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadProfileData()
  }, [userId])

  const handleFollow = async () => {
    if (!currentUser) {
      toast.error('Please log in to follow users')
      return
    }

    setFollowLoading(true)
    try {
      setIsFollowing(!isFollowing)
      toast.success(isFollowing ? 'Unfollowed' : 'Following')
    } catch (error) {
      toast.error('Failed to update follow status')
    } finally {
      setFollowLoading(false)
    }
  }

  const handleEditProfile = () => {
    router.push('/profile')
  }

  if (!userId) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <main className="flex-1 min-w-0 md:max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <div className="p-8 text-center text-gray-500">
            <p>User not found</p>
          </div>
        </main>
        <RightSidebar />
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <main className="flex-1 min-w-0 md:max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-black/80 backdrop-blur-xl">
          <div className="flex items-center gap-4 px-4 py-3">
            <button
              onClick={() => router.back()}
              className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <div className="flex-1">
              <h1 className="text-xl font-bold">{displayName}</h1>
              <p className="text-sm text-gray-500">{posts.length} posts</p>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="p-8">
            <div className="h-48 bg-gray-100 dark:bg-gray-900 animate-pulse" />
            <div className="px-4 pb-4">
              <div className="relative -mt-16 mb-4">
                <div className="h-32 w-32 rounded-full bg-gray-200 dark:bg-gray-800 animate-pulse" />
              </div>
              <div className="h-6 w-48 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-2" />
              <div className="h-4 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            </div>
          </div>
        ) : (
          <>
            <div className="h-48 bg-gradient-yappr" />

            <div className="px-4 pb-4">
              <div className="relative flex justify-between items-start -mt-16 mb-4">
                <div className="relative">
                  <div className="h-32 w-32 rounded-full bg-white dark:bg-black p-1">
                    <div className="h-full w-full rounded-full overflow-hidden bg-gray-100">
                      <AvatarCanvas features={avatarFeatures} size={128} />
                    </div>
                  </div>
                </div>

                <div className="mt-20">
                  {isOwnProfile ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleEditProfile}
                    >
                      Edit profile
                    </Button>
                  ) : (
                    <Button
                      variant={isFollowing ? "outline" : "default"}
                      size="sm"
                      onClick={handleFollow}
                      disabled={followLoading}
                    >
                      {isFollowing ? 'Following' : 'Follow'}
                    </Button>
                  )}
                </div>
              </div>

              <div className="mb-3">
                <h2 className="text-xl font-bold">{displayName}</h2>
                {hasDpns ? (
                  <p className="text-gray-500">@{username}</p>
                ) : (
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <button
                          onClick={() => {
                            if (userId) {
                              navigator.clipboard.writeText(userId)
                              toast.success('Identity ID copied')
                            }
                          }}
                          className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-mono text-sm"
                        >
                          {userId?.slice(0, 8)}...{userId?.slice(-6)}
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
                )}
              </div>

              {profile?.bio && <p className="mb-3">{profile.bio}</p>}

              <div className="flex flex-wrap gap-3 text-sm text-gray-500 mb-3">
                {profile?.location && (
                  <span className="flex items-center gap-1">
                    <MapPinIcon className="h-4 w-4" />
                    {profile.location}
                  </span>
                )}
                {profile?.website && (
                  <a
                    href={profile.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-yappr-500 hover:underline"
                  >
                    <LinkIcon className="h-4 w-4" />
                    {profile.website.replace(/^https?:\/\//, '')}
                  </a>
                )}
                <span className="flex items-center gap-1">
                  <CalendarIcon className="h-4 w-4" />
                  Joined recently
                </span>
              </div>

              <div className="flex gap-4 text-sm">
                <button className="hover:underline">
                  <span className="font-bold">{formatNumber(profile?.followingCount || 0)}</span>
                  <span className="text-gray-500"> Following</span>
                </button>
                <button className="hover:underline">
                  <span className="font-bold">{formatNumber(profile?.followersCount || 0)}</span>
                  <span className="text-gray-500"> Followers</span>
                </button>
              </div>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-800">
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                <h3 className="font-semibold">Posts</h3>
              </div>

              {posts.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <p>No posts yet</p>
                </div>
              ) : (
                <div>
                  {posts.map((post) => (
                    <PostCard key={post.id} post={post} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </main>

      <RightSidebar />
    </div>
  )
}

function LoadingFallback() {
  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      <main className="flex-1 min-w-0 md:max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <div className="p-8">
          <div className="h-48 bg-gray-100 dark:bg-gray-900 animate-pulse" />
          <div className="px-4 pb-4">
            <div className="relative -mt-16 mb-4">
              <div className="h-32 w-32 rounded-full bg-gray-200 dark:bg-gray-800 animate-pulse" />
            </div>
            <div className="h-6 w-48 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-2" />
            <div className="h-4 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
          </div>
        </div>
      </main>
      <RightSidebar />
    </div>
  )
}

export default function UserProfilePage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <UserProfileContent />
    </Suspense>
  )
}
