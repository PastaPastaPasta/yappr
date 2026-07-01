'use client'

import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { SparklesIcon } from '@heroicons/react/24/outline'
import { useAuth } from '@/contexts/auth-context'
import { tokenService } from '@/lib/services/token-service'
import { useBuyYappModal } from '@/hooks/use-buy-yapp-modal'

/**
 * YAPP balance + "Buy" row for the account dropdown. Mirrors the credits
 * Balance row's styling and sits directly beneath it.
 */
export function YappBalanceItem() {
  const { user } = useAuth()
  const openBuy = useBuyYappModal((s) => s.open)
  const [yapp, setYapp] = useState<bigint | null>(null)

  useEffect(() => {
    if (!user) return
    const refresh = () => tokenService.getBalance(user.identityId).then(setYapp).catch(() => setYapp(null))
    refresh()
    window.addEventListener('yapp-balance-changed', refresh)
    return () => window.removeEventListener('yapp-balance-changed', refresh)
  }, [user])

  if (!user) return null

  return (
    <>
      <DropdownMenu.Item className="px-4 py-3 text-sm outline-none" disabled onSelect={(e) => e.preventDefault()}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-gray-500">YAPP</div>
            <div className="font-mono">{yapp !== null ? yapp.toString() : '…'}</div>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); openBuy() }}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium bg-yappr-500 text-white hover:bg-yappr-600 transition-colors"
            title="Buy YAPP"
          >
            <SparklesIcon className="h-3.5 w-3.5" /> Buy
          </button>
        </div>
      </DropdownMenu.Item>
      <DropdownMenu.Separator className="h-px bg-gray-200 dark:bg-gray-800 my-1" />
    </>
  )
}
