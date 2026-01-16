'use client'

import { useState, useEffect, Suspense, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeftIcon,
  CalendarIcon,
  MapPinIcon,
  LinkIcon,
  ShareIcon,
  NoSymbolIcon,
  Cog6ToothIcon,
  PencilIcon,
  ArrowPathIcon,
  CurrencyDollarIcon,
  QrCodeIcon,
  EnvelopeIcon,
} from '@heroicons/react/24/outline'
import { PaymentUriInput } from '@/components/profile/payment-uri-input'
import { SocialLinksInput } from '@/components/profile/social-links-input'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { PostCard } from '@/components/post/post-card'
import { ComposeModal } from '@/components/compose/compose-modal'
import { formatNumber } from '@/lib/utils'
import { UserAvatar, invalidateAvatarImageCache } from '@/components/ui/avatar-image'
import { AvatarCustomization } from '@/components/settings/avatar-customization'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import toast from 'react-hot-toast'
import * as Tooltip from '@radix-ui/react-tooltip'
import type { Post, ParsedPaymentUri, SocialLink } from '@/lib/types'
import type { MigrationStatus } from '@/lib/services/profile-migration-service'
import { PaymentSchemeIcon, getPaymentLabel, truncateAddress } from '@/components/ui/payment-icons'
import { PaymentQRCodeDialog } from '@/components/ui/payment-qr-dialog'
import { useBlock } from '@/hooks/use-block'
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment'
import { AtSymbolIcon } from '@heroicons/react/24/outline'
import { mentionService } from '@/lib/services/mention-service'
import { MENTION_CONTRACT_ID } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { UsernameDropdown } from '@/components/dpns/username-dropdown'

interface ProfileData {
  displayName: string
  bio?: string
  location?: string
  website?: string
  followersCount: number
  followingCount: number
  pronouns?: string
  paymentUris?: ParsedPaymentUri[]
  socialLinks?: SocialLink[]
  nsfw?: boolean
  hasUnifiedProfile?: boolean
}

function UserProfileContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const userId = searchParams.get('id')
  const { user: currentUser } = useAuth()
  const { requireAuth } = useRequireAuth()

  const isOwnProfile = currentUser?.identityId === userId

  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [allUsernames, setAllUsernames] = useState<string[]>([])
  const [hasDpns, setHasDpns] = useState(false)
  const [posts, setPosts] = useState<Post[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isFollowing, setIsFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [postCount, setPostCount] = useState<number | null>(null)
  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus>('no_profile')

  // Pagination state
  const [hasMore, setHasMore] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [lastPostId, setLastPostId] = useState<string | null>(null)
  const [lastRepostId, setLastRepostId] = useState<string | null>(null)
  const [hasMoreReposts, setHasMoreReposts] = useState(true)

  // Edit profile state
  const [isEditingProfile, setIsEditingProfile] = useState(false)
  const [isEditingAvatar, setIsEditingAvatar] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editBio, setEditBio] = useState('')
  const [editLocation, setEditLocation] = useState('')
  const [editWebsite, setEditWebsite] = useState('')
  const [editPronouns, setEditPronouns] = useState('')
  const [editNsfw, setEditNsfw] = useState(false)
  const [editPaymentUris, setEditPaymentUris] = useState<string[]>([])
  const [editSocialLinks, setEditSocialLinks] = useState<SocialLink[]>([])
  const [isSaving, setIsSaving] = useState(false)

  // QR code dialog state for tip addresses
  const [selectedQrPayment, setSelectedQrPayment] = useState<ParsedPaymentUri | null>(null)

  // Block state - only check if viewing another user's profile
  const { isBlocked: isBlockedByMe, isLoading: blockLoading, toggleBlock } = useBlock(userId || '')

  // Tab state for Posts/Mentions
  const [activeTab, setActiveTab] = useState<'posts' | 'mentions'>('posts')
  const [mentions, setMentions] = useState<Post[]>([])
  const [mentionsLoading, setMentionsLoading] = useState(false)
  const [mentionsLoaded, setMentionsLoaded] = useState(false)
  const [mentionCount, setMentionCount] = useState<number | null>(null)

  // Progressive enrichment for post metadata (likes, reposts, etc.)
  const { enrichProgressively, getPostEnrichment } = useProgressiveEnrichment({
    currentUserId: currentUser?.identityId
  })

  const displayName = profile?.displayName || (userId ? `User ${userId.slice(-6)}` : 'Unknown')

  // Check if display name is still in loading/fallback state
  const isDisplayNameLoading = isLoading || !profile?.displayName

  useEffect(() => {
    if (!userId) return

    const loadProfileData = async () => {
      try {
        setIsLoading(true)

        const { unifiedProfileService, postService, followService } = await import('@/lib/services')
        const { profileMigrationService } = await import('@/lib/services/profile-migration-service')

        // Check migration status for own profile
        if (isOwnProfile) {
          const status = await profileMigrationService.getMigrationStatus(userId)
          setMigrationStatus(status)
        }

        // Fetch profile from unified service, posts, and post count in parallel
        const [profileResult, postsResult, totalPostCount] = await Promise.all([
          unifiedProfileService.getProfile(userId).catch(() => null),
          postService.getUserPosts(userId, { limit: 50 }).catch(() => ({ documents: [], hasMore: false })),
          postService.countUserPosts(userId).catch(() => 0)
        ])

        setPostCount(totalPostCount)

        // Process profile
        let profileDisplayName = `User ${userId.slice(-6)}`

        // Load follower/following counts
        const [followersCount, followingCount] = await Promise.all([
          followService.countFollowers(userId),
          followService.countFollowing(userId)
        ])

        if (profileResult) {
          profileDisplayName = profileResult.displayName || profileDisplayName
          setProfile({
            displayName: profileDisplayName,
            bio: profileResult.bio,
            location: profileResult.location,
            website: profileResult.website,
            followersCount,
            followingCount,
            pronouns: profileResult.pronouns,
            paymentUris: profileResult.paymentUris,
            socialLinks: profileResult.socialLinks,
            nsfw: profileResult.nsfw,
            hasUnifiedProfile: profileResult.hasUnifiedProfile,
          })
        } else {
          // Even without a Yappr profile, show follow counts
          setProfile({
            displayName: profileDisplayName,
            followersCount,
            followingCount,
          })
        }

        // Check if current user follows this user
        if (currentUser?.identityId && currentUser.identityId !== userId) {
          const following = await followService.isFollowing(userId, currentUser.identityId)
          setIsFollowing(following)
        }

        // Process posts
        const postDocs = postsResult.documents || []
        const transformedPosts: Post[] = postDocs.map((doc: any) => {
          const authorIdStr = doc.$ownerId || doc.ownerId || userId
          return {
            id: doc.$id || doc.id,
            content: doc.content || '',
            author: {
              id: authorIdStr,
              // Don't use a fake username format - leave empty and let hasDpns control display
              username: '',
              // Use empty displayName initially - skeleton shows when hasDpns is undefined
              displayName: '',
              avatar: '', // Let UserAvatar fetch the actual avatar
              verified: false,
              followers: 0,
              following: 0,
              joinedAt: new Date(),
              // undefined = still loading, will show skeleton in PostCard
              hasDpns: undefined,
            } as any,
            createdAt: new Date(doc.$createdAt || doc.createdAt || Date.now()),
            likes: 0,
            reposts: 0,
            replies: 0,
            views: 0,
            quotedPostId: doc.quotedPostId || undefined,
          }
        })

        // Fetch user's reposts and merge with their posts
        try {
          const { repostService } = await import('@/lib/services/repost-service')
          const userReposts = await repostService.getUserReposts(userId)

          // Track repost pagination
          if (userReposts.length > 0) {
            const lastRepost = userReposts[userReposts.length - 1]
            setLastRepostId(lastRepost.$id)
          }
          setHasMoreReposts(userReposts.length >= 50)

          if (userReposts.length > 0) {
            // Get unique post IDs that this user has reposted
            const repostedPostIds = userReposts.map(r => r.postId).filter(id => id)
            const repostedPosts = await postService.getPostsByIds(repostedPostIds)

            // Try to resolve DPNS username for reposter display
            let reposterUsername: string | undefined
            try {
              const { dpnsService } = await import('@/lib/services/dpns-service')
              reposterUsername = await dpnsService.resolveUsername(userId) || undefined
            } catch (e) {
              // DPNS resolution is optional
            }

            // Create repost entries with repostedBy info
            for (const repost of userReposts) {
              const originalPost = repostedPosts.find(p => p.id === repost.postId)
              if (originalPost && originalPost.author.id !== userId) {
                // Add as a reposted post
                const repostEntry: Post = {
                  ...originalPost,
                  repostedBy: {
                    id: userId,
                    displayName: profileDisplayName,
                    username: reposterUsername
                  },
                  repostTimestamp: new Date(repost.$createdAt)
                }
                transformedPosts.push(repostEntry)
              }
            }

            // Sort by timestamp (repostTimestamp for reposts, createdAt for original posts)
            transformedPosts.sort((a, b) => {
              const aTime = a.repostTimestamp?.getTime() || a.createdAt.getTime()
              const bTime = b.repostTimestamp?.getTime() || b.createdAt.getTime()
              return bTime - aTime
            })
          }
        } catch (repostError) {
          console.error('Failed to fetch user reposts:', repostError)
          // Continue without reposts - non-critical
        }

        // Fetch quoted posts for quote posts
        try {
          const quotedPostIds = transformedPosts
            .filter((p: any) => p.quotedPostId)
            .map((p: any) => p.quotedPostId)

          if (quotedPostIds.length > 0) {
            const quotedPosts = await postService.getPostsByIds(quotedPostIds)
            const quotedPostMap = new Map(quotedPosts.map(p => [p.id, p]))

            for (const post of transformedPosts) {
              if ((post as any).quotedPostId && quotedPostMap.has((post as any).quotedPostId)) {
                (post as any).quotedPost = quotedPostMap.get((post as any).quotedPostId)
              }
            }
          }
        } catch (quoteError) {
          console.error('Failed to fetch quoted posts:', quoteError)
          // Continue without quoted posts - non-critical
        }

        if (transformedPosts.length > 0) {
          setPosts(transformedPosts)
          // Start progressive enrichment for post metadata
          enrichProgressively(transformedPosts)
        }

        // Set pagination state based on original posts (not reposts)
        const originalPosts = postDocs || []
        if (originalPosts.length > 0) {
          const lastPost = originalPosts[originalPosts.length - 1] as any
          setLastPostId(lastPost.$id || lastPost.id)
        }
        // If we got fewer posts than requested, there are no more to load
        setHasMore(originalPosts.length >= 50)

        // Try to resolve DPNS usernames (fetch all, use first as primary)
        try {
          const { dpnsService } = await import('@/lib/services/dpns-service')
          const usernames = await dpnsService.getAllUsernames(userId)
          if (usernames.length > 0) {
            setAllUsernames(usernames)
            setUsername(usernames[0])
            setHasDpns(true)
            // Update posts with hasDpns flag
            setPosts(currentPosts => currentPosts.map(post => ({
              ...post,
              author: {
                ...post.author,
                username: usernames[0],
                hasDpns: true
              } as any
            })))
          } else {
            // Reset DPNS state when no usernames found
            setAllUsernames([])
            setUsername(null)
            setHasDpns(false)
          }
        } catch (e) {
          // Reset DPNS state on error to avoid stale data
          setAllUsernames([])
          setUsername(null)
          setHasDpns(false)
        }

      } catch (error) {
        console.error('Failed to load profile:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadProfileData().catch(err => console.error('Failed to load profile:', err))
  // currentUser is intentionally not a dependency - we only want to reload on userId change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, enrichProgressively])

  // Define handleStartEdit before the useEffect that uses it
  const handleStartEdit = useCallback(() => {
    setEditDisplayName(profile?.displayName || '')
    setEditBio(profile?.bio || '')
    setEditLocation(profile?.location || '')
    setEditWebsite(profile?.website || '')
    setEditPronouns(profile?.pronouns || '')
    setEditNsfw(profile?.nsfw || false)
    setEditPaymentUris(profile?.paymentUris?.map(p => p.uri) || [])
    setEditSocialLinks(profile?.socialLinks || [])
    setIsEditingProfile(true)
  }, [profile])

  // Handle edit URL parameter for deep linking to edit mode
  useEffect(() => {
    if (!isOwnProfile || isLoading) return

    const editParam = searchParams.get('edit')
    if (editParam === 'true' && !isEditingProfile) {
      handleStartEdit()
      // Remove edit param from URL after triggering edit mode
      const url = new URL(window.location.href)
      url.searchParams.delete('edit')
      window.history.replaceState({}, '', url.toString())
    }
  }, [isOwnProfile, isLoading, searchParams, isEditingProfile, handleStartEdit])

  // Handle tip URL parameter for deep linking
  useEffect(() => {
    if (!profile?.paymentUris || profile.paymentUris.length === 0) return

    const tipUri = searchParams.get('tip')
    if (!tipUri) return

    // Find matching payment URI
    const matchingPayment = profile.paymentUris.find(p => p.uri === tipUri)
    if (matchingPayment) {
      setSelectedQrPayment(matchingPayment)
    }
  }, [profile?.paymentUris, searchParams])

  const loadMorePosts = useCallback(async () => {
    // Check if there's more content to load (either posts or reposts)
    const canLoadMorePosts = hasMore && lastPostId
    const canLoadMoreReposts = hasMoreReposts && lastRepostId
    if (!userId || isLoadingMore || (!canLoadMorePosts && !canLoadMoreReposts)) return

    setIsLoadingMore(true)
    try {
      const { postService } = await import('@/lib/services')
      const { repostService } = await import('@/lib/services/repost-service')

      const newPosts: Post[] = []
      let newPostDocs: any[] = []
      let newRepostDocs: any[] = []

      // Fetch more posts using cursor-based pagination
      if (canLoadMorePosts) {
        const postsResult = await postService.getUserPosts(userId, {
          limit: 50,
          startAfter: lastPostId
        })

        newPostDocs = postsResult.documents || []

        // Transform new posts
        for (const doc of newPostDocs) {
          const authorIdStr = doc.$ownerId || doc.ownerId || userId
          newPosts.push({
            id: doc.$id || doc.id,
            content: doc.content || '',
            author: {
              id: authorIdStr,
              // Use resolved username or empty string (not fake user_ prefix)
              username: username || '',
              // Use resolved displayName or empty string for skeleton/enrichment
              displayName: profile?.displayName || '',
              avatar: '',
              verified: false,
              followers: 0,
              following: 0,
              joinedAt: new Date(),
              hasDpns: hasDpns,
            } as any,
            createdAt: new Date(doc.$createdAt || doc.createdAt || Date.now()),
            likes: 0,
            reposts: 0,
            replies: 0,
            views: 0,
            quotedPostId: doc.quotedPostId || undefined,
          })
        }
      }

      // Fetch more reposts using cursor-based pagination
      if (canLoadMoreReposts) {
        try {
          newRepostDocs = await repostService.getUserReposts(userId)

          if (newRepostDocs.length > 0) {
            // Get unique post IDs that this user has reposted
            const repostedPostIds = newRepostDocs.map(r => r.postId).filter((id: string) => id)
            const repostedPosts = await postService.getPostsByIds(repostedPostIds)

            // Try to resolve DPNS username for reposter display
            let reposterUsername: string | undefined
            try {
              const { dpnsService } = await import('@/lib/services/dpns-service')
              reposterUsername = await dpnsService.resolveUsername(userId) || undefined
            } catch (e) {
              // DPNS resolution is optional
            }

            // Create repost entries with repostedBy info
            for (const repost of newRepostDocs) {
              const originalPost = repostedPosts.find(p => p.id === repost.postId)
              if (originalPost && originalPost.author.id !== userId) {
                newPosts.push({
                  ...originalPost,
                  repostedBy: {
                    id: userId,
                    // Empty string shows "Someone reposted" instead of "User XKSFJL reposted"
                    displayName: profile?.displayName || '',
                    username: reposterUsername
                  },
                  repostTimestamp: new Date(repost.$createdAt)
                })
              }
            }
          }
        } catch (repostError) {
          console.error('Failed to fetch more reposts:', repostError)
          // Continue without reposts - non-critical
        }
      }

      // Fetch quoted posts for quote posts
      try {
        const quotedPostIds = newPosts
          .filter((p: any) => p.quotedPostId)
          .map((p: any) => p.quotedPostId)

        if (quotedPostIds.length > 0) {
          const quotedPosts = await postService.getPostsByIds(quotedPostIds)
          const quotedPostMap = new Map(quotedPosts.map(p => [p.id, p]))

          for (const post of newPosts) {
            if ((post as any).quotedPostId && quotedPostMap.has((post as any).quotedPostId)) {
              (post as any).quotedPost = quotedPostMap.get((post as any).quotedPostId)
            }
          }
        }
      } catch (quoteError) {
        console.error('Failed to fetch quoted posts:', quoteError)
      }

      // Append to existing posts and sort
      setPosts(currentPosts => {
        const existingIds = new Set(currentPosts.map(p => p.id))
        const uniqueNewPosts = newPosts.filter(p => !existingIds.has(p.id))
        const allPosts = [...currentPosts, ...uniqueNewPosts]
        // Sort by timestamp (repostTimestamp for reposts, createdAt for original posts)
        allPosts.sort((a, b) => {
          const aTime = a.repostTimestamp?.getTime() || a.createdAt.getTime()
          const bTime = b.repostTimestamp?.getTime() || b.createdAt.getTime()
          return bTime - aTime
        })
        return allPosts
      })

      // Start progressive enrichment for new posts
      if (newPosts.length > 0) {
        enrichProgressively(newPosts)
      }

      // Update pagination state for posts (only if posts were fetched)
      if (canLoadMorePosts) {
        if (newPostDocs.length > 0) {
          const lastPost = newPostDocs[newPostDocs.length - 1] as any
          setLastPostId(lastPost.$id || lastPost.id)
        }
        setHasMore(newPostDocs.length >= 50)
      }

      // Update pagination state for reposts (only if reposts were fetched)
      if (canLoadMoreReposts) {
        if (newRepostDocs.length > 0) {
          const lastRepost = newRepostDocs[newRepostDocs.length - 1] as any
          setLastRepostId(lastRepost.$id)
        }
        setHasMoreReposts(newRepostDocs.length >= 50)
      }
    } catch (error) {
      console.error('Failed to load more posts:', error)
    } finally {
      setIsLoadingMore(false)
    }
  }, [userId, isLoadingMore, hasMore, hasMoreReposts, lastPostId, lastRepostId, username, profile?.displayName, hasDpns, enrichProgressively])

  // Load mentions for this user (lazy load when tab is selected)
  const loadMentions = useCallback(async () => {
    if (!userId || mentionsLoaded || !MENTION_CONTRACT_ID) return

    setMentionsLoading(true)
    try {
      const mentionDocs = await mentionService.getPostsMentioningUser(userId)
      setMentionCount(mentionDocs.length)

      if (mentionDocs.length === 0) {
        setMentions([])
        setMentionsLoaded(true)
        return
      }

      const { postService } = await import('@/lib/services/post-service')
      const postIds = Array.from(new Set(mentionDocs.map(m => m.postId)))

      // Fetch posts and validate ownership
      const fetchedPosts: Post[] = []
      for (const postId of postIds) {
        try {
          const post = await postService.get(postId)
          if (post) {
            // Verify mention was created by post owner (security filter)
            const mentionDoc = mentionDocs.find(m => m.postId === postId)
            if (mentionDoc && mentionDoc.$ownerId === post.author.id) {
              fetchedPosts.push(post)
            }
          }
        } catch (error) {
          console.error('Failed to fetch post:', postId, error)
        }
      }

      // Sort by creation date (newest first)
      fetchedPosts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

      // Enrich posts with author data
      const enrichedPosts = await postService.enrichPostsBatch(fetchedPosts)

      setMentions(enrichedPosts)
      setMentionCount(enrichedPosts.length)
    } catch (error) {
      console.error('Failed to load mentions:', error)
      setMentions([])
    } finally {
      setMentionsLoading(false)
      setMentionsLoaded(true)
    }
  }, [userId, mentionsLoaded])

  // Load mentions when tab is activated
  useEffect(() => {
    if (activeTab === 'mentions' && !mentionsLoaded && MENTION_CONTRACT_ID) {
      loadMentions().catch(err => console.error('Failed to load mentions:', err))
    }
  }, [activeTab, mentionsLoaded, loadMentions])

  // Reset mentions when user changes
  useEffect(() => {
    setMentions([])
    setMentionsLoaded(false)
    setMentionCount(null)
    setActiveTab('posts')
  }, [userId])

  const handleFollow = async () => {
    const authedUser = requireAuth('follow')
    if (!authedUser) return
    if (!userId) return

    setFollowLoading(true)
    try {
      const { followService } = await import('@/lib/services')

      if (isFollowing) {
        // Unfollow
        const result = await followService.unfollowUser(authedUser.identityId, userId)
        if (result.success) {
          setIsFollowing(false)
          // Update follower count in profile
          setProfile(prev => prev ? { ...prev, followersCount: Math.max(0, prev.followersCount - 1) } : null)
          toast.success('Unfollowed')
        } else {
          throw new Error(result.error || 'Failed to unfollow')
        }
      } else {
        // Follow
        const result = await followService.followUser(authedUser.identityId, userId)
        if (result.success) {
          setIsFollowing(true)
          // Update follower count in profile
          setProfile(prev => prev ? { ...prev, followersCount: prev.followersCount + 1 } : null)
          toast.success('Following!')
        } else {
          throw new Error(result.error || 'Failed to follow')
        }
      }
    } catch (error) {
      console.error('Follow error:', error)
      toast.error('Failed to update follow status')
    } finally {
      setFollowLoading(false)
    }
  }

  const handleCancelEdit = () => {
    setIsEditingProfile(false)
    setEditDisplayName('')
    setEditBio('')
    setEditLocation('')
    setEditWebsite('')
    setEditPronouns('')
    setEditNsfw(false)
    setEditPaymentUris([])
    setEditSocialLinks([])
  }

  const handleSaveProfile = async () => {
    if (!currentUser?.identityId) return

    setIsSaving(true)
    try {
      const { unifiedProfileService } = await import('@/lib/services')
      await unifiedProfileService.updateProfile(currentUser.identityId, {
        displayName: editDisplayName,
        bio: editBio,
        location: editLocation,
        website: editWebsite,
        pronouns: editPronouns,
        nsfw: editNsfw,
        paymentUris: editPaymentUris,
        socialLinks: editSocialLinks,
      })

      // Update local profile state
      setProfile(prev => prev ? {
        ...prev,
        displayName: editDisplayName,
        bio: editBio,
        location: editLocation,
        website: editWebsite,
        pronouns: editPronouns,
        nsfw: editNsfw,
        paymentUris: editPaymentUris.map(uri => ({
          scheme: uri.split(':')[0] + ':',
          uri,
        })),
        socialLinks: editSocialLinks,
      } : null)

      setIsEditingProfile(false)
      toast.success('Profile updated!')
    } catch (error) {
      console.error('Failed to update profile:', error)
      toast.error('Failed to update profile')
    } finally {
      setIsSaving(false)
    }
  }

  if (!userId) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
            <div className="p-8 text-center text-gray-500">
              <p>User not found</p>
            </div>
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl">
          <div className="flex items-center gap-4 px-4 py-3">
            <button
              onClick={() => router.back()}
              className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <div className="flex-1">
              {isDisplayNameLoading ? (
                <div className="h-6 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-1" />
              ) : (
                <h1 className="text-xl font-bold">{displayName}</h1>
              )}
              <p className="text-sm text-gray-500">{postCount !== null ? postCount : '–'} posts</p>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div>
            <div className="h-48 bg-gradient-yappr opacity-50" />
            <div className="px-4 pb-4">
              <div className="relative -mt-16 mb-4">
                <div className="h-32 w-32 rounded-full bg-white dark:bg-neutral-900 p-1">
                  <div className="h-full w-full rounded-full overflow-hidden blur-sm opacity-60">
                    <UserAvatar
                      userId={userId || 'default'}
                      alt="Loading..."
                      size="full"
                    />
                  </div>
                </div>
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
                  <div className="h-32 w-32 rounded-full bg-white dark:bg-neutral-900 p-1">
                    <UserAvatar
                      key={avatarKey}
                      userId={userId || 'default'}
                      alt={displayName}
                      size="full"
                    />
                  </div>
                  {isOwnProfile && isEditingProfile && (
                    <button
                      onClick={() => setIsEditingAvatar(true)}
                      className="absolute bottom-1 right-1 p-2 bg-yappr-500 rounded-full hover:bg-yappr-600 transition-colors shadow-lg"
                      title="Edit avatar"
                    >
                      <PencilIcon className="h-4 w-4 text-white" />
                    </button>
                  )}
                </div>

                <div className="mt-20 flex items-center gap-2">
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <button
                          onClick={() => {
                            const profileUrl = `${window.location.origin}/user?id=${userId}`
                            navigator.clipboard.writeText(profileUrl).catch(console.error)
                            toast.success('Profile link copied!')
                          }}
                          className="p-2 rounded-full border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                        >
                          <ShareIcon className="h-4 w-4" />
                        </button>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                          sideOffset={5}
                        >
                          Share profile
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                  {isOwnProfile && (
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <button
                            onClick={() => router.push('/settings')}
                            className="p-2 rounded-full border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                          >
                            <Cog6ToothIcon className="h-4 w-4" />
                          </button>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                            sideOffset={5}
                          >
                            Settings
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    </Tooltip.Provider>
                  )}
                  {isOwnProfile ? (
                    isEditingProfile ? (
                      <div className="flex gap-2">
                        <Button size="sm" variant="ghost" onClick={handleCancelEdit} disabled={isSaving}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={handleSaveProfile} disabled={isSaving}>
                          {isSaving ? 'Saving...' : 'Save'}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleStartEdit}
                      >
                        Edit profile
                      </Button>
                    )
                  ) : (
                    <div className="flex gap-2">
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <button
                              onClick={() => router.push(`/messages?startConversation=${userId}`)}
                              aria-label={`Message ${profile?.displayName || username || 'user'}`}
                              className="p-2 rounded-full border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                            >
                              <EnvelopeIcon className="h-4 w-4" />
                            </button>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                              sideOffset={5}
                            >
                              Message
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      </Tooltip.Provider>
                      <Button
                        variant={isFollowing ? "outline" : "default"}
                        size="sm"
                        onClick={handleFollow}
                        disabled={followLoading}
                      >
                        {isFollowing ? 'Following' : 'Follow'}
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {isOwnProfile && isEditingProfile ? (
                <div className="space-y-4">
                  {/* Basic Info */}
                  <div>
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Name</label>
                    <input
                      type="text"
                      value={editDisplayName}
                      onChange={(e) => setEditDisplayName(e.target.value)}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                      maxLength={50}
                    />
                  </div>

                  <div>
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Pronouns</label>
                    <input
                      type="text"
                      value={editPronouns}
                      onChange={(e) => setEditPronouns(e.target.value)}
                      placeholder="e.g. she/her"
                      className="mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                      maxLength={20}
                    />
                  </div>

                  <div>
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Bio</label>
                    <textarea
                      value={editBio}
                      onChange={(e) => setEditBio(e.target.value)}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
                      rows={3}
                      maxLength={160}
                    />
                    <p className="text-xs text-gray-500 mt-1">{editBio.length}/160</p>
                  </div>

                  <div>
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Location</label>
                    <input
                      type="text"
                      value={editLocation}
                      onChange={(e) => setEditLocation(e.target.value)}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                      maxLength={50}
                    />
                  </div>

                  <div>
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Website</label>
                    <input
                      type="text"
                      value={editWebsite}
                      onChange={(e) => setEditWebsite(e.target.value)}
                      placeholder="https://example.com"
                      className="mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                      maxLength={200}
                    />
                  </div>

                  {/* Payment Addresses */}
                  <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                    <PaymentUriInput
                      uris={editPaymentUris}
                      onChange={setEditPaymentUris}
                      disabled={isSaving}
                    />
                  </div>

                  {/* Social Links */}
                  <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                    <SocialLinksInput
                      links={editSocialLinks}
                      onChange={setEditSocialLinks}
                      disabled={isSaving}
                    />
                  </div>

                  {/* Content Settings */}
                  <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editNsfw}
                        onChange={(e) => setEditNsfw(e.target.checked)}
                        className="w-4 h-4 text-yappr-500 rounded focus:ring-yappr-500"
                      />
                      <div>
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">NSFW Content</span>
                        <p className="text-xs text-gray-500">Mark your profile as containing adult content</p>
                      </div>
                    </label>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-3">
                    {isDisplayNameLoading ? (
                      <div className="h-7 w-48 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-1" />
                    ) : (
                      <h2 className="text-xl font-bold">{displayName}</h2>
                    )}
                    {hasDpns && username ? (
                      <UsernameDropdown username={username} allUsernames={allUsernames} />
                    ) : (
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <button
                              onClick={() => {
                                if (userId) {
                                  navigator.clipboard.writeText(userId).catch(console.error)
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

                  {/* Pronouns */}
                  {profile?.pronouns && (
                    <p className="text-gray-500 text-sm mb-2">{profile.pronouns}</p>
                  )}

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
                    <button
                      onClick={() => router.push(`/following?id=${userId}`)}
                      className="hover:underline"
                    >
                      <span className="font-bold">{formatNumber(profile?.followingCount || 0)}</span>
                      <span className="text-gray-500"> Following</span>
                    </button>
                    <button
                      onClick={() => router.push(`/followers?id=${userId}`)}
                      className="hover:underline"
                    >
                      <span className="font-bold">{formatNumber(profile?.followersCount || 0)}</span>
                      <span className="text-gray-500"> Followers</span>
                    </button>
                  </div>

                  {/* Social Links */}
                  {profile?.socialLinks && profile.socialLinks.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-800">
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Social</h4>
                      <div className="flex flex-wrap gap-2">
                        {profile.socialLinks.map((link, index) => (
                          <span
                            key={index}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-sm"
                          >
                            <span className="font-medium capitalize">{link.platform}:</span>
                            <span className="text-gray-600 dark:text-gray-400">{link.handle}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Payment Addresses */}
                  {profile?.paymentUris && profile.paymentUris.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-800">
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        <CurrencyDollarIcon className="h-3 w-3 inline mr-1" />
                        Tip Addresses
                      </h4>
                      <div className="space-y-2">
                        {profile.paymentUris.map((payment, index) => (
                          <button
                            key={index}
                            onClick={() => {
                              setSelectedQrPayment(payment)
                              // Update URL with tip param for deep linking
                              const url = new URL(window.location.href)
                              url.searchParams.set('tip', payment.uri)
                              window.history.replaceState({}, '', url.toString())
                            }}
                            className="w-full flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-900 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-left"
                          >
                            <PaymentSchemeIcon scheme={payment.scheme} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium">{getPaymentLabel(payment.uri)}</span>
                              <p className="text-xs text-gray-500 font-mono truncate">
                                {truncateAddress(payment.uri, 24)}
                              </p>
                            </div>
                            <QrCodeIcon className="w-4 h-4 text-gray-400" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Migration Prompt Banner */}
            {isOwnProfile && migrationStatus === 'needs_migration' && (
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border-y border-blue-200 dark:border-blue-800">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-full">
                      <ArrowPathIcon className="h-6 w-6 text-blue-500" />
                    </div>
                    <div>
                      <p className="font-semibold text-blue-800 dark:text-blue-200">Migrate Your Profile</p>
                      <p className="text-sm text-blue-700 dark:text-blue-300">Your profile is not visible to others until you migrate.</p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => router.push('/profile/create')}
                    className="bg-blue-500 hover:bg-blue-600"
                  >
                    Migrate Now
                  </Button>
                </div>
              </div>
            )}

            {/* Blocked User Notice */}
            {isBlockedByMe && !isOwnProfile && (
              <div className="p-4 bg-gray-50 dark:bg-gray-950 border-y border-gray-200 dark:border-gray-800">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-full">
                      <NoSymbolIcon className="h-6 w-6 text-red-500" />
                    </div>
                    <div>
                      <p className="font-semibold">You blocked this user</p>
                      <p className="text-sm text-gray-500">You won&apos;t see their posts in your feeds</p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => toggleBlock()}
                    disabled={blockLoading}
                  >
                    Unblock
                  </Button>
                </div>
              </div>
            )}

            <div className="border-t border-gray-200 dark:border-gray-800">
              {/* Tab Navigation */}
              <div className="flex border-b border-gray-200 dark:border-gray-800">
                <button
                  onClick={() => setActiveTab('posts')}
                  className={cn(
                    'flex-1 py-4 text-center font-medium transition-colors relative',
                    activeTab === 'posts'
                      ? 'text-gray-900 dark:text-white'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  )}
                >
                  Posts {postCount !== null && `(${postCount})`}
                  {activeTab === 'posts' && (
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-14 h-1 bg-yappr-500 rounded-full" />
                  )}
                </button>
                <button
                  onClick={() => setActiveTab('mentions')}
                  className={cn(
                    'flex-1 py-4 text-center font-medium transition-colors relative',
                    activeTab === 'mentions'
                      ? 'text-gray-900 dark:text-white'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  )}
                >
                  <span className="inline-flex items-center gap-1">
                    <AtSymbolIcon className="h-4 w-4" />
                    Mentions {mentionCount !== null && `(${mentionCount})`}
                  </span>
                  {activeTab === 'mentions' && (
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-14 h-1 bg-yappr-500 rounded-full" />
                  )}
                </button>
              </div>

              {/* Tab Content */}
              {activeTab === 'posts' ? (
                // Posts Tab
                posts.length === 0 ? (
                  <div className="p-8 text-center text-gray-500">
                    <p>No posts yet</p>
                  </div>
                ) : (
                  <div>
                    {posts.map((post) => (
                      <PostCard
                        key={post.id}
                        post={post}
                        enrichment={getPostEnrichment(post)}
                      />
                    ))}

                    {/* Load More button */}
                    {(hasMore || hasMoreReposts) && (
                      <div className="p-4 flex justify-center border-t border-gray-200 dark:border-gray-800">
                        <Button
                          variant="outline"
                          onClick={loadMorePosts}
                          disabled={isLoadingMore}
                          className="w-full max-w-xs"
                        >
                          {isLoadingMore ? 'Loading...' : 'Load more posts'}
                        </Button>
                    </div>
                  )}
                </div>
              )
              ) : (
                // Mentions Tab
                mentionsLoading ? (
                  <div className="p-8 text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yappr-500 mx-auto mb-4"></div>
                    <p className="text-gray-500">Loading mentions...</p>
                  </div>
                ) : !MENTION_CONTRACT_ID ? (
                  <div className="p-8 text-center text-gray-500">
                    <AtSymbolIcon className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                    <p>Mentions feature not yet available</p>
                    <p className="text-sm mt-2">Mention contract not deployed</p>
                  </div>
                ) : mentions.length === 0 ? (
                  <div className="p-8 text-center text-gray-500">
                    <AtSymbolIcon className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                    <p>No mentions yet</p>
                    <p className="text-sm mt-2">Posts that mention this user will appear here</p>
                  </div>
                ) : (
                  <div>
                    {mentions.map((post) => (
                      <PostCard
                        key={post.id}
                        post={post}
                      />
                    ))}
                  </div>
                )
              )}
            </div>
          </>
          )}
        </main>
      </div>

      <RightSidebar />
      <ComposeModal />

      {/* Avatar Customization Modal */}
      {isEditingAvatar && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setIsEditingAvatar(false)}
          />
          <div className="relative bg-white dark:bg-neutral-900 rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Customize Avatar</h2>
              <button
                onClick={() => setIsEditingAvatar(false)}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <AvatarCustomization
              compact
              onSave={() => {
                setIsEditingAvatar(false)
                if (userId) {
                  invalidateAvatarImageCache(userId)
                }
                setAvatarKey(prev => prev + 1)
              }}
            />
          </div>
        </div>
      )}

      {/* Payment QR Code Dialog */}
      <PaymentQRCodeDialog
        isOpen={!!selectedQrPayment}
        onClose={() => {
          setSelectedQrPayment(null)
          // Remove tip param from URL
          const url = new URL(window.location.href)
          url.searchParams.delete('tip')
          window.history.replaceState({}, '', url.toString())
        }}
        paymentUri={selectedQrPayment}
        recipientName={username || displayName}
      />
    </div>
  )
}

function LoadingFallback() {
  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <div>
            <div className="h-48 bg-gradient-yappr opacity-50" />
            <div className="px-4 pb-4">
              <div className="relative -mt-16 mb-4">
                <div className="h-32 w-32 rounded-full bg-white dark:bg-neutral-900 p-1">
                  <div className="h-full w-full rounded-full bg-gray-200 dark:bg-gray-700 animate-pulse" />
                </div>
              </div>
              <div className="h-6 w-48 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-2" />
              <div className="h-4 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            </div>
          </div>
        </main>
      </div>
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
