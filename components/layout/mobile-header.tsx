'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useAuth } from '@/contexts/auth-context'
import { UserAvatar } from '@/components/ui/avatar-image'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowRightOnRectangleIcon, Cog6ToothIcon } from '@heroicons/react/24/outline'
import { useLoginModal } from '@/hooks/use-login-modal'

export function MobileHeader() {
  const { user, logout } = useAuth()
  const openLoginModal = useLoginModal((s) => s.open)
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    setIsHydrated(true)
  }, [])

  return (
    <div className="md:hidden flex items-center justify-between px-4 py-2 border-b border-surface-200 dark:border-neutral-750 bg-white/90 dark:bg-surface-950/90 backdrop-blur-xl">
      <Link href="/" className="flex items-center gap-2">
        <span className="font-display text-xl text-gradient">Yappr</span>
        <Image
          src="/pbde-light.png"
          alt="Powered by Dash Evolution"
          width={80}
          height={27}
          className="dark:hidden"
          style={{ width: 'auto', height: 'auto' }}
        />
        <Image
          src="/pbde-dark.png"
          alt="Powered by Dash Evolution"
          width={80}
          height={27}
          className="hidden dark:block"
          style={{ width: 'auto', height: 'auto' }}
        />
      </Link>

      {user && isHydrated ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="h-8 w-8 rounded-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-yappr-500/50">
              <UserAvatar userId={user.identityId} size="sm" alt="Your avatar" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="min-w-[180px] bg-white dark:bg-surface-900 rounded-xl shadow-elevated-lg border border-surface-200 dark:border-neutral-750 py-2 z-50"
              sideOffset={8}
              align="end"
            >
              <DropdownMenu.Item asChild>
                <Link
                  href="/settings"
                  className="px-4 py-2 text-sm hover:bg-surface-100 dark:hover:bg-surface-800 cursor-pointer outline-none flex items-center gap-2 text-gray-700 dark:text-gray-300"
                >
                  <Cog6ToothIcon className="h-4 w-4" />
                  Settings
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="h-px bg-surface-200 dark:bg-neutral-750 my-1" />
              <DropdownMenu.Item
                className="px-4 py-2 text-sm hover:bg-surface-100 dark:hover:bg-surface-800 cursor-pointer outline-none flex items-center gap-2 text-gray-700 dark:text-gray-300"
                onClick={logout}
              >
                <ArrowRightOnRectangleIcon className="h-4 w-4" />
                Log out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : isHydrated ? (
        <button
          onClick={openLoginModal}
          className="text-sm font-semibold text-yappr-500 hover:text-yappr-600 transition-colors"
        >
          Sign In
        </button>
      ) : (
        <div className="h-8 w-8 rounded-full bg-surface-100 dark:bg-surface-800 animate-pulse" />
      )}
    </div>
  )
}
