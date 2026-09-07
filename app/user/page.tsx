'use client'

import { logger } from '@/lib/logger'
import { useState, useEffect, Suspense, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon, EyeSlashIcon, NoSymbolIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import type { Post, ParsedPaymentUri, Store } from '@/lib/types'
import { useSettingsStore } from '@/lib/store'
import { attachQuotedPosts } from '@/lib/feed/resolve-quoted-posts'
import { byNewestActivity, resolveUserReposts } from '@/lib/feed/resolve-user-reposts'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { useBlock } from '@/hooks/use-block'
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment'
import { useTipModal } from '@/hooks/use-tip-modal'
import { useProfileTabs } from '@/hooks/use-profile-tabs'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { Button } from '@/components/ui/button'
import { UserAvatar, invalidateAvatarImageCache } from '@/components/ui/avatar-image'
import { BannerImage, invalidateBannerCache } from '@/components/ui/banner-image'
import { PaymentQRCodeDialog } from '@/components/ui/payment-qr-dialog'
import { AvatarCustomization } from '@/components/settings/avatar-customization'
import { BannerCustomization } from '@/components/settings/banner-customization'
import { UsernameModal } from '@/components/dpns/username-modal'
import { ProfileHeader, type ProfileData } from '@/components/profile/profile-header'
import { ProfileTabs, type ProfileBlog } from '@/components/profile/profile-tabs'
import { ImageCustomizationModal } from '@/components/profile/image-customization-modal'
import { EMPTY_DRAFT, type ProfileDraft } from '@/components/profile/profile-edit-form'

const PAGE_SIZE = 50

/** Override the author display fields; blanks make progressive enrichment fill them in. */
function withAuthor(post: Post, fields: Partial<Post['author']>): Post {
  return { ...post, author: { ...post.author, ...fields } }
}

/** Set or clear a query parameter without a navigation. */
function replaceQueryParam(key: string, value: string | null) {
  const url = new URL(window.location.href)
  if (value) url.searchParams.set(key, value)
  else url.searchParams.delete(key)
  window.history.replaceState({}, '', url.toString())
}

function UserProfileContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const userId = searchParams.get('id')
  const { user: currentUser, logout } = useAuth()
  const viewerId = currentUser?.identityId
  const { requireAuth } = useRequireAuth()
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode)
  const isOwnProfile = viewerId === userId

  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [allUsernames, setAllUsernames] = useState<string[]>([])
  const hasDpns = allUsernames.length > 0
  const [posts, setPosts] = useState<Post[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [postCount, setPostCount] = useState<number | null>(null)
  const [profileDocumentMissing, setProfileDocumentMissing] = useState(false)
  const [isFollowing, setIsFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [hasPrivateFeed, setHasPrivateFeed] = useState(false)
  const [isPrivateFollower, setIsPrivateFollower] = useState(false)
  const [userStore, setUserStore] = useState<Store | null>(null)
  const [blogs, setBlogs] = useState<ProfileBlog[]>([])
  const [blogsLoading, setBlogsLoading] = useState(false)

  // Consent screen before any profile content renders, per visit. Applies in
  // both 'blur' and 'hide' modes: navigating here is deliberate, so a warning
  // beats a dead end. 'show' viewers skip it.
  const [nsfwAcknowledged, setNsfwAcknowledged] = useState(false)
  const showNsfwInterstitial = profile?.nsfw === true && !isOwnProfile && sensitiveContentMode !== 'show' && !nsfwAcknowledged

  // Posts-tab pagination: posts and reposts have separate cursors.
  const [hasMore, setHasMore] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [lastPostId, setLastPostId] = useState<string | null>(null)
  const [lastRepostId, setLastRepostId] = useState<string | null>(null)
  const [hasMoreReposts, setHasMoreReposts] = useState(true)

  // Editing (own profile only)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT)
  const [isSaving, setIsSaving] = useState(false)
  const [isEditingAvatar, setIsEditingAvatar] = useState(false)
  const [isEditingBanner, setIsEditingBanner] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)
  const [bannerKey, setBannerKey] = useState(0)

  const [selectedQrPayment, setSelectedQrPayment] = useState<ParsedPaymentUri | null>(null)
  const [isUsernameModalOpen, setIsUsernameModalOpen] = useState(false)

  const { isBlocked: isBlockedByMe, isLoading: blockLoading, toggleBlock } = useBlock(userId || '')
  const { openForUser: openTipModal } = useTipModal()
  const { enrichProgressively, getPostEnrichment } = useProgressiveEnrichment({ currentUserId: viewerId })
  const tabs = useProfileTabs(userId, enrichProgressively)

  const displayName = profile?.displayName || (userId ? `User ${userId.slice(-6)}` : 'Unknown')
  const isDisplayNameLoading = isLoading || !profile?.displayName

  useEffect(() => {
    setNsfwAcknowledged(false)
    setHasPrivateFeed(false)
    setIsPrivateFollower(false)
    setUserStore(null)
    setBlogs([])
    setBlogsLoading(false)
  }, [userId])

  useEffect(() => {
    if (!userId) return

    const loadProfileData = async () => {
      try {
        setIsLoading(true)
        setProfileDocumentMissing(false)
        const { unifiedProfileService, postService, followService } = await import('@/lib/services')

        let profileFetchErrored = false
        const [profileResult, postsResult, totalPostCount] = await Promise.all([
          unifiedProfileService.getProfile(userId).catch(() => {
            profileFetchErrored = true
            return null
          }),
          postService.getUserPosts(userId, { limit: PAGE_SIZE }).catch(() => ({ documents: [] as Post[], hasMore: false })),
          postService.countUserPosts(userId).catch(() => 0),
        ])
        setPostCount(totalPostCount)
        // Genuinely absent, as opposed to a failed fetch.
        setProfileDocumentMissing(!profileResult && !profileFetchErrored)

        const [followersCount, followingCount] = await Promise.all([followService.countFollowers(userId), followService.countFollowing(userId)])
        const profileDisplayName = profileResult?.displayName || `User ${userId.slice(-6)}`
        setProfile(
          profileResult
            ? {
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
              }
            : { displayName: profileDisplayName, followersCount, followingCount }
        )

        if (viewerId && viewerId !== userId) {
          setIsFollowing(await followService.isFollowing(userId, viewerId))
        }

        // The private-feed, store and blog lookups decorate the header; none may fail the page.
        try {
          const { privateFeedService, privateFeedFollowerService } = await import('@/lib/services')
          const hasPF = await privateFeedService.hasPrivateFeed(userId)
          setHasPrivateFeed(hasPF)
          if (hasPF && viewerId && viewerId !== userId) {
            try {
              const access = await privateFeedFollowerService.getAccessStatus(userId, viewerId)
              setIsPrivateFollower(access === 'approved' || access === 'approved-no-keys')
            } catch (accessErr) {
              logger.error('Failed to check private feed access status:', accessErr)
              setIsPrivateFollower(false)
            }
          } else {
            setIsPrivateFollower(false)
          }
        } catch (e) {
          logger.error('Failed to check private feed status:', e)
          setHasPrivateFeed(false)
          setIsPrivateFollower(false)
        }

        try {
          const { storeService } = await import('@/lib/services/store-service')
          setUserStore(await storeService.getByOwner(userId))
        } catch (e) {
          logger.error('Failed to check store status:', e)
          setUserStore(null)
        }

        setBlogsLoading(true)
        try {
          const { blogService, blogPostService } = await import('@/lib/services')
          const ownerBlogs = await blogService.getBlogsByOwner(userId)
          // Dash Platform has no count API; 100 posts is an intentional cap.
          const results = await Promise.allSettled(
            ownerBlogs.map(async (blog): Promise<ProfileBlog> => {
              const blogPosts = await blogPostService.getPostsByBlog(blog.id, { limit: 100 })
              return { id: blog.id, name: blog.name, description: blog.description, postCount: blogPosts.length }
            })
          )
          setBlogs(results.filter((r): r is PromiseFulfilledResult<ProfileBlog> => r.status === 'fulfilled').map((r) => r.value))
        } catch (blogError) {
          logger.error('Failed to load blogs for profile:', blogError)
          setBlogs([])
        } finally {
          setBlogsLoading(false)
        }

        const merged: Post[] = (postsResult.documents || []).map((post) =>
          withAuthor(post, { username: '', displayName: '', avatar: '', hasDpns: undefined })
        )
        try {
          const { repostService } = await import('@/lib/services/repost-service')
          const reposts = await repostService.getUserReposts(userId)
          if (reposts.length > 0) setLastRepostId(reposts[reposts.length - 1].$id)
          setHasMoreReposts(reposts.length >= PAGE_SIZE)
          merged.push(...(await resolveUserReposts(userId, reposts, profileDisplayName)))
          merged.sort(byNewestActivity)
        } catch (repostError) {
          logger.error('Failed to fetch user reposts:', repostError)
        }

        await attachQuotedPosts(merged)
        if (merged.length > 0) {
          setPosts(merged)
          enrichProgressively(merged)
        }

        const originals = postsResult.documents || []
        if (originals.length > 0) setLastPostId(originals[originals.length - 1].id)
        setHasMore(originals.length >= PAGE_SIZE)

        try {
          const { dpnsService } = await import('@/lib/services/dpns-service')
          const sorted = await dpnsService.getAllUsernamesSorted(userId)
          setAllUsernames(sorted)
          setUsername(sorted[0] ?? null)
          if (sorted.length > 0) {
            setPosts((current) => current.map((post) => withAuthor(post, { username: sorted[0], hasDpns: true })))
          }
        } catch {
          setAllUsernames([])
          setUsername(null)
        }
      } catch (error) {
        logger.error('Failed to load profile:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadProfileData().catch((err) => logger.error('Failed to load profile:', err))
    // Reload on a profile change only; the viewer changing mid-visit is not worth a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, enrichProgressively])

  // An owner whose profile document is missing is sent to create one, unless
  // the identity itself is gone, in which case the session is stale.
  useEffect(() => {
    if (!profileDocumentMissing || !isOwnProfile || !viewerId || isLoading) return
    const check = async () => {
      try {
        const { identityService } = await import('@/lib/services/identity-service')
        if (!(await identityService.getIdentity(viewerId))) {
          toast.error('Your identity was not found on the network. Please log in again.')
          await logout()
          return
        }
        router.push('/profile/create')
      } catch (error) {
        logger.error('Failed to verify identity for profile check:', error)
      }
    }
    check().catch((err) => logger.error('Identity check failed:', err))
  }, [profileDocumentMissing, isOwnProfile, viewerId, isLoading, logout, router])

  const startEdit = useCallback(() => {
    setDraft({
      displayName: profile?.displayName || '',
      bio: profile?.bio || '',
      location: profile?.location || '',
      website: profile?.website || '',
      pronouns: profile?.pronouns || '',
      nsfw: profile?.nsfw || false,
      paymentUris: profile?.paymentUris?.map((p) => p.uri) || [],
      socialLinks: profile?.socialLinks || [],
    })
    setIsEditing(true)
  }, [profile])

  const cancelEdit = () => {
    setIsEditing(false)
    setDraft(EMPTY_DRAFT)
  }

  // `?edit=true` deep-links into edit mode once, then drops the parameter.
  useEffect(() => {
    if (!isOwnProfile || isLoading) return
    if (searchParams.get('edit') === 'true' && !isEditing) {
      startEdit()
      replaceQueryParam('edit', null)
    }
  }, [isOwnProfile, isLoading, searchParams, isEditing, startEdit])

  // `?tip=<uri>` deep-links to one of the profile's payment addresses.
  useEffect(() => {
    const tipUri = searchParams.get('tip')
    if (!tipUri || !profile?.paymentUris?.length) return
    const match = profile.paymentUris.find((p) => p.uri === tipUri)
    if (match) setSelectedQrPayment(match)
  }, [profile?.paymentUris, searchParams])

  const loadMorePosts = useCallback(async () => {
    const canLoadMorePosts = hasMore && lastPostId
    const canLoadMoreReposts = hasMoreReposts && lastRepostId
    if (!userId || isLoadingMore || (!canLoadMorePosts && !canLoadMoreReposts)) return

    setIsLoadingMore(true)
    try {
      const { postService } = await import('@/lib/services')
      const { repostService } = await import('@/lib/services/repost-service')
      const fresh: Post[] = []
      let newPostDocs: Post[] = []

      if (canLoadMorePosts) {
        const result = await postService.getUserPosts(userId, { limit: PAGE_SIZE, startAfter: lastPostId })
        newPostDocs = result.documents || []
        // Author display fields are already resolved for this profile.
        fresh.push(...newPostDocs.map((post) => withAuthor(post, { username: username || '', displayName: profile?.displayName || '', avatar: '', hasDpns })))
      }

      if (canLoadMoreReposts) {
        try {
          const reposts = await repostService.getUserReposts(userId)
          // An empty display name reads as "Someone reposted" on the card.
          fresh.push(...(await resolveUserReposts(userId, reposts, profile?.displayName || '')))
          if (reposts.length > 0) setLastRepostId(reposts[reposts.length - 1].$id)
          setHasMoreReposts(reposts.length >= PAGE_SIZE)
        } catch (repostError) {
          logger.error('Failed to fetch more reposts:', repostError)
        }
      }

      await attachQuotedPosts(fresh)
      setPosts((current) => {
        const seen = new Set(current.map((p) => p.id))
        return [...current, ...fresh.filter((p) => !seen.has(p.id))].sort(byNewestActivity)
      })
      if (fresh.length > 0) enrichProgressively(fresh)

      if (canLoadMorePosts) {
        if (newPostDocs.length > 0) setLastPostId(newPostDocs[newPostDocs.length - 1].id)
        setHasMore(newPostDocs.length >= PAGE_SIZE)
      }
    } catch (error) {
      logger.error('Failed to load more posts:', error)
    } finally {
      setIsLoadingMore(false)
    }
  }, [userId, isLoadingMore, hasMore, hasMoreReposts, lastPostId, lastRepostId, username, profile?.displayName, hasDpns, enrichProgressively])

  const hasMorePosts = hasMore || hasMoreReposts
  const infiniteScroll = useInfiniteScroll({
    hasMore: hasMorePosts,
    isLoading: isLoadingMore,
    onLoadMore: loadMorePosts,
    disabled: tabs.activeTab !== 'posts',
    resetKey: userId,
  })

  const handleFollow = async () => {
    const authedUser = requireAuth()
    if (!authedUser || !userId) return
    setFollowLoading(true)
    try {
      const { followService } = await import('@/lib/services')
      const result = isFollowing ? await followService.unfollowUser(authedUser.identityId, userId) : await followService.followUser(authedUser.identityId, userId)
      if (!result.success) throw new Error(result.error || 'Follow failed')
      const delta = isFollowing ? -1 : 1
      setIsFollowing(!isFollowing)
      setProfile((prev) => (prev ? { ...prev, followersCount: Math.max(0, prev.followersCount + delta) } : null))
      toast.success(isFollowing ? 'Unfollowed' : 'Following!')
    } catch (error) {
      logger.error('Follow error:', error)
      toast.error('Failed to update follow status')
    } finally {
      setFollowLoading(false)
    }
  }

  const handleTipUser = () => {
    const authedUser = requireAuth()
    if (!authedUser || !userId) return
    openTipModal({ id: userId, displayName: profile?.displayName, username: username || undefined })
  }

  const refreshUsernames = useCallback(async () => {
    if (!userId) return
    try {
      const { dpnsService } = await import('@/lib/services/dpns-service')
      dpnsService.clearCache(undefined, userId)
      const sorted = await dpnsService.getAllUsernamesSorted(userId)
      setAllUsernames(sorted)
      setUsername(sorted[0] ?? null)
    } catch (e) {
      logger.error('Failed to refresh usernames:', e)
      setAllUsernames([])
      setUsername(null)
    }
  }, [userId])

  const handleSaveProfile = async () => {
    if (!viewerId) return
    setIsSaving(true)
    try {
      const { unifiedProfileService } = await import('@/lib/services')
      await unifiedProfileService.updateProfile(viewerId, draft)
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              ...draft,
              paymentUris: draft.paymentUris.map((uri) => ({ scheme: uri.split(':')[0] + ':', uri })),
            }
          : null
      )
      setIsEditing(false)
      toast.success('Profile updated!')
    } catch (error) {
      logger.error('Failed to update profile:', error)
      toast.error('Failed to update profile')
    } finally {
      setIsSaving(false)
    }
  }

  const closeQrDialog = () => {
    setSelectedQrPayment(null)
    replaceQueryParam('tip', null)
  }

  if (!userId) {
    return (
      <PageShell>
        <div className="p-8 text-center text-gray-500">
          <p>User not found</p>
        </div>
      </PageShell>
    )
  }

  return (
    <>
      <PageShell>
        <PageHeader borderless>
          <div className="flex items-center gap-4 px-4 py-3">
            <button onClick={() => router.back()} className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900">
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <div className="flex-1">
              {isDisplayNameLoading ? (
                <div className="h-6 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-1" />
              ) : (
                <h1 className="text-xl font-extrabold">{displayName}</h1>
              )}
              <p className="text-sm text-gray-500">{postCount !== null ? postCount : '–'} posts</p>
            </div>
          </div>
        </PageHeader>

        {isLoading ? (
          <div>
            <div className="h-48 overflow-hidden blur-sm opacity-60">
              <BannerImage userId={userId} className="w-full h-full" fallbackGradient />
            </div>
            <div className="px-4 pb-4">
              <div className="relative -mt-16 mb-4">
                <div className="h-32 w-32 rounded-full bg-white dark:bg-neutral-900 p-1">
                  <div className="h-full w-full rounded-full overflow-hidden blur-sm opacity-60">
                    <UserAvatar userId={userId} alt="Loading..." size="full" />
                  </div>
                </div>
              </div>
              <div className="h-6 w-48 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-2" />
              <div className="h-4 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            </div>
          </div>
        ) : showNsfwInterstitial ? (
          <div data-testid="nsfw-interstitial" className="flex flex-col items-center justify-center gap-4 px-8 py-24 text-center">
            <EyeSlashIcon className="h-12 w-12 text-gray-400" />
            <div>
              <h2 className="text-xl font-semibold mb-1">This profile may contain adult content</h2>
              <p className="text-sm text-gray-500">{profile?.displayName || 'This user'} marked their profile as NSFW.</p>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={() => router.back()}>
                Go back
              </Button>
              <Button data-testid="nsfw-interstitial-view" onClick={() => setNsfwAcknowledged(true)}>
                View profile
              </Button>
            </div>
          </div>
        ) : (
          <>
            <ProfileHeader
              userId={userId}
              profile={profile}
              displayName={displayName}
              isDisplayNameLoading={isDisplayNameLoading}
              username={username}
              allUsernames={allUsernames}
              viewerId={viewerId || null}
              avatarKey={avatarKey}
              bannerKey={bannerKey}
              userStore={userStore}
              hasPrivateFeed={hasPrivateFeed}
              isPrivateFollower={isPrivateFollower}
              isFollowing={isFollowing}
              followLoading={followLoading}
              onFollow={handleFollow}
              onTip={handleTipUser}
              onRequireAuth={() => requireAuth()}
              onOpenUsernameModal={() => setIsUsernameModalOpen(true)}
              onSelectPayment={(payment) => {
                setSelectedQrPayment(payment)
                replaceQueryParam('tip', payment.uri)
              }}
              edit={{
                active: isEditing,
                draft,
                onChange: setDraft,
                isSaving,
                onStart: startEdit,
                onCancel: cancelEdit,
                onSave: handleSaveProfile,
                onEditAvatar: () => setIsEditingAvatar(true),
                onEditBanner: () => setIsEditingBanner(true),
              }}
            />

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
                  <Button variant="outline" size="sm" onClick={() => toggleBlock()} disabled={blockLoading}>
                    Unblock
                  </Button>
                </div>
              </div>
            )}

            <ProfileTabs
              activeTab={tabs.activeTab}
              onTabChange={tabs.setActiveTab}
              viewerId={viewerId}
              getPostEnrichment={getPostEnrichment}
              posts={posts.filter((p) => !p.repostedBy)}
              replies={tabs.replies}
              top={tabs.top}
              mentions={tabs.mentions}
              blogs={{ blogs, loading: blogsLoading }}
              pagination={{
                hasMore: hasMorePosts,
                isLoading: isLoadingMore,
                isSuspended: infiniteScroll.isSuspended,
                sentinelRef: infiniteScroll.sentinelRef,
                onLoadMore: infiniteScroll.loadMore,
              }}
            />
          </>
        )}
      </PageShell>

      <ImageCustomizationModal open={isEditingAvatar} title="Customize Avatar" onClose={() => setIsEditingAvatar(false)}>
        <AvatarCustomization
          compact
          onSave={() => {
            setIsEditingAvatar(false)
            invalidateAvatarImageCache(userId)
            setAvatarKey((k) => k + 1)
          }}
        />
      </ImageCustomizationModal>

      <ImageCustomizationModal open={isEditingBanner} title="Customize Banner" onClose={() => setIsEditingBanner(false)}>
        <BannerCustomization
          initialBannerUrl={profile?.bannerUri}
          onSave={(newBannerUrl) => {
            setIsEditingBanner(false)
            invalidateBannerCache(userId)
            setBannerKey((k) => k + 1)
            setProfile((prev) => (prev ? { ...prev, bannerUri: newBannerUrl || undefined } : null))
          }}
        />
      </ImageCustomizationModal>

      <PaymentQRCodeDialog
        isOpen={!!selectedQrPayment}
        onClose={closeQrDialog}
        paymentUri={selectedQrPayment}
        recipientName={username || displayName}
        watchForTransaction={true}
        onDone={closeQrDialog}
      />

      <UsernameModal
        isOpen={isUsernameModalOpen}
        onClose={() => {
          setIsUsernameModalOpen(false)
          refreshUsernames().catch((err) => logger.error('Failed to refresh usernames:', err))
        }}
        hasExistingUsernames={hasDpns}
      />
    </>
  )
}

function LoadingFallback() {
  return (
    <PageShell>
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
    </PageShell>
  )
}

export default function UserProfilePage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <UserProfileContent />
    </Suspense>
  )
}
