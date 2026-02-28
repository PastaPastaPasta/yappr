'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, Suspense, useCallback, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeftIcon,
  BuildingStorefrontIcon,
  CalendarIcon,
  MapPinIcon,
  LinkIcon,
  ShareIcon,
  NoSymbolIcon,
  Cog6ToothIcon,
  PencilIcon,
  CurrencyDollarIcon,
  QrCodeIcon,
  EnvelopeIcon,
  UserPlusIcon,
  LockClosedIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import { PaymentUriInput } from '@/components/profile/payment-uri-input'
import { SocialLinksInput } from '@/components/profile/social-links-input'
import { PrivateFeedAccessButton } from '@/components/profile/private-feed-access-button'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { PostCard } from '@/components/post/post-card'
import { ComposeModal } from '@/components/compose/compose-modal'
import { formatNumber } from '@/lib/utils'
import { UserAvatar, invalidateAvatarImageCache } from '@/components/ui/avatar-image'
import { BannerImage, invalidateBannerCache } from '@/components/ui/banner-image'
import { AvatarCustomization } from '@/components/settings/avatar-customization'
import { BannerCustomization } from '@/components/settings/banner-customization'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import toast from 'react-hot-toast'
import * as Tooltip from '@radix-ui/react-tooltip'
import type { BlogPost, Post, ParsedPaymentUri, SocialLink, Store } from '@/lib/types'
import { PaymentSchemeIcon, getPaymentLabel, truncateAddress } from '@/components/ui/payment-icons'
import { PaymentQRCodeDialog } from '@/components/ui/payment-qr-dialog'
import { useBlock } from '@/hooks/use-block'
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment'
import { useTipModal } from '@/hooks/use-tip-modal'
import { AtSymbolIcon } from '@heroicons/react/24/outline'
import { mentionService } from '@/lib/services/mention-service'
import { cn } from '@/lib/utils'
import { UsernameDropdown } from '@/components/dpns/username-dropdown'
import { UsernameModal } from '@/components/dpns/username-modal'
import { useSettingsStore } from '@/lib/store'

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
  bannerUri?: string
  joinedAt?: Date
}

interface ProfileBlog {
  id: string
  name: string
  description?: string
  postCount: number
}

function getSocialLinkUrl(platform: string, handle: string): string | null {
  const trimmedHandle = handle.trim()
  if (!trimmedHandle) return null

  const cleanHandle = encodeURIComponent(trimmedHandle.replace(/^@/, ''))

  switch (platform) {
    case 'twitter':
      return `https://x.com/${cleanHandle}`
    case 'github':
      return `https://github.com/${cleanHandle}`
    case 'telegram':
      return `https://t.me/${cleanHandle}`
    case 'youtube':
      if (!cleanHandle) return null
      return `https://www.youtube.com/@${cleanHandle}`
    case 'twitch':
      return `https://twitch.tv/${cleanHandle}`
    case 'instagram':
      return `https://instagram.com/${cleanHandle}`
    case 'linkedin':
      return `https://linkedin.com/in/${cleanHandle}`
    case 'email': {
      const emailOnly = trimmedHandle.split('?')[0]
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailOnly)) return null
      return `mailto:${encodeURIComponent(emailOnly)}`
    }
    case 'mastodon': {
      const match = trimmedHandle.match(/^@?([^@]+)@([a-zA-Z0-9.-]+)$/)
      if (match) {
        return `https://${match[2]}/@${encodeURIComponent(match[1])}`
      }
      return null
    }
    case 'other':
      if (trimmedHandle.startsWith('http://') || trimmedHandle.startsWith('https://')) {
        try {
          const url = new URL(trimmedHandle)
          if (['http:', 'https:'].includes(url.protocol)) {
            return trimmedHandle
          }
        } catch {
          return null
        }
      }
      return null
    default:
      return null
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}

/**
 * Helper to fetch content by IDs, trying posts first and then replies for any not found.
 * Returns an array of Post objects (replies are converted to Post format for display).
 * Needed because quoted content can be either a post or a reply.
 */
