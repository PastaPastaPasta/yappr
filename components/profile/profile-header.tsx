'use client'

import { filterPaymentUris } from '@/lib/utils/payment-uri'
import { useRouter } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  BuildingStorefrontIcon,
  CalendarIcon,
  CheckIcon,
  CurrencyDollarIcon,
  EllipsisHorizontalIcon,
  EnvelopeIcon,
  FlagIcon,
  LinkIcon,
  LockClosedIcon,
  MapPinIcon,
  QrCodeIcon,
  ShareIcon,
  UserPlusIcon,
} from '@heroicons/react/24/outline'
import type { ParsedPaymentUri, SocialLink, Store } from '@/lib/types'
import { formatNumber } from '@/lib/utils'
import { getSocialLinkUrl, isValidHttpUrl } from '@/lib/profile-links'
import { useCopy } from '@/hooks/use-copy'
import { useReportPostModal } from '@/hooks/use-report-post-modal'
import { profilesAreReportable } from '@/lib/contract-topology'
import { Button } from '@/components/ui/button'
import { UserAvatar } from '@/components/ui/avatar-image'
import { BannerImage } from '@/components/ui/banner-image'
import { TooltipButton, TooltipBadge } from '@/components/ui/tooltip-button'
import { PaymentSchemeIcon, getPaymentLabel, truncateAddress } from '@/components/ui/payment-icons'
import { UsernameDropdown } from '@/components/dpns/username-dropdown'
import { PrivateFeedAccessButton } from '@/components/profile/private-feed-access-button'
import { getPlatformLabel } from '@/components/profile/social-links-input'

const YAPPR_PILL =
  'inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-yappr-600 dark:text-yappr-400 bg-yappr-50 dark:bg-yappr-950/30 hover:bg-yappr-100 dark:hover:bg-yappr-950/50 rounded-full transition-colors'
const GRAY_PILL = 'inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-sm'
const MENU_ITEM = 'flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer outline-none data-[highlighted]:bg-gray-100 dark:data-[highlighted]:bg-gray-800'

