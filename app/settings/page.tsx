'use client'

import { useState, useEffect } from 'react'
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
  ExclamationTriangleIcon,
  UserGroupIcon,
  UserPlusIcon,
  LockClosedIcon,
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useTheme } from 'next-themes'
import * as Switch from '@radix-ui/react-switch'
import * as RadioGroup from '@radix-ui/react-radio-group'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import toast from 'react-hot-toast'
import { KeyBackupSettings } from '@/components/settings/key-backup-settings'
import { BlockedUsersSettings } from '@/components/settings/blocked-users'
import { PrivateFeedSettings } from '@/components/settings/private-feed-settings'
import { PrivateFeedFollowRequests } from '@/components/settings/private-feed-follow-requests'
import { PrivateFeedFollowers } from '@/components/settings/private-feed-followers'
import { PrivateFeedDashboard } from '@/components/settings/private-feed-dashboard'
import { BlockListSettings } from '@/components/settings/block-list-settings'
import { useDashPayContactsModal } from '@/hooks/use-dashpay-contacts-modal'
import { useSettingsStore } from '@/lib/store'
import { CORS_PROXY_INFO } from '@/hooks/use-link-preview'
import { UsernameModal } from '@/components/dpns/username-modal'

type SettingsSection = 'main' | 'account' | 'contacts' | 'notifications' | 'privacy' | 'privateFeed' | 'appearance' | 'about'
const VALID_SECTIONS: SettingsSection[] = ['main', 'account', 'contacts', 'notifications', 'privacy', 'privateFeed', 'appearance', 'about']

const settingsSections = [
  { id: 'account', label: 'Account', icon: UserIcon, description: 'Manage your account details' },
  { id: 'contacts', label: 'Contacts', icon: UserGroupIcon, description: 'Import contacts from Dash Pay' },
  { id: 'notifications', label: 'Notifications', icon: BellIcon, description: 'Control your notification preferences' },
  { id: 'privacy', label: 'Privacy & Security', icon: ShieldCheckIcon, description: 'Manage your privacy settings' },
  { id: 'privateFeed', label: 'Private Feed', icon: LockClosedIcon, description: 'Encrypted posts for approved followers' },
  { id: 'appearance', label: 'Appearance', icon: PaintBrushIcon, description: 'Customize how Yappr looks' },
  { id: 'about', label: 'About', icon: InformationCircleIcon, description: 'Learn more about Yappr' },
]

function SettingsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, logout } = useAuth()
  const { theme, setTheme } = useTheme()
  const linkPreviews = useSettingsStore((s) => s.linkPreviews)
  const setLinkPreviews = useSettingsStore((s) => s.setLinkPreviews)
  const sendReadReceipts = useSettingsStore((s) => s.sendReadReceipts)
  const setSendReadReceipts = useSettingsStore((s) => s.setSendReadReceipts)
  const notificationSettings = useSettingsStore((s) => s.notificationSettings)
  const setNotificationSettings = useSettingsStore((s) => s.setNotificationSettings)
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const setPotatoMode = useSettingsStore((s) => s.setPotatoMode)
  const feedLanguage = useSettingsStore((s) => s.feedLanguage)
  const setFeedLanguage = useSettingsStore((s) => s.setFeedLanguage)

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
  
  // Privacy settings
  const [privacySettings, setPrivacySettings] = useState({
    publicProfile: true,
    showActivity: true,
  })

  // Account creation date from profile
  const [accountCreatedAt, setAccountCreatedAt] = useState<Date | null>(null)

  // DPNS username state
  const [dpnsUsernames, setDpnsUsernames] = useState<string[]>([])
  const [isUsernameModalOpen, setIsUsernameModalOpen] = useState(false)

  // Fetch account creation date from profile
  useEffect(() => {
    if (!user?.identityId) return

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
        console.error('Failed to fetch profile creation date:', error)
      }
    }

    fetchProfileCreatedAt().catch(err => console.error('Failed to fetch profile created at:', err))
  }, [user?.identityId])

  // Fetch DPNS usernames
  useEffect(() => {
    if (!user?.identityId) return

    const fetchUsernames = async () => {
      try {
        const { dpnsService } = await import('@/lib/services/dpns-service')
        const usernames = await dpnsService.getAllUsernames(user.identityId)
        if (usernames.length > 0) {
          // Sort usernames: contested first, then shortest, then alphabetically
          // This matches the selection logic used across the app
          const sortedUsernames = await dpnsService.sortUsernamesByContested(usernames)
          setDpnsUsernames(sortedUsernames)
        } else {
          setDpnsUsernames([])
        }
      } catch (error) {
        console.error('Failed to fetch DPNS usernames:', error)
      }
    }

    fetchUsernames().catch(err => console.error('Failed to fetch usernames:', err))
  }, [user?.identityId])

  // Refresh DPNS usernames after registration
  const refreshUsernames = async () => {
    if (!user?.identityId) return
    try {
      const { dpnsService } = await import('@/lib/services/dpns-service')
      // Clear cache to get fresh data (pass undefined for username, identityId second)
      dpnsService.clearCache(undefined, user.identityId)
      const usernames = await dpnsService.getAllUsernames(user.identityId)
      if (usernames.length > 0) {
        // Sort usernames: contested first, then shortest, then alphabetically
        const sortedUsernames = await dpnsService.sortUsernamesByContested(usernames)
        setDpnsUsernames(sortedUsernames)
      } else {
        setDpnsUsernames([])
      }
    } catch (error) {
      console.error('Failed to refresh usernames:', error)
    }
  }

  const handleBack = () => {
    if (activeSection === 'main') {
      router.back()
    } else {
      // Navigate to main settings (removes query param)
      router.push('/settings')
    }
  }

  // TODO: Implement account deletion
  const handleDeleteAccount = () => {
    if (confirm('Are you sure you want to delete your account? This action cannot be undone.')) {
      toast.error('Account deletion is not yet implemented')
    }
  }

  const renderMainSettings = () => (
    <div className="divide-y divide-gray-200 dark:divide-gray-800">
      {settingsSections.map((section) => (
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

  const renderAccountSettings = () => (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="font-semibold mb-4">Account Information</h3>
        <div className="space-y-4 bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
          <div>
            <p className="text-sm text-gray-500">Identity ID</p>
            <p className="font-mono text-sm">{user?.identityId}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Balance</p>
            <p className="font-mono">
              {(() => {
                const balance = user?.balance || 0;
                // Balance is in credits, convert to DASH (1 DASH = 100,000,000,000 credits)
                const dashBalance = balance / 100000000000;
                return `${dashBalance.toFixed(8)} DASH`;
              })()}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Account Created</p>
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
        <h3 className="font-semibold mb-4">DPNS Usernames</h3>
        <div className="space-y-4">
          {dpnsUsernames.length > 0 ? (
            <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
              <p className="text-sm text-gray-500 mb-2">Registered Usernames</p>
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
                No usernames registered yet. Register a username to make it easier for others to find you.
              </p>
            </div>
          )}
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => setIsUsernameModalOpen(true)}
          >
            <UserPlusIcon className="h-4 w-4 mr-2" />
            {dpnsUsernames.length > 0 ? 'Register More Usernames' : 'Register Username'}
          </Button>
        </div>
      </div>

      <div>
        <h3 className="font-semibold mb-4">Account Actions</h3>
        <div className="space-y-3">
          <Button variant="outline" className="w-full justify-start" onClick={logout}>
            <KeyIcon className="h-4 w-4 mr-2" />
            Log Out
          </Button>
          <Button
            variant="outline"
            className="w-full justify-start text-red-600 hover:text-red-700 hover:border-red-300"
            onClick={handleDeleteAccount}
          >
            <ExclamationTriangleIcon className="h-4 w-4 mr-2" />
            Delete Account
          </Button>
        </div>
      </div>
    </div>
  )

  const renderContactsSettings = () => (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="font-semibold mb-4">Dash Pay Contacts</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Discover friends from Dash Pay who you haven&apos;t followed yet on Yappr.
        </p>
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => {
            useDashPayContactsModal.getState().open()
          }}
        >
          <UserGroupIcon className="h-5 w-5 mr-2" />
          Find Dash Pay Contacts
        </Button>
      </div>
    </div>
  )

  const renderNotificationSettings = () => (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="font-semibold mb-4">Push Notifications</h3>
        <div className="space-y-4">
          {Object.entries(notificationSettings).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between">
              <div>
                <p className="font-medium capitalize">{key}</p>
                <p className="text-sm text-gray-500">
                  {key === 'likes' && 'When someone likes your posts'}
                  {key === 'reposts' && 'When someone reposts your content'}
                  {key === 'replies' && 'When someone replies to you'}
                  {key === 'follows' && 'When someone follows you'}
                  {key === 'mentions' && 'When someone mentions you'}
                  {key === 'messages' && 'When you receive new messages'}
                </p>
              </div>
              <Switch.Root
                checked={value}
                onCheckedChange={(checked) =>
                  setNotificationSettings({ [key]: checked })
                }
                className={`w-11 h-6 rounded-full relative transition-colors ${
                  value ? 'bg-yappr-500' : 'bg-gray-200 dark:bg-gray-800'
                }`}
              >
                <Switch.Thumb className="block w-5 h-5 bg-white rounded-full transition-transform data-[state=checked]:translate-x-5 translate-x-0.5" />
              </Switch.Root>
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  const renderPrivacySettings = () => (
    <div className="p-6 space-y-6">
      {/* Key Backup Section */}
      <KeyBackupSettings />

      <div>
        <h3 className="font-semibold mb-4">Privacy</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Public Profile</p>
              <p className="text-sm text-gray-500">Allow anyone to view your profile</p>
            </div>
            <Switch.Root
              checked={privacySettings.publicProfile}
              onCheckedChange={(checked) => 
                setPrivacySettings(prev => ({ ...prev, publicProfile: checked }))
              }
              className={`w-11 h-6 rounded-full relative transition-colors ${
                privacySettings.publicProfile ? 'bg-yappr-500' : 'bg-gray-200 dark:bg-gray-800'
              }`}
            >
              <Switch.Thumb className="block w-5 h-5 bg-white rounded-full transition-transform data-[state=checked]:translate-x-5 translate-x-0.5" />
            </Switch.Root>
          </div>
          
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Show Activity Status</p>
              <p className="text-sm text-gray-500">Let others see when you&apos;re active</p>
            </div>
            <Switch.Root
              checked={privacySettings.showActivity}
              onCheckedChange={(checked) =>
                setPrivacySettings(prev => ({ ...prev, showActivity: checked }))
              }
              className={`w-11 h-6 rounded-full relative transition-colors ${
                privacySettings.showActivity ? 'bg-yappr-500' : 'bg-gray-200 dark:bg-gray-800'
              }`}
            >
              <Switch.Thumb className="block w-5 h-5 bg-white rounded-full transition-transform data-[state=checked]:translate-x-5 translate-x-0.5" />
            </Switch.Root>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Link Previews</p>
              <p className="text-sm text-gray-500">Show previews with titles, descriptions, and images for links</p>
            </div>
            <Switch.Root
              checked={linkPreviews}
              onCheckedChange={setLinkPreviews}
              className={`w-11 h-6 rounded-full relative transition-colors ${
                linkPreviews ? 'bg-yappr-500' : 'bg-gray-200 dark:bg-gray-800'
              }`}
            >
              <Switch.Thumb className="block w-5 h-5 bg-white rounded-full transition-transform data-[state=checked]:translate-x-5 translate-x-0.5" />
            </Switch.Root>
          </div>
          {linkPreviews && (
            <div className="ml-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <p className="text-sm text-amber-800 dark:text-amber-200">
                <strong>Privacy note:</strong> {CORS_PROXY_INFO.warning}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-2">
                Third-party services used:{' '}
                {CORS_PROXY_INFO.proxies.map((p, i) => (
                  <span key={p.name}>
                    {i > 0 && ', '}
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-amber-900 dark:hover:text-amber-100"
                    >
                      {p.name}
                    </a>
                  </span>
                ))}
              </p>
            </div>
          )}
        </div>
      </div>
      
      <div>
        <h3 className="font-semibold mb-4">Direct Messages</h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Read Receipts</p>
            <p className="text-sm text-gray-500">Let others see when you&apos;ve read their messages</p>
          </div>
          <Switch.Root
            checked={sendReadReceipts}
            onCheckedChange={setSendReadReceipts}
            className={`w-11 h-6 rounded-full relative transition-colors ${
              sendReadReceipts ? 'bg-yappr-500' : 'bg-gray-200 dark:bg-gray-800'
            }`}
          >
            <Switch.Thumb className="block w-5 h-5 bg-white rounded-full transition-transform data-[state=checked]:translate-x-5 translate-x-0.5" />
          </Switch.Root>
        </div>
      </div>

      {/* Block Lists Section */}
      <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
        <BlockListSettings />
      </div>

      {/* Blocked Users Section */}
      <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
        <BlockedUsersSettings />
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
            <p className="font-medium">Potato Mode</p>
            <p className="text-sm text-gray-500">
              Disable blur effects and visual flair. Enable this if Yappr feels sluggish on your device.
            </p>
          </div>
          <Switch.Root
            checked={potatoMode}
            onCheckedChange={setPotatoMode}
            className={`w-11 h-6 rounded-full relative transition-colors ${
              potatoMode ? 'bg-yappr-500' : 'bg-gray-200 dark:bg-gray-800'
            }`}
          >
            <Switch.Thumb className="block w-5 h-5 bg-white rounded-full transition-transform data-[state=checked]:translate-x-5 translate-x-0.5" />
          </Switch.Root>
        </div>
      </div>

      <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
        <h3 className="font-semibold mb-4">Feed Language</h3>
        <div>
          <p className="text-sm text-gray-500 mb-4">
            Choose the language for the &quot;For You&quot; feed. Posts in other languages will not appear.
          </p>
          <select
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
    </div>
  )

  const renderPrivateFeedSettings = () => {
    // Check for action=reset URL param to auto-open reset dialog
    const actionParam = searchParams.get('action')
    const shouldOpenReset = actionParam === 'reset'

    // Clear the URL param when opening the reset dialog to prevent re-open on re-render
    const handleResetDialogOpened = () => {
      if (shouldOpenReset) {
        router.replace('/settings?section=privateFeed', { scroll: false })
      }
    }

    return (
      <div className="p-6 space-y-6">
        <PrivateFeedSettings openReset={shouldOpenReset} onResetOpened={handleResetDialogOpened} />
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

  const renderAboutSettings = () => {
    const commitHash = process.env.NEXT_PUBLIC_GIT_COMMIT_HASH || 'dev'
    const commitDate = process.env.NEXT_PUBLIC_GIT_COMMIT_DATE
    const branch = process.env.NEXT_PUBLIC_GIT_BRANCH || 'unknown'
    const formatDate = (dateStr: string | undefined) => {
      if (!dateStr) return ''
      try {
        return new Date(dateStr).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      } catch {
        return dateStr
      }
    }

    return (
    <div className="p-6 space-y-6">
      <div className="text-center py-8">
        <h1 className="text-4xl font-bold text-gradient mb-4">Yappr</h1>
        <p className="text-gray-500 mb-4">Decentralized social media on Dash Platform</p>

        <Button variant="outline" asChild>
          <Link href="/about">
            Learn More About Yappr
          </Link>
        </Button>
      </div>

      {/* Build Information */}
      <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 space-y-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Build Information</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <span className="text-gray-500">Commit:</span>
          <span className="font-mono text-gray-700 dark:text-gray-300">{commitHash}</span>

          <span className="text-gray-500">Branch:</span>
          <span className="font-mono text-gray-700 dark:text-gray-300">{branch}</span>

          {commitDate && (
            <>
              <span className="text-gray-500">Commit Date:</span>
              <span className="text-gray-700 dark:text-gray-300">{formatDate(commitDate)}</span>
            </>
          )}

        </div>
      </div>

      <div className="space-y-3">
        <Button variant="outline" className="w-full" asChild>
          <a href="https://github.com/pastapastapasta/yappr" target="_blank" rel="noopener noreferrer">
            GitHub Repository
          </a>
        </Button>
        <Button variant="outline" className="w-full" asChild>
          <a href="https://docs.dash.org/projects/platform" target="_blank" rel="noopener noreferrer">
            Documentation
          </a>
        </Button>
      </div>

      <div className="pt-6 border-t border-gray-200 dark:border-gray-800">
        <p className="text-xs text-gray-500 text-center">
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
        return renderPrivateFeedSettings()
      case 'appearance':
        return renderAppearanceSettings()
      case 'about':
        return renderAboutSettings()
      default:
        return renderMainSettings()
    }
  }

  const getSectionTitle = () => {
    if (activeSection === 'main') return 'Settings'
    const section = settingsSections.find(s => s.id === activeSection)
    return section?.label || 'Settings'
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className={`sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
          <div className="flex items-center gap-4 px-4 py-3">
            <button
              onClick={handleBack}
              className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <h1 className="text-xl font-bold">{getSectionTitle()}</h1>
          </div>
        </header>

        <motion.div
          key={activeSection}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.2 }}
        >
          {renderSection()}
        </motion.div>
        </main>
      </div>

      <RightSidebar />

      {/* Username Registration Modal */}
      <UsernameModal
        isOpen={isUsernameModalOpen}
        onClose={() => {
          setIsUsernameModalOpen(false)
          refreshUsernames().catch(err => console.error('Failed to refresh usernames:', err))
        }}
        hasExistingUsernames={dpnsUsernames.length > 0}
      />
    </div>
  )
}

export default withAuth(SettingsPage)