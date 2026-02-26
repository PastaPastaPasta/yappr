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
    <div className="md:hidden flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900">
      <Link href="/welcome" className="flex items-center gap-2">
        <span className="text-xl font-bold text-gradient">Yappr</span>
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
            <button className="h-8 w-8 rounded-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-yappr-500">
              <UserAvatar userId={user.identityId} size="sm" alt="Your avatar" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="min-w-[180px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50"
              sideOffset={8}
              align="end"
            >
              <DropdownMenu.Item asChild>
                <Link
                  href="/settings"
                  className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none flex items-center gap-2"
                >
                  <Cog6ToothIcon className="h-4 w-4" />
                  Settings
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="h-px bg-gray-200 dark:bg-gray-800 my-1" />
              <DropdownMenu.Item
                className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none flex items-center gap-2"
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
          className="text-sm font-medium text-yappr-500 hover:text-yappr-600"
        >
          Sign In
        </button>
      ) : (
        <div className="h-8 w-8 rounded-full bg-gray-200 dark:bg-gray-800 animate-pulse" />
      )}
    </div>
  )
}