export interface ProfileData {
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

interface ProfileHeaderProps {
  userId: string
  profile: ProfileData | null
  displayName: string
  isDisplayNameLoading: boolean
  /** No profile document exists, so `displayName` is a stand-in (the DPNS label or the identity). */
  profileMissing: boolean
  username: string | null
  allUsernames: string[]
  viewerId: string | null
  /** Bumped after an avatar or banner save so the images refetch. */
  avatarKey: number
  bannerKey: number
  userStore: Store | null
  hasPrivateFeed: boolean
  isPrivateFollower: boolean
  isFollowing: boolean
  followLoading: boolean
  onFollow: () => void
  onTip: () => void
  onRequireAuth: () => void
  onOpenUsernameModal: () => void
  onSelectPayment: (payment: ParsedPaymentUri) => void
  onEditProfile: () => void
}

/** Banner, avatar, action row and the profile card. */
export function ProfileHeader({
  userId,
  profile,
  displayName,
  isDisplayNameLoading,
  profileMissing,
  username,
  allUsernames,
  viewerId,
  avatarKey,
  bannerKey,
  userStore,
  hasPrivateFeed,
  isPrivateFollower,
  isFollowing,
  followLoading,
  onFollow,
  onTip,
  onRequireAuth,
  onOpenUsernameModal,
  onSelectPayment,
  onEditProfile,
}: ProfileHeaderProps) {
  const router = useRouter()
  const paymentUris = filterPaymentUris(profile?.paymentUris)
  const copy = useCopy()
  const hasDpns = allUsernames.length > 0
  const isOwnProfile = viewerId === userId
  const copyProfileLink = () => copy(`${window.location.origin}${process.env.NEXT_PUBLIC_BASE_PATH || ''}/user/?id=${userId}`, 'Profile link copied!')
  const subject = profile?.displayName || username || 'user'
  const { open: openReport } = useReportPostModal()
  const profilesReportable = profilesAreReportable()

  return (
    <>
      <div className="relative h-32 sm:h-48">
        <BannerImage key={bannerKey} userId={userId} preloadedUrl={profile?.bannerUri} className="w-full h-full" fallbackGradient />
      </div>

      <div className="px-4 pb-4">
        <div className="relative flex justify-between items-start -mt-16 mb-4">
          <div className="relative">
            <div className="h-24 w-24 sm:h-32 sm:w-32 rounded-full bg-white dark:bg-neutral-900 p-1">
              <UserAvatar key={avatarKey} userId={userId} alt={displayName} size="full" />
            </div>
          </div>

          <div className="mt-14 sm:mt-20 flex min-w-0 flex-wrap items-center justify-end gap-2">
            {isOwnProfile ? (
              <>
                <TooltipButton label="Copy link to profile" onClick={copyProfileLink}>
                  <ShareIcon className="h-4 w-4" />
                </TooltipButton>
                <Button variant="outline" onClick={onEditProfile} className="font-bold">
                  Edit profile
                </Button>
              </>
            ) : (
              <div className="contents">
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      aria-label="More"
                      className="p-2 rounded-full border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                      <EllipsisHorizontalIcon className="h-4 w-4" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={5}
                      className="min-w-[180px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50"
                    >
                      <DropdownMenu.Item onSelect={copyProfileLink} className={MENU_ITEM}>
                        <ShareIcon className="h-5 w-5" />
                        Copy link to profile
                      </DropdownMenu.Item>
                      {/* v13: a profile can be reported to the moderators (`about: 1`). */}
                      {profilesReportable && (
                        <DropdownMenu.Item
                          onSelect={() => (viewerId ? openReport({ kind: 'profile', identityId: userId, name: subject }) : onRequireAuth())}
                          className={`${MENU_ITEM} text-red-600 dark:text-red-400`}
                        >
                          <FlagIcon className="h-5 w-5" />
                          Report {subject}
                        </DropdownMenu.Item>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <TooltipButton
                  label="Send a tip"
                  aria-label={`Tip ${subject}`}
                  onClick={onTip}
                  className="hover:bg-amber-50 dark:hover:bg-amber-950 hover:border-amber-300 dark:hover:border-amber-700 group"
                >
                  <CurrencyDollarIcon className="h-4 w-4 group-hover:text-amber-500" />
                </TooltipButton>
                <TooltipButton label="Message" aria-label={`Message ${subject}`} onClick={() => router.push(`/messages?startConversation=${userId}`)}>
                  <EnvelopeIcon className="h-4 w-4" />
                </TooltipButton>
                <Button variant={isFollowing ? 'outline' : 'default'} onClick={onFollow} disabled={followLoading} className="font-bold px-5">
                  {isFollowing ? 'Following' : 'Follow'}
                </Button>
                <PrivateFeedAccessButton ownerId={userId} currentUserId={viewerId} isFollowing={isFollowing} onRequireAuth={onRequireAuth} />
              </div>
            )}
          </div>
        </div>

        <div className="mb-3">
          {isDisplayNameLoading ? (
            <div className="h-7 w-48 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-1" />
          ) : (
            <h2 data-testid="profile-display-name" data-profile-missing={profileMissing || undefined} className="text-xl font-extrabold">{displayName}</h2>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            {hasDpns && username ? (
              <UsernameDropdown username={username} allUsernames={allUsernames} />
            ) : (
              <TooltipBadge label="Click to copy full identity ID">
                <button
                  onClick={() => copy(userId, 'Identity ID copied')}
                  className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-mono text-sm"
                >
                  {userId.slice(0, 8)}...{userId.slice(-6)}
                </button>
              </TooltipBadge>
            )}
            {isOwnProfile && !hasDpns && (
              <button
                onClick={onOpenUsernameModal}
                className={YAPPR_PILL}
              >
                <UserPlusIcon className="h-3 w-3" />
                Get a username
              </button>
            )}
            {userStore && userStore.status === 'active' && (
              <TooltipBadge label={`Visit ${displayName}'s store`}>
                <button
                  onClick={() => router.push(`/store/view?id=${userStore.id}`)}
                  className={YAPPR_PILL}
                >
                  <BuildingStorefrontIcon className="h-3 w-3" />
                  {userStore.name}
                </button>
              </TooltipBadge>
            )}
            {hasPrivateFeed && (
              <TooltipBadge
                label="This user has a private feed. Follow them to request access."
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-full"
              >
                <LockClosedIcon className="h-3 w-3" />
                Private Feed
              </TooltipBadge>
            )}
            {isPrivateFollower && (
              <TooltipBadge
                label="You have access to this user's private feed"
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30 rounded-full"
              >
                <CheckIcon className="h-3 w-3" />
                Private Follower
              </TooltipBadge>
            )}
          </div>
        </div>

        {profile?.pronouns && <p className="text-gray-500 text-sm mb-2">{profile.pronouns}</p>}
        {profile?.bio && <p className="mb-3">{profile.bio}</p>}

        <div className="flex flex-wrap gap-3 text-sm text-gray-500 mb-3">
          {profile?.location && (
            <span className="flex items-center gap-1">
              <MapPinIcon className="h-4 w-4" />
              {profile.location}
            </span>
          )}
          {profile?.website && isValidHttpUrl(profile.website) && (
            <a href={profile.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-yappr-500 hover:underline">
              <LinkIcon className="h-4 w-4" />
              {profile.website.replace(/^https?:\/\//, '')}
            </a>
          )}
          <span className="flex items-center gap-1">
            <CalendarIcon className="h-4 w-4" />
            Joined {profile?.joinedAt ? profile.joinedAt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'recently'}
          </span>
        </div>

        <div className="flex gap-4 text-sm">
          <button onClick={() => router.push(`/following?id=${userId}`)} className="hover:underline">
            <span className="font-bold">{formatNumber(profile?.followingCount || 0)}</span>
            <span className="text-gray-500"> Following</span>
          </button>
          <button onClick={() => router.push(`/followers?id=${userId}`)} className="hover:underline">
            <span className="font-bold">{formatNumber(profile?.followersCount || 0)}</span>
            <span className="text-gray-500"> {profile?.followersCount === 1 ? 'Follower' : 'Followers'}</span>
          </button>
        </div>

        {profile?.socialLinks && profile.socialLinks.length > 0 && (
          <div className="mt-3">
            <div className="flex flex-wrap gap-2">
              {profile.socialLinks.map((link, index) => {
                const url = getSocialLinkUrl(link.platform, link.handle)
                const content = (
                  <>
                    <span className="font-medium">{getPlatformLabel(link.platform)}</span>
                    <span className="text-gray-600 dark:text-gray-400">{link.handle}</span>
                  </>
                )
                return url ? (
                  <a key={index} href={url} target="_blank" rel="noopener noreferrer" className={`${GRAY_PILL} hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors`}>
                    {content}
                  </a>
                ) : (
                  <span key={index} className={GRAY_PILL}>
                    {content}
                  </span>
                )
              })}
            </div>
          </div>
        )}

        {paymentUris.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-800">
            <h4 className="text-sm font-semibold text-gray-500 mb-2">Tip addresses</h4>
            <div className="space-y-2">
              {paymentUris.map((payment, index) => (
                <button
                  key={index}
                  onClick={() => onSelectPayment(payment)}
                  className="w-full flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-900 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-left"
                >
                  <PaymentSchemeIcon scheme={payment.scheme} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{getPaymentLabel(payment.uri)}</span>
                    <p className="text-xs text-gray-500 font-mono truncate">{truncateAddress(payment.uri, 24)}</p>
                  </div>
                  <QrCodeIcon className="w-4 h-4 text-gray-400" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
