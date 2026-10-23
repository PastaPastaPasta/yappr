'use client'

import { logger } from '@/lib/logger'
import bs58 from 'bs58'
import { useState, useEffect, useRef, Suspense, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon, EyeSlashIcon, NoSymbolIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import type { Post, ParsedPaymentUri, Store } from '@/lib/types'
import { useSettingsStore } from '@/lib/store'
import { followStatusCache } from '@/lib/caches/user-status-cache'
import { attachQuotedPosts } from '@/lib/feed/resolve-quoted-posts'
import { byNewestActivity, resolveUserReposts } from '@/lib/feed/resolve-user-reposts'
import { isBareRepost } from '@/lib/feed/quote-reposts'
import { repostsAreQuotes } from '@/lib/contract-topology'
import { withoutHiddenTombstones } from '@/lib/feed/hidden-tombstones'
import { paymentUriScheme } from '@/lib/services/unified-profile-service'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { profileModerationReadStep } from '@/lib/profile/profile-moderation-read'
import { appendProfilePostsPage, commitProfileFirstPage, emptyProfilePosts, profilePostsScope } from '@/lib/profile/profile-posts-state'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { useBlockProvenance } from '@/hooks/use-block'
import { useModeratedTypeOpen } from '@/hooks/use-moderated-type-open'
import { useModerationRole } from '@/hooks/use-is-moderator'
import { useAuthorRestricted } from '@/hooks/use-author-restriction'
import type { ModeratorHideOutcome } from '@/hooks/use-moderator-hide-modal'
import { HiddenContentStub, ModerationLabel } from '@/components/moderation/moderation-label'
import { ModeratorContentMenu } from '@/components/moderation/moderator-content-menu'
import { isHidden, moderationViewAll, type ModerationMarks } from '@/lib/moderation-view'
import { moderationService } from '@/lib/services/moderation-service'
import { POSTING_CLOSED_COPY } from '@/lib/error-utils'
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment'
import { useTipModal } from '@/hooks/use-tip-modal'
import { YappFlow } from '@/components/profile/yapp-flow'
import { useProfileTabs } from '@/hooks/use-profile-tabs'
import { useProfileCreatedPosts } from '@/hooks/use-profile-created-posts'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { Button } from '@/components/ui/button'
import { UserAvatar, invalidateAvatarImageCache } from '@/components/ui/avatar-image'
import { BannerImage, invalidateBannerCache } from '@/components/ui/banner-image'
import { PaymentQRCodeDialog } from '@/components/ui/payment-qr-dialog'
import { UsernameModal } from '@/components/dpns/username-modal'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { ProfileHeader, type ProfileData } from '@/components/profile/profile-header'
import { ProfileTabs, type ProfileBlog } from '@/components/profile/profile-tabs'
import { ProfileModerationPanel } from '@/components/profile/profile-moderation-panel'
import { useIsSeatedModerator } from '@/hooks/use-moderator-view'
import { EditProfileModal } from '@/components/profile/edit-profile-modal'
import type { ProfileDraft } from '@/components/profile/profile-edit-form'
import { ListLimitError } from '@/lib/typed-array-codecs'
import { isPublishedBlogPost } from '@/lib/blog/content-utils'
import { profileTextLimits } from '@/lib/profile/v10-profile'

const PAGE_SIZE = 50

/** A profile route accepts only a 32-byte Platform identifier. */
function profileIdentityId(value: string | null): string | null {
  if (!value) return null
  try {
    return bs58.decode(value).length === 32 ? value : null
  } catch {
    return null
  }
}

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

/**
 * Everything the view holds (profile, posts, cursor, follow state, tabs) is
 * read for one profile as one viewer sees it. Keying the view by both resets
 * all of it at once when either changes, so a profile never renders under
 * another's header and a read still out for the old key lands on a dead view.
 */
function UserProfileContent() {
  const searchParams = useSearchParams()
  const requestedUserId = searchParams.get('id')
  const userId = profileIdentityId(requestedUserId)
  const { user: currentUser } = useAuth()
  const viewerId = currentUser?.identityId
  return <UserProfileView key={`${userId ?? ''}:${viewerId ?? ''}`} requestedUserId={requestedUserId} userId={userId} />
}

function UserProfileView({ requestedUserId, userId }: { requestedUserId: string | null; userId: string | null }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user: currentUser, logout, isAuthRestoring } = useAuth()
  const viewerId = currentUser?.identityId
  const { requireAuth } = useRequireAuth()
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode)
  const isOwnProfile = viewerId === userId

  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [allUsernames, setAllUsernames] = useState<string[]>([])
  const hasDpns = allUsernames.length > 0
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

  // Posts-tab pagination. Reposts are not paginated: the service returns the
  // whole list on the first load, so only original posts page.
  const [postsState, setPostsState] = useState(() => emptyProfilePosts(''))
  const { posts, hasMore, lastPostId } = postsState
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  // The load generation whose posts are current: a first page or a next page
  // started under another one (a reload, or this view going away) is dropped.
  const loadGenerationRef = useRef(0)
  const currentScopeRef = useRef('')

  // Editing (own profile only): the profile the dialog opened with, or null when closed.
  const [editInitial, setEditInitial] = useState<ProfileDraft | null>(null)
  const isEditing = editInitial !== null
  const [isSaving, setIsSaving] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)
  const [bannerKey, setBannerKey] = useState(0)

  const [selectedQrPayment, setSelectedQrPayment] = useState<ParsedPaymentUri | null>(null)
  const [isUsernameModalOpen, setIsUsernameModalOpen] = useState(false)

  const { isBlocked: isBlockedByMe, isOwnBlock, isLoading: blockLoading, unblock } = useBlockProvenance(userId ?? undefined)
  const profileWritable = useModeratedTypeOpen('yapprProfile')
  const { openForUser: openTipModal } = useTipModal()
  const { enrichProgressively, getPostEnrichment } = useProgressiveEnrichment({ currentUserId: viewerId })
  const tabs = useProfileTabs(userId, enrichProgressively)
  const published = useProfileCreatedPosts(userId, posts, enrichProgressively)
  const displayedPostCount = published.count === null ? postCount : Math.max(postCount ?? 0, published.count)

  const dpnsLabel = username?.replace(/\.dash$/, '')
  const displayName = (profileDocumentMissing && dpnsLabel) || profile?.displayName || (userId ? `User ${userId.slice(-6)}` : 'Unknown')
  const isDisplayNameLoading = isLoading || !profile?.displayName
  let documentTitle: string | null = null
  if (!isLoading) documentTitle = dpnsLabel ? `${displayName} (@${dpnsLabel})` : displayName
  useDocumentTitle(documentTitle)

  // Social v18: the moderators may hide the profile extension (`yapprProfile`)
  // or restrict the account. Its moderators (and everyone on an archival
  // build) see it labelled; everyone else sees the DPNS name and a calm note
  // in place of the extension's fields.
  const hidesProfiles = moderationService.hidesInsteadOfDeleting() && moderationService.canHide('yapprProfile')
  const { isModerator } = useModerationRole()
  const seesHidden = moderationViewAll() || isModerator
  // The Moderation tab: the account's hidden and restricted posts, for the social contract's seated team.
  const seatedSocialModerator = useIsSeatedModerator('social')
  const [profileModeration, setProfileModeration] = useState<{ documentId: string; moderation: ModerationMarks } | null>(null)
  /**
   * Where that read stands. The header waits for it (the skeleton stays), so
   * a hidden profile's fields never flash, and a read that failed counts as
   * hidden for everyone who is not shown hidden content (fail closed).
   */
  const [profileModerationRead, setProfileModerationRead] = useState<'pending' | 'done' | 'failed'>('pending')
  const authorRestricted = useAuthorRestricted('social', userId, hidesProfiles && seesHidden)
  const [restrictedHere, setRestrictedHere] = useState<boolean | null>(null)
  const { isReady: sdkReady, error: sdkError } = useSdk()
  useEffect(() => {
    setProfileModeration(null)
    setRestrictedHere(null)
    // Waits for the SDK: a cold signed-out visit mounts before it is configured.
    const step = profileModerationReadStep({ hidesProfiles, userId, sdkReady, sdkError })
    if (step !== 'read') {
      setProfileModerationRead(step.settle)
      return
    }
    if (!userId) return
    setProfileModerationRead('pending')
    let cancelled = false
    moderationService.readProfileModeration(userId).then((read) => {
      if (cancelled) return
      setProfileModeration(read)
      setProfileModerationRead('done')
    }).catch((error: unknown) => {
      logger.warn('Profile: could not read the profile\'s moderation', error)
      if (!cancelled) setProfileModerationRead('failed')
    })
    return () => {
      cancelled = true
    }
  }, [hidesProfiles, userId, sdkReady, sdkError])
  const profileHidden = isHidden(profileModeration?.moderation)
  const showsHiddenProfileStub = (profileHidden || profileModerationRead === 'failed') && !seesHidden
  const awaitingProfileModeration = profileModerationRead === 'pending'
  const onProfileModerated = (outcome: ModeratorHideOutcome) => {
    if (outcome.restricted !== undefined) setRestrictedHere(outcome.restricted)
    // The marks are read fresh above, never from the profile cache, so only this state moves.
    if (outcome.moderation !== undefined) setProfileModeration((current) => current && { ...current, moderation: outcome.moderation ?? {} })
  }

  useEffect(() => {
    // Wait for the stored session: starting before it resolves read everything
    // twice, once anonymously and again once the viewer was known.
    if (!userId || isAuthRestoring) return
    // A load still out when this view goes away must not write into it.
    let cancelled = false
    const scope = profilePostsScope(userId, viewerId, ++loadGenerationRef.current)
    currentScopeRef.current = scope
    setPostsState(emptyProfilePosts(scope))
    setIsLoadingMore(false)

    // The private-feed, store and blog lookups decorate the header; none may fail the page.
    const loadPrivateFeed = async () => {
      try {
        const { privateFeedService, privateFeedFollowerService } = await import('@/lib/services')
        const hasPF = await privateFeedService.hasPrivateFeed(userId)
        if (cancelled) return
        setHasPrivateFeed(hasPF)
        if (hasPF && viewerId && viewerId !== userId) {
          try {
            const access = await privateFeedFollowerService.getAccessStatus(userId, viewerId)
            if (cancelled) return
            setIsPrivateFollower(access === 'approved' || access === 'approved-no-keys')
          } catch (accessErr) {
            logger.error('Failed to check private feed access status:', accessErr)
            if (!cancelled) setIsPrivateFollower(false)
          }
        } else {
          setIsPrivateFollower(false)
        }
      } catch (e) {
        logger.error('Failed to check private feed status:', e)
        if (cancelled) return
        setHasPrivateFeed(false)
        setIsPrivateFollower(false)
      }
    }

    const loadStore = async () => {
      try {
        const { storeService } = await import('@/lib/services/store-service')
        const store = await storeService.getByOwner(userId)
        if (!cancelled) setUserStore(store)
      } catch (e) {
        logger.error('Failed to check store status:', e)
        if (!cancelled) setUserStore(null)
      }
    }

    const loadBlogs = async () => {
      setBlogsLoading(true)
      try {
        const { blogService, blogPostService } = await import('@/lib/services')
        const ownerBlogs = await blogService.getBlogsByOwner(userId)
        // Preserve the existing 100-post display cap for each blog.
        const pages = await blogPostService.getPostsByBlogs(ownerBlogs.map(blog => blog.id), 100)
        if (cancelled) return
        setBlogs(ownerBlogs.map(blog => ({
          id: blog.id, name: blog.name, description: blog.description,
          // Drafts are not public; the owner's dashboard counts them.
          postCount: pages.get(blog.id)?.filter(isPublishedBlogPost).length ?? 0,
        })))
      } catch (blogError) {
        logger.error('Failed to load blogs for profile:', blogError)
        if (!cancelled) setBlogs([])
      } finally {
        if (!cancelled) setBlogsLoading(false)
      }
    }

    const loadProfileData = async () => {
      try {
        setIsLoading(true)
        setProfileDocumentMissing(false)
        // The badges and the blogs tab need nothing the header reads, so they
        // start with it and fill in whenever they land. They never reject.
        const decorations = Promise.all([loadPrivateFeed(), loadStore(), loadBlogs()])

        const { unifiedProfileService, postService, followService } = await import('@/lib/services')
        const { loadUserStats } = await import('@/lib/services/social-stats-service')

        const statsRead = loadUserStats(userId)
        // A failed read is flagged so it is never taken for a profile with no posts.
        const postsRead = postService.getUserPosts(userId, { limit: PAGE_SIZE, forDisplay: true })
          .then((result) => ({ ...result, failed: false }))
          .catch((postsError: unknown) => {
            logger.error('Failed to load profile posts:', postsError)
            return { documents: [] as Post[], preloaded: undefined, failed: true }
          })
        // The stats read seeds the base profile and the posts read its
        // extension, so the profile follows both (the header waits for both
        // anyway) and is then usually answered from cache. A failed stats read
        // still lets the profile be read; a failed profile read is null, which
        // startEdit re-checks strictly before an owner edits from it.
        const profileRead = Promise.all([statsRead.catch(() => undefined), postsRead])
          .then(() => unifiedProfileService.getProfile(userId))
          .catch(() => null)

        const loadPosts = async (): Promise<Post[]> => {
          const postsResult = await postsRead
          const merged: Post[] = (postsResult.documents || []).map((post) =>
            withAuthor(post, { username: '', displayName: '', avatar: '', hasDpns: undefined })
          )
          // v10 has no repost documents: the user's reposts are bare quote
          // posts, already in their posts above.
          if (!repostsAreQuotes()) {
            try {
              const { repostService } = await import('@/lib/services/repost-service')
              const reposts = await repostService.getUserReposts(userId)
              const profileDisplayName = (await profileRead)?.displayName || `User ${userId.slice(-6)}`
              merged.push(...(await resolveUserReposts(userId, reposts, profileDisplayName)))
              merged.sort(byNewestActivity)
            } catch (repostError) {
              logger.error('Failed to fetch user reposts:', repostError)
            }
          }
          await attachQuotedPosts(merged)
          return merged
        }
        const loadUsernames = async (): Promise<string[]> => {
          try {
            const { dpnsService } = await import('@/lib/services/dpns-service')
            return await dpnsService.getAllUsernamesSorted(userId)
          } catch {
            return []
          }
        }

        // The header waits for the stats, profile, names, follow state and the posts tab.
        const [statsResult, postsResult, profileResult, sortedUsernames, merged, viewerFollows] = await Promise.all([
          statsRead,
          postsRead,
          profileRead,
          loadUsernames(),
          loadPosts(),
          viewerId && viewerId !== userId ? followService.isFollowing(userId, viewerId).catch(() => false) : Promise.resolve(false),
        ])
        if (cancelled) return
        setPostCount(statsResult.posts)
        // Also null when the read failed; startEdit asks strictly before an owner edits from it.
        setProfileDocumentMissing(!profileResult)

        const { followers: followersCount, following: followingCount } = statsResult
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
        setIsFollowing(viewerFollows)
        setAllUsernames(sortedUsernames)
        setUsername(sortedUsernames[0] ?? null)

        const named = sortedUsernames.length > 0
          ? merged.map((post) => withAuthor(post, { username: sortedUsernames[0], hasDpns: true }))
          : merged
        // Committed even when empty: this profile's posts replace whatever was there.
        const originals = postsResult.documents || []
        setPostsState((current) => commitProfileFirstPage(current, scope, { posts: named, originals, failed: postsResult.failed }, PAGE_SIZE))
        if (named.length > 0) enrichProgressively(named, postsResult.preloaded)
        setIsLoading(false)

        await decorations
      } catch (error) {
        logger.error('Failed to load profile:', error)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    loadProfileData().catch((err) => logger.error('Failed to load profile:', err))
    return () => {
      cancelled = true
      // A next page still out for this load no longer has a view to join.
      if (currentScopeRef.current === scope) currentScopeRef.current = ''
    }
    // Reload on a profile change, or once the stored session has been checked;
    // the viewer changing mid-visit (sign-in here) reloads through enrichProgressively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, isAuthRestoring, enrichProgressively])

  // A profile is optional, so an owner without one simply edits theirs into
  // existence; only a missing identity means the session is stale.
  useEffect(() => {
    if (!profileDocumentMissing || !isOwnProfile || !viewerId || isLoading) return
    const check = async () => {
      try {
        const { identityService } = await import('@/lib/services/identity-service')
        if (!(await identityService.getIdentity(viewerId))) {
          toast.error('We couldn\'t find this account. Please sign in again.')
          await logout()
        }
      } catch (error) {
        logger.error('Failed to verify identity for profile check:', error)
      }
    }
    check().catch((err) => logger.error('Identity check failed:', err))
  }, [profileDocumentMissing, isOwnProfile, viewerId, isLoading, logout])

  const startEdit = useCallback(async () => {
    // A profile that failed to load reads as missing, and an edit from its blank
    // draft would erase every field of the real one. Only a strict "none" counts.
    if (profileDocumentMissing && viewerId) {
      const { unifiedProfileService } = await import('@/lib/services')
      const exists = await unifiedProfileService.profileExists(viewerId).catch(() => null)
      if (exists !== false) {
        toast.error('Your profile could not be loaded. Reload the page to edit it.')
        return
      }
    }
    setEditInitial({
      // Without a profile the name shown is a stand-in; start from the DPNS label.
      displayName: (profileDocumentMissing ? dpnsLabel?.slice(0, profileTextLimits().displayName) : profile?.displayName) || '',
      bio: profile?.bio || '',
      location: profile?.location || '',
      website: profile?.website || '',
      pronouns: profile?.pronouns || '',
      nsfw: profile?.nsfw || false,
      paymentUris: profile?.paymentUris?.map((p) => p.uri) || [],
      socialLinks: profile?.socialLinks || [],
    })
  }, [profile, profileDocumentMissing, viewerId, dpnsLabel])

  const cancelEdit = () => setEditInitial(null)

  // An avatar or banner save is a profile's first write when there was none; it
  // names the profile after the DPNS label, as the service does.
  const markProfileWritten = () => {
    if (!profileDocumentMissing) return
    setProfileDocumentMissing(false)
    const name = dpnsLabel?.slice(0, profileTextLimits().displayName) || displayName
    setProfile((prev) => (prev ? { ...prev, displayName: name } : prev))
  }

  // `?edit=true` deep-links into edit mode once, then drops the parameter.
  useEffect(() => {
    if (!isOwnProfile || isLoading) return
    if (searchParams.get('edit') === 'true' && !isEditing) {
      startEdit().catch((err) => logger.error('Failed to start editing:', err))
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
    if (!userId || isLoadingMore || !hasMore || !lastPostId) return

    // The page belongs to the load whose cursor it continues; if that load is
    // replaced while this is out, the result (and its cursor) is dropped.
    const scope = postsState.scope
    const isCurrent = () => currentScopeRef.current === scope
    setIsLoadingMore(true)
    try {
      const { postService } = await import('@/lib/services')
      const result = await postService.getUserPosts(userId, { limit: PAGE_SIZE, startAfter: lastPostId })
      if (!isCurrent()) return
      const newPostDocs = result.documents || []
      // Author display fields are already resolved for this profile.
      const fresh = newPostDocs.map((post) => withAuthor(post, { username: username || '', displayName: profile?.displayName || '', avatar: '', hasDpns }))

      await attachQuotedPosts(fresh)
      if (!isCurrent()) return
      setPostsState((current) => appendProfilePostsPage(current, scope, { posts: fresh, documents: newPostDocs }, PAGE_SIZE))
      if (fresh.length > 0) enrichProgressively(fresh)
    } catch (error) {
      logger.error('Failed to load more posts:', error)
    } finally {
      if (isCurrent()) setIsLoadingMore(false)
    }
  }, [userId, isLoadingMore, hasMore, lastPostId, postsState.scope, username, profile?.displayName, hasDpns, enrichProgressively])

  const hasMorePosts = hasMore
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
      // Mounted post media reads the shared cache before its enrichment hint.
      followStatusCache.set(authedUser.identityId, userId, !isFollowing)
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

  const handleSaveProfile = async (draft: ProfileDraft) => {
    if (!viewerId) return
    // Mainnet v13 (`notYetUsable`): the profile extension waits for the first seated team.
    if (!profileWritable) {
      toast.error(POSTING_CLOSED_COPY)
      return
    }
    setIsSaving(true)
    try {
      const { unifiedProfileService } = await import('@/lib/services')
      const saved = await unifiedProfileService.updateProfile(viewerId, draft)
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              ...draft,
              // A blank name was filled in by the service on a first save.
              displayName: saved?.displayName || draft.displayName || prev.displayName,
              paymentUris: draft.paymentUris.map((uri) => ({ scheme: paymentUriScheme(uri), uri })),
            }
          : null
      )
      setProfileDocumentMissing(false)
      setEditInitial(null)
      toast.success('Profile updated!')
    } catch (error) {
      logger.error('Failed to update profile:', error)
      toast.error(error instanceof ListLimitError ? error.message : 'Failed to update profile')
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
          <p>{requestedUserId ? 'Invalid identity ID' : 'User not found'}</p>
        </div>
      </PageShell>
    )
  }

  return (
    <>
      <PageShell>
        <PageHeader borderless>
          <div className="flex items-center gap-4 px-4 py-3">
            <button aria-label="Back" onClick={() => router.back()} className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900">
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <div className="flex-1">
              {isDisplayNameLoading ? (
                <div className="h-6 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-1" />
              ) : (
                <h1 className="text-xl font-extrabold">{displayName}</h1>
              )}
              <p className="text-sm text-gray-500">{displayedPostCount !== null ? displayedPostCount : '–'} {displayedPostCount === 1 ? 'post' : 'posts'}</p>
            </div>
          </div>
        </PageHeader>

        {isLoading || awaitingProfileModeration ? (
          <ProfileSkeleton userId={userId} />
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
              profile={showsHiddenProfileStub && profile
                // Hidden: nothing of the extension (an empty banner reads no image).
                ? { displayName: dpnsLabel || displayName, followersCount: profile.followersCount, followingCount: profile.followingCount, bannerUri: '' }
                : profile}
              displayName={showsHiddenProfileStub ? dpnsLabel || displayName : displayName}
              isDisplayNameLoading={isDisplayNameLoading}
              profileMissing={profileDocumentMissing}
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
              onEditProfile={() => {
                startEdit().catch((err) => logger.error('Failed to start editing:', err))
              }}
            />

            {showsHiddenProfileStub && (profileHidden
              ? <HiddenContentStub noun="profile" moderation={profileModeration?.moderation} documentId={userId} />
              : <HiddenContentStub noun="profile" documentId={userId} text="This profile's details can't be shown right now." />)}
            {hidesProfiles && seesHidden && (profileHidden || (restrictedHere ?? authorRestricted) === true || isModerator) && (
              <div className="flex items-start gap-2 px-4 pb-3">
                <ModerationLabel moderation={profileModeration?.moderation} restricted={(restrictedHere ?? authorRestricted) === true} className="flex-1" />
                <ModeratorContentMenu
                  className="ml-auto"
                  target={{
                    contract: 'social',
                    // No extension to hide: the menu still restricts and warns.
                    docType: profileModeration ? 'yapprProfile' : 'profile',
                    documentId: profileModeration?.documentId ?? userId,
                    createdAt: Number.NaN,
                    preview: profile?.bio ?? '',
                    noun: 'profile',
                    ...(profileModeration ? { moderation: profileModeration.moderation } : {}),
                  }}
                  ownerId={userId}
                  onRemoved={() => { /* a profile stays on its page; onChanged relabels it */ }}
                  onChanged={onProfileModerated}
                />
              </div>
            )}

            <YappFlow identityId={userId} isOwnProfile={isOwnProfile} />

            {isBlockedByMe && !isOwnProfile && (
              <div className="p-4 bg-gray-50 dark:bg-gray-950 border-y border-gray-200 dark:border-gray-800">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-full">
                      <NoSymbolIcon className="h-6 w-6 text-red-500" />
                    </div>
                    <div>
                      <p className="font-semibold">{isOwnBlock ? 'You blocked this user' : 'This user is blocked'}</p>
                      <p className="text-sm text-gray-500">
                        {isOwnBlock
                          ? "You won't see their posts in your feeds"
                          : "Blocked by a block list you follow. You won't see their posts in your feeds"}
                      </p>
                    </div>
                  </div>
                  {isOwnBlock ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { unblock().catch((error) => logger.error('Profile: unblock failed:', error)) }}
                      disabled={blockLoading}
                    >
                      Unblock
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => router.push('/settings?section=privacy')}>
                      Manage block lists
                    </Button>
                  )}
                </div>
              </div>
            )}

            <ProfileTabs
              activeTab={tabs.activeTab}
              onTabChange={tabs.setActiveTab}
              viewerId={viewerId}
              getPostEnrichment={getPostEnrichment}
              posts={withoutHiddenTombstones(published.posts).filter((p) => !p.repostedBy && !isBareRepost(p))}
              replies={tabs.replies}
              top={tabs.top}
              mentions={tabs.mentions}
              blogs={{ blogs, loading: blogsLoading }}
              moderation={seatedSocialModerator && userId ? (
                <ProfileModerationPanel userId={userId} enrichProgressively={enrichProgressively} getPostEnrichment={getPostEnrichment} />
              ) : undefined}
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

      <EditProfileModal
        initial={isOwnProfile ? editInitial : null}
        userId={userId}
        bannerUri={profile?.bannerUri}
        avatarKey={avatarKey}
        bannerKey={bannerKey}
        isSaving={isSaving}
        createsProfile={profileDocumentMissing}
        onCancel={cancelEdit}
        onSave={(draft) => {
          handleSaveProfile(draft).catch((err) => logger.error('Failed to save profile:', err))
        }}
        onAvatarSaved={() => {
          invalidateAvatarImageCache(userId)
          setAvatarKey((k) => k + 1)
          markProfileWritten()
        }}
        onBannerSaved={(newBannerUrl) => {
          markProfileWritten()
          invalidateBannerCache(userId)
          setBannerKey((k) => k + 1)
          setProfile((prev) => (prev ? { ...prev, bannerUri: newBannerUrl || undefined } : null))
        }}
      />

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

const BAR = 'bg-gray-200 dark:bg-gray-800 rounded animate-pulse'

/** The header's shape while it loads: banner, avatar, action button, name, handle, meta and counts. */
function ProfileSkeleton({ userId }: { userId?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading profile">
      <div className="h-32 sm:h-48 overflow-hidden">
        {userId ? (
          <div className="h-full w-full blur-sm opacity-60">
            <BannerImage userId={userId} className="w-full h-full" fallbackGradient />
          </div>
        ) : (
          <div className="h-full w-full bg-gradient-yappr opacity-50" />
        )}
      </div>
      <div className="px-4 pb-4">
        <div className="flex justify-between items-start -mt-12 sm:-mt-16 mb-4">
          <div className="h-24 w-24 sm:h-32 sm:w-32 rounded-full bg-white dark:bg-neutral-900 p-1">
            <div className="h-full w-full rounded-full overflow-hidden blur-sm opacity-60">
              {userId ? <UserAvatar userId={userId} alt="" size="full" /> : <div className={`h-full w-full ${BAR}`} />}
            </div>
          </div>
          <div className={`mt-14 sm:mt-20 h-10 w-28 !rounded-full ${BAR}`} />
        </div>
        <div className="mb-3">
          <div className={`h-7 w-48 mb-1 ${BAR}`} />
          <div className={`h-5 w-32 my-1 ${BAR}`} />
        </div>
        <div className={`h-5 w-3/4 mb-3 ${BAR}`} />
        <div className={`h-5 w-40 mb-3 ${BAR}`} />
        <div className={`h-5 w-44 ${BAR}`} />
      </div>
    </div>
  )
}

function LoadingFallback() {
  return (
    <PageShell>
      <ProfileSkeleton />
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
