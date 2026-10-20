'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  UserIcon,
  KeyIcon,
  BellIcon,
  ShieldCheckIcon,
  PaintBrushIcon,
  InformationCircleIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  MoonIcon,
  SunIcon,
  ComputerDesktopIcon,
  UserGroupIcon,
  UserPlusIcon,
  LockClosedIcon,
  CloudArrowUpIcon,
  NoSymbolIcon,
  CommandLineIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline'
import { Lockup } from '@/components/brand/brand'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { Button } from '@/components/ui/button'
import { TooltipButton } from '@/components/ui/tooltip-button'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useTheme } from 'next-themes'
import * as RadioGroup from '@radix-ui/react-radio-group'
import { SettingsSwitch } from '@/components/settings/settings-switch'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { EncryptionKeySettings } from '@/components/settings/encryption-key-settings'
import { WalletConnectionsSettings } from '@/components/settings/wallet-connections-settings'
import { PasskeySettings } from '@/components/settings/passkey-settings'
import { useWalletSession } from '@/components/auth/wallet-encryption-key-prompt'
import { BlockedUsersSettings } from '@/components/settings/blocked-users'
import { PrivateFeedSettings } from '@/components/settings/private-feed-settings'
import { PrivateFeedFollowRequests } from '@/components/settings/private-feed-follow-requests'
import { PrivateFeedFollowers } from '@/components/settings/private-feed-followers'
import { PrivateFeedDashboard } from '@/components/settings/private-feed-dashboard'
import { BlockListSettings } from '@/components/settings/block-list-settings'
import { SavedAddressesSettings } from '@/components/settings/saved-addresses-settings'
import { StorachaSettings } from '@/components/settings/storacha-settings'
import { PinataSettings } from '@/components/settings/pinata-settings'
import { ModerationSettings } from '@/components/settings/moderation-settings'
import { ContractModerationSections, useModeratedContracts } from '@/components/settings/contract-moderation-sections'
import { OwnWarningsNotice } from '@/components/moderation/own-warnings-notice'
import { paymentIsChoosable } from '@/lib/payment-preference'
import { DeveloperSettings } from '@/components/settings/developer-settings'
import { YAPP_TOKEN_AUTHORITY_ID } from '@/lib/constants'
import { postsHaveLanguage, privateFeedClientSupported, yappCanBeFrozen } from '@/lib/contract-topology'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useDashPayContactsModal } from '@/hooks/use-dashpay-contacts-modal'
import { useCopy } from '@/hooks/use-copy'
import { useSettingsStore, type SensitiveContentMode } from '@/lib/store'
import { LINK_PREVIEW_SERVICES } from '@/lib/link-preview/fetch'
import { UsernameModal } from '@/components/dpns/username-modal'
import { LegalLinks } from '@/components/layout/legal-links'
import { SOURCE_URL } from '@/lib/legal'

type SettingsSection = 'main' | 'account' | 'contacts' | 'notifications' | 'privacy' | 'privateFeed' | 'storage' | 'appearance' | 'developer' | 'about' | 'moderation'
const VALID_SECTIONS: SettingsSection[] = ['main', 'account', 'contacts', 'notifications', 'privacy', 'privateFeed', 'storage', 'appearance', 'developer', 'about', 'moderation']

const MODERATION_SECTION = { id: 'moderation', label: 'Moderation', icon: NoSymbolIcon, description: 'Ban, suspend and remove content; freeze or slash YAPP (moderators only)' }

const settingsSections = [
  { id: 'account', label: 'Account', icon: UserIcon, description: 'Manage your account details' },
  { id: 'contacts', label: 'Contacts', icon: UserGroupIcon, description: 'Find people you know from DashPay' },
  { id: 'notifications', label: 'Notifications', icon: BellIcon, description: 'Control your notification preferences' },
  { id: 'privacy', label: 'Privacy & Security', icon: ShieldCheckIcon, description: 'Passkeys, blocking and what you see' },
  { id: 'privateFeed', label: 'Private Feed', icon: LockClosedIcon, description: 'Posts only followers you approve can read' },
  { id: 'storage', label: 'Storage', icon: CloudArrowUpIcon, description: 'Where your image uploads are stored' },
  { id: 'appearance', label: 'Appearance', icon: PaintBrushIcon, description: 'Customize how Yappr looks' },
  { id: 'developer', label: 'Developer', icon: CommandLineIcon, description: 'Query inspector and build details' },
  { id: 'about', label: 'About', icon: InformationCircleIcon, description: 'Learn more about Yappr' },
]