async function fetchPostsOrReplies(ids: string[]): Promise<Post[]> {
  if (ids.length === 0) return []

  const { postService } = await import('@/lib/services')
  const { replyService } = await import('@/lib/services/reply-service')
  const { blogPostService } = await import('@/lib/services/blog-post-service')
  const { blogService } = await import('@/lib/services/blog-service')
  const { dpnsService } = await import('@/lib/services/dpns-service')
  const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

  // First try to fetch as posts
  const posts = await postService.getPostsByIds(ids)
  const foundPostIds = new Set(posts.map(p => p.id))

  // Find IDs that weren't found as posts
  const missingIds = ids.filter(id => !foundPostIds.has(id))

  if (missingIds.length === 0) {
    return posts
  }

  // Try to fetch missing IDs as replies
  const replies = await replyService.getRepliesByIds(missingIds)
  const foundReplyIds = new Set(replies.map(reply => reply.id))
  const remainingIds = missingIds.filter(id => !foundReplyIds.has(id))

  // Convert replies to Post format for display
  const convertedReplies: Post[] = replies.map(reply => ({
    id: reply.id,
    author: reply.author,
    content: reply.content,
    createdAt: reply.createdAt,
    likes: reply.likes,
    reposts: reply.reposts,
    replies: reply.replies,
    views: reply.views,
    liked: reply.liked,
    reposted: reply.reposted,
    bookmarked: reply.bookmarked,
    media: reply.media,
    encryptedContent: reply.encryptedContent,
    epoch: reply.epoch,
    nonce: reply.nonce,
    // Thread context fields
    parentId: reply.parentId,
    parentOwnerId: reply.parentOwnerId,
    // Enrichment metadata
    _enrichment: reply._enrichment,
  }))

  if (remainingIds.length === 0) {
    return [...posts, ...convertedReplies]
  }

  const blogPostResults = await Promise.allSettled(
    remainingIds.map(id => blogPostService.getPost(id))
  )
  const blogPosts = blogPostResults
    .filter((r): r is PromiseFulfilledResult<BlogPost | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((post): post is BlogPost => Boolean(post))

  const convertedBlogPosts: Post[] = await Promise.all(blogPosts.map(async (blogPost) => {
    const [blog, username, profile] = await Promise.all([
      blogService.getBlog(blogPost.blogId).catch((err) => {
        logger.warn('Failed to load quoted blog:', err)
        return null
      }),
      dpnsService.resolveUsername(blogPost.ownerId).catch((err) => {
        logger.warn('Failed to resolve quoted blog username:', err)
        return null
      }),
      unifiedProfileService.getProfile(blogPost.ownerId).catch((err) => {
        logger.warn('Failed to load quoted blog profile:', err)
        return null
      }),
    ])

    return {
      id: blogPost.id,
      author: {
        id: blogPost.ownerId,
        username: username || '',
        displayName: profile?.displayName || blog?.name || 'Blog author',
        avatar: profile?.avatar || blog?.avatar || '',
        followers: 0,
        following: 0,
        verified: false,
        joinedAt: new Date(0),
        hasDpns: typeof username === 'string' ? true : undefined,
      },
      content: blogPost.subtitle || blogPost.title,
      createdAt: blogPost.createdAt,
      likes: 0,
      reposts: 0,
      replies: 0,
      views: 0,
      liked: false,
      reposted: false,
      bookmarked: false,
      __isBlogPostQuote: true,
      title: blogPost.title,
      subtitle: blogPost.subtitle,
      coverImage: blogPost.coverImage,
      slug: blogPost.slug,
      blogId: blogPost.blogId,
      blogName: blog?.name,
      blogUsername: username || undefined,
      blogContent: blogPost.content,
    }
  }))

  return [...posts, ...convertedReplies, ...convertedBlogPosts]
}

function UserProfileContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const userId = searchParams.get('id')
  const { user: currentUser, logout } = useAuth()
  const { requireAuth } = useRequireAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

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
  const [profileDocumentMissing, setProfileDocumentMissing] = useState(false)

  // Pagination state
  const [hasMore, setHasMore] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [lastPostId, setLastPostId] = useState<string | null>(null)
  const [lastRepostId, setLastRepostId] = useState<string | null>(null)
  const [hasMoreReposts, setHasMoreReposts] = useState(true)

  // Edit profile state
  const [isEditingProfile, setIsEditingProfile] = useState(false)
  const [isEditingAvatar, setIsEditingAvatar] = useState(false)
  const [isEditingBanner, setIsEditingBanner] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)
  const [bannerKey, setBannerKey] = useState(0)
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

  // Username registration modal state
  const [isUsernameModalOpen, setIsUsernameModalOpen] = useState(false)

  // Block state - only check if viewing another user's profile
  const { isBlocked: isBlockedByMe, isLoading: blockLoading, toggleBlock } = useBlock(userId || '')

  // Tip modal
  const { openForUser: openTipModal } = useTipModal()

  // Tab state for Posts/Mentions/Blog
  const [activeTab, setActiveTab] = useState<'posts' | 'mentions' | 'blog'>('posts')
  const [postFilter, setPostFilter] = useState<'posts' | 'replies'>('posts')
  const [mentions, setMentions] = useState<Post[]>([])
  const [mentionsLoading, setMentionsLoading] = useState(false)
  const [mentionsLoaded, setMentionsLoaded] = useState(false)
  const [mentionCount, setMentionCount] = useState<number | null>(null)
  const [blogs, setBlogs] = useState<ProfileBlog[]>([])
  const [blogsLoading, setBlogsLoading] = useState(false)

  // User replies state (for replies tab)
  const [userReplies, setUserReplies] = useState<Post[]>([])
  const [repliesLoading, setRepliesLoading] = useState(false)
  const [repliesLoaded, setRepliesLoaded] = useState(false)

  // Private feed state
  const [hasPrivateFeed, setHasPrivateFeed] = useState(false)
  const [isPrivateFollower, setIsPrivateFollower] = useState(false)

  // Store state
  const [userStore, setUserStore] = useState<Store | null>(null)

  // Progressive enrichment for post metadata (likes, reposts, etc.)
  const { enrichProgressively, getPostEnrichment } = useProgressiveEnrichment({
    currentUserId: currentUser?.identityId
  })

  // Filter posts - all posts are now top-level (replies are a separate document type)
  const filteredPosts = useMemo(() => {
    if (postFilter === 'posts') {
      return posts.filter(p => !p.repostedBy)
    }
    // 'replies' filter - show user's replies from replyService
    return userReplies
  }, [posts, postFilter, userReplies])

  const displayName = profile?.displayName || (userId ? `User ${userId.slice(-6)}` : 'Unknown')

  // Check if display name is still in loading/fallback state
  const isDisplayNameLoading = isLoading || !profile?.displayName

  useEffect(() => {
    if (!userId) return

    const loadProfileData = async () => {
      try {
        setIsLoading(true)
        setProfileDocumentMissing(false)

        const { unifiedProfileService, postService, followService } = await import('@/lib/services')

        // Fetch profile from unified service, posts, and post count in parallel
        let profileFetchErrored = false
        const [profileResult, postsResult, totalPostCount] = await Promise.all([
          unifiedProfileService.getProfile(userId).catch(() => { profileFetchErrored = true; return null }),
          postService.getUserPosts(userId, { limit: 50 }).catch(() => ({ documents: [], hasMore: false })),
          postService.countUserPosts(userId).catch(() => 0)
        ])

        setPostCount(totalPostCount)

        // Track whether profile document is genuinely missing (not just a network error)
        setProfileDocumentMissing(!profileResult && !profileFetchErrored)

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
            bannerUri: profileResult.bannerUri,
            joinedAt: profileResult.joinedAt,
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

        // Check if user has a private feed (for profile indicator)
        try {
          const { privateFeedService, privateFeedFollowerService } = await import('@/lib/services')
          const hasPF = await privateFeedService.hasPrivateFeed(userId)
          setHasPrivateFeed(hasPF)

          // If they have a private feed and we're viewing someone else's profile,
          // check if we're an approved private follower
          if (hasPF && currentUser?.identityId && currentUser.identityId !== userId) {
            try {
              const accessStatus = await privateFeedFollowerService.getAccessStatus(userId, currentUser.identityId)
              // User is a private follower if approved (with or without local keys)
              setIsPrivateFollower(accessStatus === 'approved' || accessStatus === 'approved-no-keys')
            } catch (accessErr) {
              // Access status check is non-critical
              logger.error('Failed to check private feed access status:', accessErr)
              setIsPrivateFollower(false)
            }
          } else {
            // No private feed or viewing own profile - reset private follower state
            setIsPrivateFollower(false)
          }
        } catch (e) {
          // Private feed check is non-critical
          logger.error('Failed to check private feed status:', e)
          setHasPrivateFeed(false)
          setIsPrivateFollower(false)
        }

        // Check if user has a store
        try {
          const { storeService } = await import('@/lib/services/store-service')
          const store = await storeService.getByOwner(userId)
          setUserStore(store)
        } catch (e) {
          // Store check is non-critical
          logger.error('Failed to check store status:', e)
          setUserStore(null)
        }

        // Check if user has blogs and load counts for Blog tab
        setBlogsLoading(true)
        try {
          const { blogService, blogPostService } = await import('@/lib/services')
          const ownerBlogs = await blogService.getBlogsByOwner(userId)

          if (ownerBlogs.length > 0) {
            const blogsWithCounts = await Promise.all(ownerBlogs.map(async (blog) => {
              const blogPosts = await blogPostService.getPostsByBlog(blog.id, { limit: 1000 })
              return {
                id: blog.id,
                name: blog.name,
                description: blog.description,
                postCount: blogPosts.length,
              } as ProfileBlog
            }))
            setBlogs(blogsWithCounts)
          } else {
            setBlogs([])
          }
        } catch (blogError) {
          logger.error('Failed to load blogs for profile:', blogError)
          setBlogs([])
        } finally {
          setBlogsLoading(false)
        }

        // Process posts - postService.getUserPosts() returns already-transformed Post objects
        // We just need to update author display info for progressive enrichment
        const transformedPosts: Post[] = (postsResult.documents || []).map((post: Post) => ({
          ...post,
          author: {
            ...post.author,
            // Clear display fields - will be populated by progressive enrichment
            username: '',
            displayName: '',
            avatar: '',
            // undefined = still loading, will show skeleton in PostCard
            hasDpns: undefined,
          },
        }))

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
          logger.error('Failed to fetch user reposts:', repostError)
          // Continue without reposts - non-critical
        }

        // Fetch quoted posts for quote posts (can be posts or replies)
        try {
          const quotedPostIds = transformedPosts
            .filter((p: any) => p.quotedPostId)
            .map((p: any) => p.quotedPostId)

          if (quotedPostIds.length > 0) {
            const quotedPosts = await fetchPostsOrReplies(quotedPostIds)
            const quotedPostMap = new Map(quotedPosts.map(p => [p.id, p]))

            for (const post of transformedPosts) {
              if ((post as any).quotedPostId && quotedPostMap.has((post as any).quotedPostId)) {
                (post as any).quotedPost = quotedPostMap.get((post as any).quotedPostId)
              }
            }
          }
        } catch (quoteError) {
          logger.error('Failed to fetch quoted posts:', quoteError)
          // Continue without quoted posts - non-critical
        }

        if (transformedPosts.length > 0) {
          setPosts(transformedPosts)
          // Start progressive enrichment for post metadata
          enrichProgressively(transformedPosts)
        }

        // Set pagination state based on original posts (not reposts)
        const originalPosts = postsResult.documents || []
        if (originalPosts.length > 0) {
          const lastPost = originalPosts[originalPosts.length - 1]
          setLastPostId(lastPost.id)
        }
        // If we got fewer posts than requested, there are no more to load
        setHasMore(originalPosts.length >= 50)

        // Try to resolve DPNS usernames (fetch all, sort, use best as primary)
        try {
          const { dpnsService } = await import('@/lib/services/dpns-service')
          const usernames = await dpnsService.getAllUsernames(userId)
          if (usernames.length > 0) {
            // Sort usernames: contested first, then shortest, then alphabetically
            // This matches the selection logic used in other pages (resolveUsername, resolveUsernamesBatch)
            const sortedUsernames = await dpnsService.sortUsernamesByContested(usernames)
            setAllUsernames(sortedUsernames)
            setUsername(sortedUsernames[0])
            setHasDpns(true)
            // Update posts with hasDpns flag
            setPosts(currentPosts => currentPosts.map(post => ({
              ...post,
              author: {
                ...post.author,
                username: sortedUsernames[0],
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
        logger.error('Failed to load profile:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadProfileData().catch(err => logger.error('Failed to load profile:', err))
  // currentUser is intentionally not a dependency - we only want to reload on userId change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, enrichProgressively])

  // If own profile document is missing after load, verify identity and redirect
  useEffect(() => {
    if (!profileDocumentMissing || !isOwnProfile || !currentUser?.identityId || isLoading) return

    const checkIdentityAndRedirect = async () => {
      try {
        const { identityService } = await import('@/lib/services/identity-service')
        const identity = await identityService.getIdentity(currentUser.identityId)

        if (!identity) {
          toast.error('Your identity was not found on the network. Please log in again.')
          await logout()
          return
        }

        router.push('/profile/create')
      } catch (error) {
        // Network error checking identity - don't take drastic action
        logger.error('Failed to verify identity for profile check:', error)
      }
    }

    checkIdentityAndRedirect().catch(err => logger.error('Identity check failed:', err))
  }, [profileDocumentMissing, isOwnProfile, currentUser?.identityId, isLoading, logout, router])

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
      let newPostDocs: Post[] = []
      let newRepostDocs: any[] = []

      // Fetch more posts using cursor-based pagination
      if (canLoadMorePosts) {
        const postsResult = await postService.getUserPosts(userId, {
          limit: 50,
          startAfter: lastPostId
        })

        newPostDocs = postsResult.documents || []

        // postService.getUserPosts() returns already-transformed Post objects
        // We just update author display info (username/displayName already resolved for this profile)
        for (const post of newPostDocs) {
          newPosts.push({
            ...post,
            author: {
              ...post.author,
              // Use already-resolved username and displayName from profile
              username: username || '',
              displayName: profile?.displayName || '',
              avatar: '',
              hasDpns: hasDpns,
            },
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
          logger.error('Failed to fetch more reposts:', repostError)
          // Continue without reposts - non-critical
        }
      }

      // Fetch quoted posts for quote posts (can be posts or replies)
      try {
        const quotedPostIds = newPosts
          .filter((p: any) => p.quotedPostId)
          .map((p: any) => p.quotedPostId)

        if (quotedPostIds.length > 0) {
          const quotedPosts = await fetchPostsOrReplies(quotedPostIds)
          const quotedPostMap = new Map(quotedPosts.map(p => [p.id, p]))

          for (const post of newPosts) {
            if ((post as any).quotedPostId && quotedPostMap.has((post as any).quotedPostId)) {
              (post as any).quotedPost = quotedPostMap.get((post as any).quotedPostId)
            }
          }
        }
      } catch (quoteError) {
        logger.error('Failed to fetch quoted posts:', quoteError)
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
          const lastPost = newPostDocs[newPostDocs.length - 1] as Post
          setLastPostId(lastPost.id)
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
      logger.error('Failed to load more posts:', error)
    } finally {
      setIsLoadingMore(false)
    }
  }, [userId, isLoadingMore, hasMore, hasMoreReposts, lastPostId, lastRepostId, username, profile?.displayName, hasDpns, enrichProgressively])

  // Load mentions for this user (lazy load when tab is selected)
  const loadMentions = useCallback(async () => {
    if (!userId || mentionsLoaded) return

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
          logger.error('Failed to fetch post:', postId, error)
        }
      }

      // Sort by creation date (newest first)
      fetchedPosts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

      // Enrich posts with author data
      const enrichedPosts = await postService.enrichPostsBatch(fetchedPosts)

      setMentions(enrichedPosts)
      setMentionCount(enrichedPosts.length)
    } catch (error) {
      logger.error('Failed to load mentions:', error)
      setMentions([])
    } finally {
      setMentionsLoading(false)
      setMentionsLoaded(true)
    }
  }, [userId, mentionsLoaded])

  // Load user's replies (lazy load when filter is selected)
  const loadUserReplies = useCallback(async () => {
    if (!userId || repliesLoaded) return

    setRepliesLoading(true)
    try {
      const { replyService } = await import('@/lib/services/reply-service')

      const result = await replyService.getUserReplies(userId, { limit: 50 })

      if (result.documents.length === 0) {
        setUserReplies([])
        setRepliesLoaded(true)
        return
      }

      // Convert Reply objects to Post-compatible objects for PostCard display
      const replyPosts: Post[] = result.documents.map(reply => ({
        id: reply.id,
        author: reply.author,
        content: reply.content,
        createdAt: reply.createdAt,
        likes: reply.likes,
        reposts: reply.reposts,
        replies: reply.replies,
        views: reply.views,
        liked: reply.liked,
        reposted: reply.reposted,
        bookmarked: reply.bookmarked,
        media: reply.media,
        parentId: reply.parentId,
        parentOwnerId: reply.parentOwnerId,
        _enrichment: reply._enrichment,
      }))

      setUserReplies(replyPosts)

      // Enrich with progressive data (author info, etc.)
      enrichProgressively(replyPosts)
    } catch (error) {
      logger.error('Failed to load user replies:', error)
      setUserReplies([])
    } finally {
      setRepliesLoading(false)
      setRepliesLoaded(true)
    }
  }, [userId, repliesLoaded, enrichProgressively])

  // Load mentions when tab is activated
  useEffect(() => {
    if (activeTab === 'mentions' && !mentionsLoaded) {
      loadMentions().catch(err => logger.error('Failed to load mentions:', err))
    }
  }, [activeTab, mentionsLoaded, loadMentions])

  // Load user replies when filter is selected
  useEffect(() => {
    if (postFilter === 'replies' && !repliesLoaded) {
      loadUserReplies().catch(err => logger.error('Failed to load user replies:', err))
    }
  }, [postFilter, repliesLoaded, loadUserReplies])

  // Reset mentions, replies, post filter, private feed, and store state when user changes
  useEffect(() => {
    setMentions([])
    setMentionsLoaded(false)
    setMentionCount(null)
    setUserReplies([])
    setRepliesLoaded(false)
    setActiveTab('posts')
    setPostFilter('posts')
    setHasPrivateFeed(false)
    setIsPrivateFollower(false)
    setUserStore(null)
    setBlogs([])
    setBlogsLoading(false)
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
      logger.error('Follow error:', error)
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

  const handleTipUser = () => {
    const authedUser = requireAuth('tip')
    if (!authedUser || !userId) return
    openTipModal({
      id: userId,
      displayName: profile?.displayName,
      username: username || undefined,
    })
  }

  // Refresh DPNS usernames after registration
  const refreshUsernames = useCallback(async () => {
    if (!userId) return
    try {
      const { dpnsService } = await import('@/lib/services/dpns-service')
      // Clear cache to get fresh data (pass undefined for username, userId for identityId)
      dpnsService.clearCache(undefined, userId)
      const usernames = await dpnsService.getAllUsernames(userId)
      if (usernames.length > 0) {
        // Sort usernames: contested first, then shortest, then alphabetically
        // This matches the selection logic used in loadProfileData and resolveUsernamesBatch
        const sortedUsernames = await dpnsService.sortUsernamesByContested(usernames)
        setAllUsernames(sortedUsernames)
        setUsername(sortedUsernames[0])
        setHasDpns(true)
      } else {
        // No usernames found, reset state
        setAllUsernames([])
        setUsername('')
        setHasDpns(false)
      }
    } catch (e) {
      logger.error('Failed to refresh usernames:', e)
      // On error, reset to safe state
      setAllUsernames([])
      setUsername('')
      setHasDpns(false)
    }
  }, [userId])

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
      logger.error('Failed to update profile:', error)
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
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
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
            <div className="h-48 overflow-hidden blur-sm opacity-60">
              <BannerImage
                userId={userId || ''}
                className="w-full h-full"
                fallbackGradient
              />
            </div>
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
            {/* Banner */}
            <div className="relative h-48">
              <BannerImage
                key={bannerKey}
                userId={userId || ''}
                preloadedUrl={profile?.bannerUri}
                className="w-full h-full"
                fallbackGradient
              />
              {isOwnProfile && isEditingProfile && (
                <button
                  onClick={() => setIsEditingBanner(true)}
                  className="absolute bottom-3 right-3 z-10 p-2 bg-black/50 hover:bg-black/70 rounded-full transition-colors"
                  title="Edit banner"
                >
                  <PencilIcon className="h-4 w-4 text-white" />
                </button>
              )}
            </div>

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
                            navigator.clipboard.writeText(profileUrl).catch((error) => logger.error(error))
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
                    <div className="flex gap-2 items-center">
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <button
                              onClick={handleTipUser}
                              aria-label={`Tip ${profile?.displayName || username || 'user'}`}
                              className="p-2 rounded-full border border-gray-200 dark:border-gray-700 hover:bg-amber-50 dark:hover:bg-amber-950 hover:border-amber-300 dark:hover:border-amber-700 transition-colors group"
                            >
                              <CurrencyDollarIcon className="h-4 w-4 group-hover:text-amber-500" />
                            </button>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                              sideOffset={5}
                            >
                              Tip with credits
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      </Tooltip.Provider>
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
                      {/* Private Feed Access Button - only shown when following */}
                      <PrivateFeedAccessButton
                        ownerId={userId}
                        currentUserId={currentUser?.identityId || null}
                        isFollowing={isFollowing}
                        onRequireAuth={() => requireAuth('follow')}
                      />
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
                    <div className="flex items-center gap-2 flex-wrap">
                      {hasDpns && username ? (
                        <UsernameDropdown username={username} allUsernames={allUsernames} />
                      ) : (
                        <Tooltip.Provider>
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <button
                                onClick={() => {
                                  if (userId) {
                                    navigator.clipboard.writeText(userId).catch((error) => logger.error(error))
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
                      {isOwnProfile && (
                        <button
                          onClick={() => setIsUsernameModalOpen(true)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-yappr-600 dark:text-yappr-400 bg-yappr-50 dark:bg-yappr-950/30 hover:bg-yappr-100 dark:hover:bg-yappr-950/50 rounded-full transition-colors"
                        >
                          <UserPlusIcon className="h-3 w-3" />
                          {hasDpns ? 'Register More' : 'Register Username'}
                        </button>
                      )}
                      {/* Store Badge */}
                      {userStore && userStore.status === 'active' && (
                        <Tooltip.Provider>
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <button
                                onClick={() => router.push(`/store/view?id=${userStore.id}`)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-yappr-600 dark:text-yappr-400 bg-yappr-50 dark:bg-yappr-950/30 hover:bg-yappr-100 dark:hover:bg-yappr-950/50 rounded-full transition-colors"
                              >
                                <BuildingStorefrontIcon className="h-3 w-3" />
                                {userStore.name}
                              </button>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                              <Tooltip.Content
                                className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded max-w-xs"
                                sideOffset={5}
                              >
                                Visit {displayName}&apos;s store
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          </Tooltip.Root>
                        </Tooltip.Provider>
                      )}
                      {/* Private Feed Badge */}
                      {hasPrivateFeed && (
                        <Tooltip.Provider>
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-full">
                                <LockClosedIcon className="h-3 w-3" />
                                Private Feed
                              </span>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                              <Tooltip.Content
                                className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded max-w-xs"
                                sideOffset={5}
                              >
                                This user has a private feed. Follow them to request access.
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          </Tooltip.Root>
                        </Tooltip.Provider>
                      )}
                      {/* Private Follower Badge - shown when you have access to their private feed */}
                      {isPrivateFollower && (
                        <Tooltip.Provider>
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30 rounded-full">
                                <CheckIcon className="h-3 w-3" />
                                Private Follower
                              </span>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                              <Tooltip.Content
                                className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded max-w-xs"
                                sideOffset={5}
                              >
                                You have access to this user&apos;s private feed
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          </Tooltip.Root>
                        </Tooltip.Provider>
                      )}
                    </div>
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
                    {profile?.website && isValidHttpUrl(profile.website) && (
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
                      Joined {profile?.joinedAt
                        ? profile.joinedAt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                        : 'recently'}
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
                        {profile.socialLinks.map((link, index) => {
                          const url = getSocialLinkUrl(link.platform, link.handle)
                          const content = (
                            <>
                              <span className="font-medium capitalize">{link.platform}:</span>
                              <span className="text-gray-600 dark:text-gray-400">{link.handle}</span>
                            </>
                          )

                          if (url) {
                            return (
                              <a
                                key={index}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-sm hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                              >
                                {content}
                              </a>
                            )
                          }

                          return (
                            <span
                              key={index}
                              className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-sm"
                            >
                              {content}
                            </span>
                          )
                        })}
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
                {blogs.length > 0 && (
                  <button
                    onClick={() => setActiveTab('blog')}
                    className={cn(
                      'flex-1 py-4 text-center font-medium transition-colors relative',
                      activeTab === 'blog'
                        ? 'text-gray-900 dark:text-white'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    )}
                  >
                    Blog ({blogs.length})
                    {activeTab === 'blog' && (
                      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-14 h-1 bg-yappr-500 rounded-full" />
                    )}
                  </button>
                )}
              </div>

              {/* Tab Content */}
              {activeTab === 'posts' ? (
                // Posts Tab
                <>
                  {/* Post Filter Pills */}
                  <div className="flex gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                    <button
                      onClick={() => setPostFilter('posts')}
                      className={cn(
                        'px-3 py-1.5 text-sm font-medium rounded-full transition-colors',
                        postFilter === 'posts'
                          ? 'bg-yappr-500 text-white'
                          : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                      )}
                    >
                      Posts
                    </button>
                    <button
                      onClick={() => setPostFilter('replies')}
                      className={cn(
                        'px-3 py-1.5 text-sm font-medium rounded-full transition-colors',
                        postFilter === 'replies'
                          ? 'bg-yappr-500 text-white'
                          : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                      )}
                    >
                      Replies
                    </button>
                  </div>

                  {/* Posts List */}
                  {postFilter === 'replies' && repliesLoading ? (
                    <div className="p-8 text-center">
                      <Spinner size="md" className="mx-auto mb-4" />
                      <p className="text-gray-500">Loading replies...</p>
                    </div>
                  ) : filteredPosts.length === 0 ? (
                    <div className="p-8 text-center text-gray-500">
                      <p>{postFilter === 'posts' ? 'No original posts yet' : 'No replies yet'}</p>
                    </div>
                  ) : (
                    <div>
                      {filteredPosts.map((post) => (
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
                  )}
                </>
              ) : activeTab === 'mentions' ? (
                // Mentions Tab
                mentionsLoading ? (
                  <div className="p-8 text-center">
                    <Spinner size="md" className="mx-auto mb-4" />
                    <p className="text-gray-500">Loading mentions...</p>
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
              ) : blogsLoading ? (
                <div className="p-8 text-center">
                  <Spinner size="md" className="mx-auto mb-4" />
                  <p className="text-gray-500">Loading blogs...</p>
                </div>
              ) : blogs.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <p>No blogs yet</p>
                </div>
              ) : (
                <div className="p-4 space-y-3">
                  {blogs.map((blog) => (
                    <button
                      key={blog.id}
                      disabled={!username}
                      onClick={() => {
                        if (!username) return
                        router.push(`/blog?user=${encodeURIComponent(username)}&blog=${encodeURIComponent(blog.id)}`)
                      }}
                      className="w-full rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-950 p-4 text-left hover:border-gray-300 dark:hover:border-gray-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <p className="text-lg font-semibold">{blog.name}</p>
                      {blog.description && (
                        <p className="mt-1 text-sm text-gray-500">{blog.description}</p>
                      )}
                      <p className="mt-2 text-xs text-gray-500">{blog.postCount} posts</p>
                    </button>
                  ))}
                </div>
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

      {/* Banner Customization Modal */}
      {isEditingBanner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setIsEditingBanner(false)}
          />
          <div className="relative bg-white dark:bg-neutral-900 rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Customize Banner</h2>
              <button
                onClick={() => setIsEditingBanner(false)}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <BannerCustomization
              initialBannerUrl={profile?.bannerUri}
              onSave={(newBannerUrl) => {
                setIsEditingBanner(false)
                if (userId) {
                  invalidateBannerCache(userId)
                }
                setBannerKey(prev => prev + 1)
                // Update profile state with new banner URL
                setProfile(prev => prev ? { ...prev, bannerUri: newBannerUrl || undefined } : null)
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
        watchForTransaction={true}
        onDone={() => {
          setSelectedQrPayment(null)
          const url = new URL(window.location.href)
          url.searchParams.delete('tip')
          window.history.replaceState({}, '', url.toString())
        }}
      />

      {/* Username Registration Modal */}
      <UsernameModal
        isOpen={isUsernameModalOpen}
        onClose={() => {
          setIsUsernameModalOpen(false)
          refreshUsernames().catch(err => logger.error('Failed to refresh usernames:', err))
        }}
        hasExistingUsernames={hasDpns}
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
