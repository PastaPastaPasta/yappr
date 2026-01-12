'use client'

import { useState } from 'react'
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
  UserGroupIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useTheme } from 'next-themes'
import * as Switch from '@radix-ui/react-switch'
import * as RadioGroup from '@radix-ui/react-radio-group'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { KeyBackupSettings } from '@/components/settings/key-backup-settings'
import { BlockedUsersSettings } from '@/components/settings/blocked-users'
import { BlockListSettings } from '@/components/settings/block-list-settings'
import { useDashPayContactsModal } from '@/hooks/use-dashpay-contacts-modal'

type SettingsSection = 'main' | 'account' | 'contacts' | 'notifications' | 'privacy' | 'appearance' | 'about'

const settingsSections = [
  { id: 'account', label: 'Account', icon: UserIcon, description: 'Manage your account details' },
  { id: 'contacts', label: 'Contacts', icon: UserGroupIcon, description: 'Import contacts from Dash Pay' },
  { id: 'notifications', label: 'Notifications', icon: BellIcon, description: 'Control your notification preferences' },
  { id: 'privacy', label: 'Privacy & Security', icon: ShieldCheckIcon, description: 'Manage your privacy settings' },
  { id: 'appearance', label: 'Appearance', icon: PaintBrushIcon, description: 'Customize how Yappr looks' },
  { id: 'about', label: 'About', icon: InformationCircleIcon, description: 'Learn more about Yappr' },
]

function SettingsPage() {
  const router = useRouter()
  const { user, logout } = useAuth()
  const { theme, setTheme } = useTheme()
  const [activeSection, setActiveSection] = useState<SettingsSection>('main')
  
  // Notification settings
  const [notificationSettings, setNotificationSettings] = useState({
    likes: true,
    reposts: true,
    replies: true,
    follows: true,
    mentions: true,
    messages: true,
  })
  
  // Privacy settings
  const [privacySettings, setPrivacySettings] = useState({
    publicProfile: true,
    showActivity: true,
    allowMessages: 'everyone', // 'everyone', 'followers', 'none'
  })

  const handleBack = () => {
    if (activeSection === 'main') {
      router.back()
    } else {
      setActiveSection('main')
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
            <p className="text-sm">January 2024</p>
          </div>
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
                  setNotificationSettings(prev => ({ ...prev, [key]: checked }))
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
        </div>
      </div>
      
      <div>
        <h3 className="font-semibold mb-4">Direct Messages</h3>
        <RadioGroup.Root
          value={privacySettings.allowMessages}
          onValueChange={(value) => 
            setPrivacySettings(prev => ({ ...prev, allowMessages: value }))
          }
          className="space-y-3"
        >
          <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950">
            <RadioGroup.Item
              value="everyone"
              className="w-5 h-5 rounded-full border-2 border-gray-300 dark:border-gray-700 data-[state=checked]:border-yappr-500"
            >
              <RadioGroup.Indicator className="flex items-center justify-center w-full h-full after:block after:w-2.5 after:h-2.5 after:rounded-full after:bg-yappr-500" />
            </RadioGroup.Item>
            <label htmlFor="everyone" className="flex-1 cursor-pointer">
              <p className="font-medium">Everyone</p>
              <p className="text-sm text-gray-500">Anyone can message you</p>
            </label>
          </div>
          
          <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950">
            <RadioGroup.Item
              value="followers"
              className="w-5 h-5 rounded-full border-2 border-gray-300 dark:border-gray-700 data-[state=checked]:border-yappr-500"
            >
              <RadioGroup.Indicator className="flex items-center justify-center w-full h-full after:block after:w-2.5 after:h-2.5 after:rounded-full after:bg-yappr-500" />
            </RadioGroup.Item>
            <label htmlFor="followers" className="flex-1 cursor-pointer">
              <p className="font-medium">Followers Only</p>
              <p className="text-sm text-gray-500">Only people you follow can message you</p>
            </label>
          </div>
          
          <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950">
            <RadioGroup.Item
              value="none"
              className="w-5 h-5 rounded-full border-2 border-gray-300 dark:border-gray-700 data-[state=checked]:border-yappr-500"
            >
              <RadioGroup.Indicator className="flex items-center justify-center w-full h-full after:block after:w-2.5 after:h-2.5 after:rounded-full after:bg-yappr-500" />
            </RadioGroup.Item>
            <label htmlFor="none" className="flex-1 cursor-pointer">
              <p className="font-medium">No One</p>
              <p className="text-sm text-gray-500">Disable direct messages</p>
            </label>
          </div>
        </RadioGroup.Root>
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
    </div>
  )

  const renderAboutSettings = () => (
    <div className="p-6 space-y-6">
      <div className="text-center py-8">
        <h1 className="text-4xl font-bold text-gradient mb-4">Yappr</h1>
        <p className="text-gray-500 mb-8">Decentralized social media on Dash Platform</p>
        
        <div className="space-y-2 text-sm text-gray-500">
          <p>Version 1.0.0</p>
          <p>Built with Next.js, React, and Dash Platform</p>
        </div>
      </div>
      
      <div className="space-y-3">
        <Button variant="outline" className="w-full" asChild>
          <Link href="/contract">
            View Data Contract
          </Link>
        </Button>
        <Button variant="outline" className="w-full" asChild>
          <a href="https://github.com/dashpay/platform" target="_blank" rel="noopener noreferrer">
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
          © 2024 Yappr. All rights reserved.
        </p>
      </div>
    </div>
  )

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
        <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
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
    </div>
  )
}

export default withAuth(SettingsPage)