const SENSITIVE_CONTENT_OPTIONS: Array<{ value: SensitiveContentMode; label: string; description: string }> = [
  { value: 'blur', label: 'Warn first', description: 'Cover NSFW posts until you choose to show them' },
  { value: 'show', label: 'Always show', description: 'Show NSFW posts without a warning' },
  { value: 'hide', label: 'Hide', description: 'Remove NSFW posts from your feeds' },
]

const NOTIFICATION_KEYS = ['likes', 'reposts', 'replies', 'follows', 'mentions', 'blogPosts', 'store'] as const

const NOTIFICATION_LABELS: Record<string, string> = {
  likes: 'Likes',
  reposts: 'Reposts',
  replies: 'Replies',
  follows: 'Follows',
  mentions: 'Mentions',
  blogPosts: 'Blog posts',
  store: 'Store',
}

const NOTIFICATION_DESCRIPTIONS: Record<string, string> = {
  likes: 'When someone likes your posts',
  reposts: 'When someone reposts your content',
  replies: 'When someone replies to you',
  follows: 'When someone follows you',
  mentions: 'When someone mentions you',
  blogPosts: 'When a blog you follow publishes a new post',
  store: 'Orders and reviews for your store, and updates on your orders',
}

function SettingsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, logout } = useAuth()
  const copy = useCopy()
  const walletSession = useWalletSession()
  // Only where the configured YAPP lets its authority freeze or slash (not on social v17).
  const isAuthority = user?.identityId === YAPP_TOKEN_AUTHORITY_ID && yappCanBeFrozen()
  // A contract's moderation team (social, storefront or blog, each read off its
  // contract) gets that contract's moderation; the token authority gets YAPP
  // freeze/slash. Keep the visible-sections list in one place so the menu, the
  // section title, and the render gate can't drift apart.
  const moderatedContracts = useModeratedContracts()
  const isContractModerator = moderatedContracts.length > 0
  const canModerate = isAuthority || isContractModerator
  const baseSections = privateFeedClientSupported() ? settingsSections : settingsSections.filter((section) => section.id !== 'privateFeed')
  const visibleSections = canModerate ? [...baseSections, MODERATION_SECTION] : baseSections
  // Developer tools are reachable from About (and by URL), not listed in everyone's menu.
  const menuSections = visibleSections.filter((section) => section.id !== 'developer')
  const { theme, setTheme } = useTheme()
  const [encryptionKeyVersion, setEncryptionKeyVersion] = useState(0)
  const handleEncryptionKeyChanged = useCallback(() => {
    setEncryptionKeyVersion((version) => version + 1)
  }, [])

  const linkPreviewsEnabled = useSettingsStore((s) => s.linkPreviewsEnabled)
  const setLinkPreviewsEnabled = useSettingsStore((s) => s.setLinkPreviewsEnabled)
  const gateMediaFromNonFollowed = useSettingsStore((s) => s.gateMediaFromNonFollowed)
  const setGateMediaFromNonFollowed = useSettingsStore((s) => s.setGateMediaFromNonFollowed)
  const sendReadReceipts = useSettingsStore((s) => s.sendReadReceipts)
  const setSendReadReceipts = useSettingsStore((s) => s.setSendReadReceipts)
  const notificationSettings = useSettingsStore((s) => s.notificationSettings)
  const setNotificationSettings = useSettingsStore((s) => s.setNotificationSettings)
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const setPotatoMode = useSettingsStore((s) => s.setPotatoMode)
  const feedLanguage = useSettingsStore((s) => s.feedLanguage)
  const setFeedLanguage = useSettingsStore((s) => s.setFeedLanguage)
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode)
  const setSensitiveContentMode = useSettingsStore((s) => s.setSensitiveContentMode)
  const payWith = useSettingsStore((s) => s.payWith)
  const setPayWith = useSettingsStore((s) => s.setPayWith)
  const hideUnreadablePrivatePosts = useSettingsStore((s) => s.hideUnreadablePrivatePosts)
  const setHideUnreadablePrivatePosts = useSettingsStore((s) => s.setHideUnreadablePrivatePosts)

  // Derive active section from URL search params
  const sectionParam = searchParams.get('section')
  const activeSection: SettingsSection = sectionParam && VALID_SECTIONS.includes(sectionParam as SettingsSection)
    ? (sectionParam as SettingsSection)
    : 'main'

  // Navigate to a section by updating URL
  const setActiveSection = (section: SettingsSection) => {
    if (section === 'main') {
      router.push('/settings')
    } else {
      router.push(`/settings?section=${section}`)
    }
  }
  
  // Account creation date from profile
  const [accountCreatedAt, setAccountCreatedAt] = useState<Date | null>(null)

  // DPNS username state
  const [dpnsUsernames, setDpnsUsernames] = useState<string[]>([])
  const [isUsernameModalOpen, setIsUsernameModalOpen] = useState(false)

  // Fetch account creation date from profile
  useEffect(() => {
    if (!user?.identityId || activeSection !== 'account') return

    const fetchProfileCreatedAt = async () => {
      try {
        const { unifiedProfileService } = await import('@/lib/services')
        const profile = await unifiedProfileService.getProfile(user.identityId)
        if (profile?.joinedAt) {
          const date = new Date(profile.joinedAt)
          // Validate it's a real date (not Invalid Date)
          if (!isNaN(date.getTime())) {
            setAccountCreatedAt(date)
          }
        }
      } catch (error) {
        logger.error('Failed to fetch profile creation date:', error)
      }
    }

    fetchProfileCreatedAt().catch(err => logger.error('Failed to fetch profile created at:', err))
  }, [user?.identityId, activeSection])

  // Fetch DPNS usernames
  useEffect(() => {
    if (!user?.identityId || activeSection !== 'account') return

    const fetchUsernames = async () => {
      try {
        const { dpnsService } = await import('@/lib/services/dpns-service')
        // Canonically sorted: the first entry is the primary username
        const usernames = await dpnsService.getAllUsernamesSorted(user.identityId)
        setDpnsUsernames(usernames)
      } catch (error) {
        logger.error('Failed to fetch DPNS usernames:', error)
      }
    }

    fetchUsernames().catch(err => logger.error('Failed to fetch usernames:', err))
  }, [user?.identityId, activeSection])

  // Refresh DPNS usernames after registration
  const refreshUsernames = async () => {
    if (!user?.identityId) return
    try {
      const { dpnsService } = await import('@/lib/services/dpns-service')
      // Clear cache to get fresh data (pass undefined for username, identityId second)
      dpnsService.clearCache(undefined, user.identityId)
      // Canonically sorted: the first entry is the primary username
      const usernames = await dpnsService.getAllUsernamesSorted(user.identityId)
      setDpnsUsernames(usernames)
    } catch (error) {
      logger.error('Failed to refresh usernames:', error)
    }
  }

  const handleBack = () => {
    router.back()
  }

  const renderMainSettings = () => (
    <div className="divide-y divide-gray-200 dark:divide-gray-800">
      {menuSections.map((section) => (
        <button
          key={section.id}
          onClick={() => setActiveSection(section.id as SettingsSection)}
          className="w-full p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors flex items-center gap-4"
        >
          <div className="p-2 bg-gray-100 dark:bg-gray-900 rounded-lg">
            <section.icon className="h-5 w-5" />
          </div>
          <div className="flex-1 text-left">
            <p className="font-medium">{section.label}</p>
            <p className="text-sm text-gray-500">{section.description}</p>
          </div>
          <ChevronRightIcon className="h-5 w-5 text-gray-400" />
        </button>
      ))}
    </div>
  )

  // Support and developers sometimes need the account ID; nobody needs to read it.
  const copyAccountId = (identityId: string) => copy(identityId, 'Account ID copied')

  const renderAccountSettings = () => (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="font-semibold mb-4">Account</h3>
        <div className="space-y-4 bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
          {user?.identityId && (
            <Button variant="outline" size="sm" onClick={() => copyAccountId(user.identityId)}>
              <ClipboardDocumentIcon className="h-4 w-4 mr-1.5" aria-hidden="true" />
              Copy account ID
            </Button>
          )}
          <div>
            <p className="text-sm text-gray-500">Balance</p>
            <p>{formatBalance(user?.balance || 0)}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Joined</p>
            <p className="text-sm">
              {accountCreatedAt
                ? accountCreatedAt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                : 'Unknown'}
            </p>
          </div>
        </div>
      </div>

      {/* DPNS Username Registration */}
      <div>
        {paymentIsChoosable('post') && (
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <label htmlFor="settings-pay-with" className="block font-medium cursor-pointer">Pay with YAPP when you can</label>
              <p id="settings-pay-with-description" className="text-sm text-gray-500">
                Posts, replies and likes use YAPP while your balance covers them, and Dash otherwise
              </p>
            </div>
            <SettingsSwitch
              id="settings-pay-with"
              aria-describedby="settings-pay-with-description"
              checked={payWith === 'yapp'}
              onCheckedChange={(checked) => setPayWith(checked ? 'yapp' : 'credits')}
            />
          </div>
        )}
        <h3 className="font-semibold mb-4">Usernames</h3>
        <div className="space-y-4">
          {dpnsUsernames.length > 0 ? (
            <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
              <div className="flex flex-wrap gap-2">
                {dpnsUsernames.map((username, index) => (
                  <span
                    key={username}
                    className="inline-flex items-center px-3 py-1 bg-yappr-100 dark:bg-yappr-900/30 text-yappr-700 dark:text-yappr-300 rounded-full text-sm font-medium"
                  >
                    @{username}
                    {index === 0 && (
                      <span className="ml-1.5 text-xs bg-yappr-500 text-white px-1.5 py-0.5 rounded-full">
                        Primary
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Add a username so people can find you.
              </p>
            </div>
          )}
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => setIsUsernameModalOpen(true)}
          >
            <UserPlusIcon className="h-4 w-4 mr-2" />
            {dpnsUsernames.length > 0 ? 'Add another username' : 'Add a username'}
          </Button>
        </div>
      </div>

      <div>
        <Button variant="outline" className="w-full justify-start" onClick={logout}>
          <KeyIcon className="h-4 w-4 mr-2" />
          Sign out
        </Button>
      </div>
    </div>
  )

  const renderContactsSettings = () => (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="font-semibold mb-4">DashPay contacts</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Find people from your DashPay contacts you don&apos;t follow yet.
        </p>
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => {
            useDashPayContactsModal.getState().open()
          }}
        >
          <UserGroupIcon className="h-5 w-5 mr-2" />
          Find DashPay contacts
        </Button>
      </div>
    </div>
  )

  const renderNotificationSettings = () => (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="font-semibold mb-4">In-app notifications</h3>
        <div className="space-y-4">
          {NOTIFICATION_KEYS.map((key) => (
            <div key={key} className="flex items-center justify-between">
              <div>
                <label htmlFor={`notification-${key}`} className="block font-medium cursor-pointer">{NOTIFICATION_LABELS[key] || key}</label>
                <p id={`notification-${key}-description`} className="text-sm text-gray-500">
                  {NOTIFICATION_DESCRIPTIONS[key]}
                </p>
              </div>
              <SettingsSwitch
                id={`notification-${key}`}
                aria-describedby={`notification-${key}-description`}
                checked={notificationSettings[key]}
                onCheckedChange={(checked) =>
                  setNotificationSettings({ [key]: checked })
                }
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  const renderPrivacySettings = () => (
    <div className="p-6 space-y-6">
      <PasskeySettings />

      {/* A wallet sign-in manages its keys in the wallet instead */}
      {walletSession
        ? <WalletConnectionsSettings showBudgets={false} />
        : <EncryptionKeySettings onEncryptionKeyChanged={handleEncryptionKeyChanged} />}

      <div>
        <h3 className="font-semibold mb-4">Privacy</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="settings-link-previews" className="block font-medium cursor-pointer">Link previews</label>
              <p id="settings-link-previews-description" className="text-sm text-gray-500">Show a title and image for links in posts</p>
            </div>
            <SettingsSwitch
              id="settings-link-previews"
              aria-describedby="settings-link-previews-description"
              checked={linkPreviewsEnabled}
              onCheckedChange={setLinkPreviewsEnabled}
            />
          </div>
          {linkPreviewsEnabled && (
            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">Which services load previews?</summary>
              <p className="mt-2">{LINK_PREVIEW_SERVICES.summary}</p>
              <p className="mt-2">
                Services used:{' '}
                <a
                  href={LINK_PREVIEW_SERVICES.imageProxy.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-700 dark:hover:text-gray-300"
                >
                  {LINK_PREVIEW_SERVICES.imageProxy.name}
                </a>
                , the IPFS gateways {LINK_PREVIEW_SERVICES.ipfsGateways.map((gateway) => gateway.name).join(', ')}, and{' '}
                {LINK_PREVIEW_SERVICES.directServices.map((service) => service.name).join(', ')} for their own links.
              </p>
            </details>
          )}

          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="settings-media-gate" className="block font-medium cursor-pointer">Blur media from people you don&apos;t follow</label>
              <p id="settings-media-gate-description" className="text-sm text-gray-500">Tap to reveal their images and link previews</p>
            </div>
            <SettingsSwitch
              id="settings-media-gate"
              aria-describedby="settings-media-gate-description"
              checked={gateMediaFromNonFollowed}
              onCheckedChange={setGateMediaFromNonFollowed}
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="font-semibold mb-4">Messages</h3>
        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="settings-read-receipts" className="block font-medium cursor-pointer">Read receipts</label>
            <p id="settings-read-receipts-description" className="text-sm text-gray-500">Let others see when you&apos;ve read their messages</p>
          </div>
          <SettingsSwitch
            id="settings-read-receipts"
            aria-describedby="settings-read-receipts-description"
            checked={sendReadReceipts}
            onCheckedChange={setSendReadReceipts}
          />
        </div>
      </div>

      {/* Sensitive Content Section */}
      <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
        <h3 className="font-semibold mb-1">NSFW content</h3>
        <p className="text-sm text-gray-500 mb-4">
          Posts their author marked as NSFW
        </p>
        <RadioGroup.Root
          value={sensitiveContentMode}
          onValueChange={(value) => setSensitiveContentMode(value as SensitiveContentMode)}
          className="space-y-2"
        >
          {SENSITIVE_CONTENT_OPTIONS.map((option) => (
            <div key={option.value} className="relative">
              <RadioGroup.Item
                value={option.value}
                id={`sensitive-mode-${option.value}`}
                data-testid={`sensitive-mode-${option.value}`}
                className="peer sr-only"
              />
              <label
                htmlFor={`sensitive-mode-${option.value}`}
                className="flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all peer-data-[state=checked]:border-yappr-500 peer-data-[state=checked]:bg-yappr-50 dark:peer-data-[state=checked]:bg-yappr-950/20 border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950"
              >
                <div>
                  <p className="font-medium">{option.label}</p>
                  <p className="text-sm text-gray-500">{option.description}</p>
                </div>
              </label>
            </div>
          ))}
        </RadioGroup.Root>
      </div>

      {privateFeedClientSupported() && (
        <div className="border-t border-gray-200 dark:border-gray-800 pt-6 flex items-center justify-between gap-4">
          <div>
            <label htmlFor="settings-hide-unreadable-private" className="block font-medium cursor-pointer">Hide private posts you can&apos;t see</label>
            <p id="settings-hide-unreadable-private-description" className="text-sm text-gray-500">Skip private posts from people who haven&apos;t approved you</p>
          </div>
          <SettingsSwitch
            id="settings-hide-unreadable-private"
            data-testid="settings-hide-unreadable-private"
            aria-describedby="settings-hide-unreadable-private-description"
            checked={hideUnreadablePrivatePosts}
            onCheckedChange={setHideUnreadablePrivatePosts}
          />
        </div>
      )}

      {/* Block Lists Section */}
      <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
        <BlockListSettings />
      </div>

      {/* Blocked Users Section */}
      <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
        <BlockedUsersSettings />
      </div>

      {/* Saved Addresses Section */}
      <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
        <SavedAddressesSettings encryptionKeyVersion={encryptionKeyVersion} />
      </div>
    </div>
  )

  const renderAppearanceSettings = () => (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="font-semibold mb-4">Theme</h3>
        <RadioGroup.Root
          value={theme}
          onValueChange={setTheme}
          className="grid grid-cols-3 gap-3"
        >
          <div className="relative">
            <RadioGroup.Item
              value="light"
              id="theme-light"
              className="peer sr-only"
            />
            <label
              htmlFor="theme-light"
              className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 cursor-pointer transition-all peer-data-[state=checked]:border-yappr-500 peer-data-[state=checked]:bg-yappr-50 dark:peer-data-[state=checked]:bg-yappr-950/20 border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950"
            >
              <SunIcon className="h-8 w-8" />
              <span className="text-sm font-medium">Light</span>
            </label>
          </div>

          <div className="relative">
            <RadioGroup.Item
              value="dark"
              id="theme-dark"
              className="peer sr-only"
            />
            <label
              htmlFor="theme-dark"
              className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 cursor-pointer transition-all peer-data-[state=checked]:border-yappr-500 peer-data-[state=checked]:bg-yappr-50 dark:peer-data-[state=checked]:bg-yappr-950/20 border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950"
            >
              <MoonIcon className="h-8 w-8" />
              <span className="text-sm font-medium">Dark</span>
            </label>
          </div>

          <div className="relative">
            <RadioGroup.Item
              value="system"
              id="theme-system"
              className="peer sr-only"
            />
            <label
              htmlFor="theme-system"
              className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 cursor-pointer transition-all peer-data-[state=checked]:border-yappr-500 peer-data-[state=checked]:bg-yappr-50 dark:peer-data-[state=checked]:bg-yappr-950/20 border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950"
            >
              <ComputerDesktopIcon className="h-8 w-8" />
              <span className="text-sm font-medium">System</span>
            </label>
          </div>
        </RadioGroup.Root>
      </div>

      <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
        <h3 className="font-semibold mb-4">Performance</h3>
        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="settings-potato-mode" className="block font-medium cursor-pointer">Potato Mode</label>
            <p id="settings-potato-mode-description" className="text-sm text-gray-500">
              Disable blur effects and visual flair. Enable this if Yappr feels sluggish on your device.
            </p>
          </div>
          <SettingsSwitch
            id="settings-potato-mode"
            aria-describedby="settings-potato-mode-description"
            checked={potatoMode}
            onCheckedChange={setPotatoMode}
          />
        </div>
      </div>

      {/* v10 has one global timeline and posts carry no language. */}
      {postsHaveLanguage() && (
        <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
          <h3 className="font-semibold mb-4"><label htmlFor="feed-language">Feed Language</label></h3>
          <div>
            <p id="feed-language-description" className="text-sm text-gray-500 mb-4">
              Choose the language for the &quot;For You&quot; feed. Posts in other languages will not appear.
            </p>
            <select
              id="feed-language"
              aria-describedby="feed-language-description"
              value={feedLanguage}
              onChange={(e) => setFeedLanguage(e.target.value)}
              className="w-full p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-yappr-500"
            >
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="pt">Portuguese</option>
              <option value="ru">Russian</option>
              <option value="zh">Chinese</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="ar">Arabic</option>
              <option value="hi">Hindi</option>
              <option value="it">Italian</option>
              <option value="nl">Dutch</option>
              <option value="pl">Polish</option>
              <option value="tr">Turkish</option>
            </select>
          </div>
        </div>
      )}
    </div>
  )

  const renderPrivateFeedSettings = () => {
    // action=renew (from the lost-key flow) opens the renewal dialog
    const shouldOpenRenew = searchParams.get('action') === 'renew'

    // Clear the URL param when opening the dialog to prevent re-open on re-render
    const handleRenewDialogOpened = () => {
      if (shouldOpenRenew) {
        router.replace('/settings?section=privateFeed', { scroll: false })
      }
    }

    return (
      <div className="p-6 space-y-6">
        <PrivateFeedSettings openRenew={shouldOpenRenew} onRenewOpened={handleRenewDialogOpened} />
        <PrivateFeedDashboard />
        <div id="private-feed-requests">
          <PrivateFeedFollowRequests />
        </div>
        <div id="private-feed-followers">
          <PrivateFeedFollowers />
        </div>
      </div>
    )
  }

  // Storage provider connection state
  const [storachaConnected, setStorachaConnected] = useState(false)
  const [pinataConnected, setPinataConnected] = useState(false)

  const renderStorageSettings = () => (
    <div className="p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Storage Provider</CardTitle>
          <CardDescription>
            Connect one to attach images to posts and profiles. Uploaded images are public.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <StorachaSettings
            disabled={pinataConnected}
            onConnectionChange={setStorachaConnected}
          />
          <div className="border-t border-gray-200 dark:border-gray-800" />
          <PinataSettings
            disabled={storachaConnected}
            onConnectionChange={setPinataConnected}
          />
        </CardContent>
      </Card>

    </div>
  )

  const renderAboutSettings = () => {
    const version = process.env.NEXT_PUBLIC_GIT_COMMIT_HASH || 'dev'

    return (
    <div className="p-6 space-y-6">
      <div className="text-center py-8">
        <h1 className="mb-4 flex justify-center"><Lockup height={48} /></h1>
        <p className="text-gray-500 mb-4">Decentralized social media on Dash Platform</p>

        <Button variant="outline" asChild>
          <Link href="/about">
            Learn more
          </Link>
        </Button>
      </div>

      <div className="space-y-3">
        <Button variant="outline" className="w-full" asChild>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
            Source code
          </a>
        </Button>
        <Button variant="outline" className="w-full" asChild>
          <a href="https://docs.dash.org/projects/platform" target="_blank" rel="noopener noreferrer">
            Documentation
          </a>
        </Button>
      </div>

      <div className="pt-6 border-t border-gray-200 dark:border-gray-800 space-y-3">
        <LegalLinks />
        <p className="text-center">
          <Link href="/settings?section=developer" className="text-xs text-gray-500 hover:underline">
            Developer tools
          </Link>
        </p>
        <p className="text-xs text-gray-500 text-center">
          Version <span className="font-mono">{version}</span>
        </p>
        <p className="mt-1 text-xs text-gray-500 text-center">
          © {new Date().getFullYear()} Yappr. All rights reserved.
        </p>
      </div>
    </div>
  )}

  const renderSection = () => {
    switch (activeSection) {
      case 'main':
        return renderMainSettings()
      case 'account':
        return renderAccountSettings()
      case 'contacts':
        return renderContactsSettings()
      case 'notifications':
        return renderNotificationSettings()
      case 'privacy':
        return renderPrivacySettings()
      case 'privateFeed':
        return privateFeedClientSupported() ? renderPrivateFeedSettings() : renderMainSettings()
      case 'storage':
        return renderStorageSettings()
      case 'appearance':
        return renderAppearanceSettings()
      case 'developer':
        return (
          <>
            <DeveloperSettings />
            {walletSession && <div className="p-6 pt-0"><WalletConnectionsSettings showBudgets /></div>}
          </>
        )
      case 'about':
        return renderAboutSettings()
      case 'moderation':
        return canModerate ? (
          <div className="space-y-4">
            {isContractModerator && <ContractModerationSections contracts={moderatedContracts} />}
            {isAuthority && <ModerationSettings />}
          </div>
        ) : renderMainSettings()
      default:
        return renderMainSettings()
    }
  }

  const getSectionTitle = () => {
    if (activeSection === 'main') return 'Settings'
    // Only surface the Moderation title to the authority (matches renderSection's
    // gate) so a non-authority hitting ?section=moderation doesn't see a
    // "Moderation" header over the fallback main menu.
    const section = visibleSections.find(s => s.id === activeSection)
    return section?.label || 'Settings'
  }

  return (
    <>
    <PageShell>
        <PageHeader>
          <div className="flex items-center gap-4 px-4 py-3">
            <TooltipButton
              label="Back"
              tooltipClassName="z-50"
              onClick={handleBack}
              className="-ml-2 border-0 dark:hover:bg-gray-900"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </TooltipButton>
            <h1 className="text-xl font-bold">{getSectionTitle()}</h1>
          </div>
        </PageHeader>

        <motion.div
          key={activeSection}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.2 }}
        >
          {activeSection === 'main' && (
            <div className="px-4 pt-4">
              <OwnWarningsNotice />
              <OwnWarningsNotice contract="storefront" />
              <OwnWarningsNotice contract="blog" />
            </div>
          )}
          {renderSection()}
        </motion.div>
    </PageShell>

      {/* Username Registration Modal */}
      <UsernameModal
        isOpen={isUsernameModalOpen}
        onClose={() => {
          setIsUsernameModalOpen(false)
          refreshUsernames().catch(err => logger.error('Failed to refresh usernames:', err))
        }}
        hasExistingUsernames={dpnsUsernames.length > 0}
      />
    </>
  )
}

/** Credits as DASH (1 DASH = 100,000,000,000 credits) to four places, like a wallet's summary; dust shows as "<0.0001". */
function formatBalance(credits: number) {
  const dash = credits / 100000000000
  if (dash > 0 && dash < 0.0001) return '<0.0001 DASH'
  return `${dash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} DASH`
}

export default withAuth(SettingsPage)
