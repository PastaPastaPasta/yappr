'use client'

import { useState, useEffect, Suspense } from 'react'
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
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { PostCard } from '@/components/post/post-card'
import { formatNumber } from '@/lib/utils'
import { UserAvatar, invalidateAvatarImageCache } from '@/components/ui/avatar-image'
import { AvatarCustomization } from '@/components/settings/avatar-customization'
import { useAuth } from '@/contexts/auth-context'
import toast from 'react-hot-toast'
import * as Tooltip from '@radix-ui/react-tooltip'
import type { Post, ParsedPaymentUri, SocialLink } from '@/lib/types'
import type { MigrationStatus } from '@/lib/services/profile-migration-service'
import { PaymentSchemeIcon, getPaymentLabel, truncateAddress } from '@/components/ui/payment-icons'
import { useBlock } from '@/hooks/use-block'

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

  const isOwnProfile = currentUser?.identityId === userId

  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [hasDpns, setHasDpns] = useState(false)
  const [posts, setPosts] = useState<Post[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isFollowing, setIsFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [postCount, setPostCount] = useState<number | null>(null)
  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus>('no_profile')

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
  const [newPaymentUri, setNewPaymentUri] = useState('')
  const [newSocialPlatform, setNewSocialPlatform] = useState('')
  const [newSocialHandle, setNewSocialHandle] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  // Block state - only check if viewing another user's profile
  const { isBlocked: isBlockedByMe, isLoading: blockLoading, toggleBlock } = useBlock(userId || '')

  const displayName = profile?.displayName || (userId ? `User ${userId.slice(-6)}` : 'Unknown')

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
                avatar: '', // Let UserAvatar fetch the actual avatar
                verified: false,
                followers: 0,
                following: 0,
                joinedAt: new Date(),
                hasDpns: false, // Set to false initially, will update if DPNS found
              } as any,
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

    if (!userId) return

    setFollowLoading(true)
    try {
      const { followService } = await import('@/lib/services')

      if (isFollowing) {
        // Unfollow
        const result = await followService.unfollowUser(currentUser.identityId, userId)
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
        const result = await followService.followUser(currentUser.identityId, userId)
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

  const handleStartEdit = () => {
    setEditDisplayName(profile?.displayName || '')
    setEditBio(profile?.bio || '')
    setEditLocation(profile?.location || '')
    setEditWebsite(profile?.website || '')
    setEditPronouns(profile?.pronouns || '')
    setEditNsfw(profile?.nsfw || false)
    setEditPaymentUris(profile?.paymentUris?.map(p => p.uri) || [])
    setEditSocialLinks(profile?.socialLinks || [])
    setIsEditingProfile(true)
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
    setNewPaymentUri('')
    setNewSocialPlatform('')
    setNewSocialHandle('')
  }

  const handleAddPaymentUri = () => {
    if (newPaymentUri.trim() && !editPaymentUris.includes(newPaymentUri.trim())) {
      setEditPaymentUris([...editPaymentUris, newPaymentUri.trim()])
      setNewPaymentUri('')
    }
  }

  const handleRemovePaymentUri = (index: number) => {
    setEditPaymentUris(editPaymentUris.filter((_, i) => i !== index))
  }

  const handleAddSocialLink = () => {
    if (newSocialPlatform.trim() && newSocialHandle.trim()) {
      setEditSocialLinks([...editSocialLinks, { platform: newSocialPlatform.trim(), handle: newSocialHandle.trim() }])
      setNewSocialPlatform('')
      setNewSocialHandle('')
    }
  }

  const handleRemoveSocialLink = (index: number) => {
    setEditSocialLinks(editSocialLinks.filter((_, i) => i !== index))
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
              <h1 className="text-xl font-bold">{displayName}</h1>
              <p className="text-sm text-gray-500">{postCount !== null ? postCount : '–'} posts</p>
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
                            navigator.clipboard.writeText(profileUrl)
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
                      placeholder="they/them, she/her, he/him, etc."
                      className="mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                      maxLength={30}
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
                      maxLength={100}
                    />
                  </div>

                  {/* Payment Addresses */}
                  <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Payment Addresses</label>
                    <p className="text-xs text-gray-500 mb-2">Add crypto addresses where others can tip you</p>

                    {editPaymentUris.map((uri, index) => (
                      <div key={index} className="flex gap-2 items-center mb-2">
                        <code className="flex-1 px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm truncate">
                          {uri}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleRemovePaymentUri(index)}
                          className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ))}

                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newPaymentUri}
                        onChange={(e) => setNewPaymentUri(e.target.value)}
                        placeholder="dash:XnNh3x8B7... or bitcoin:1A1z..."
                        className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddPaymentUri())}
                      />
                      <button
                        type="button"
                        onClick={handleAddPaymentUri}
                        className="p-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        <PlusIcon className="h-5 w-5" />
                      </button>
                    </div>
                  </div>

                  {/* Social Links */}
                  <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Social Links</label>

                    {editSocialLinks.map((link, index) => (
                      <div key={index} className="flex gap-2 items-center mb-2 mt-2">
                        <span className="px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm font-medium capitalize min-w-[80px]">
                          {link.platform}
                        </span>
                        <span className="flex-1 px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm truncate">
                          {link.handle}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveSocialLink(index)}
                          className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ))}

                    <div className="flex gap-2 mt-2">
                      <input
                        type="text"
                        value={newSocialPlatform}
                        onChange={(e) => setNewSocialPlatform(e.target.value)}
                        placeholder="twitter"
                        className="w-24 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                      />
                      <input
                        type="text"
                        value={newSocialHandle}
                        onChange={(e) => setNewSocialHandle(e.target.value)}
                        placeholder="@username"
                        className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddSocialLink())}
                      />
                      <button
                        type="button"
                        onClick={handleAddSocialLink}
                        className="p-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        <PlusIcon className="h-5 w-5" />
                      </button>
                    </div>
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
                              navigator.clipboard.writeText(payment.uri)
                              toast.success('Address copied!')
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
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                <h3 className="font-semibold">{postCount !== null ? postCount : '–'} Posts</h3>
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
      </div>

      <RightSidebar />

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
    </div>
  )
}

function LoadingFallback() {
  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
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
