'use client'

import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { GiftIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { useAuth } from '@/contexts/auth-context'
import { tokenService } from '@/lib/services/token-service'
import { useBuyYappModal } from '@/hooks/use-buy-yapp-modal'
import { useStarterGrantModal } from '@/hooks/use-starter-grant-modal'
import { yappTopUp } from '@/lib/starter-grant'

/**
 * YAPP balance + "Buy" row for the account dropdown. Mirrors the credits
 * Balance row's styling and sits directly beneath it. Where YAPP cannot be
 * bought (v10) the row offers the starter grant instead, and once that is
 * claimed it shows the balance alone.
 */
export function YappBalanceItem() {
  const { user } = useAuth()
  const openBuy = useBuyYappModal((s) => s.open)
  const openGrant = useStarterGrantModal((s) => s.open)
  const [yapp, setYapp] = useState<bigint | null>(null)
  const identityId = user?.identityId

  useEffect(() => {
    // Clear the previous identity's balance immediately so an account switch
    // never keeps showing the old user's YAPP while the new fetch is in flight.
    setYapp(null)
    if (!identityId) return
    let cancelled = false
    const refresh = () => {
      tokenService.getBalance(identityId)
        .then((b) => { if (!cancelled) setYapp(b) })
        .catch(() => { if (!cancelled) setYapp(null) })
    }
    refresh()
    window.addEventListener('yapp-balance-changed', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('yapp-balance-changed', refresh)
    }
  }, [identityId])

  if (!user) return null

  const topUp = yappTopUp(user.identityId)
  const balance = (
    <div>
      <div className="text-xs text-gray-500">YAPP</div>
      <div className="font-mono">{yapp !== null ? yapp.toString() : '…'}</div>
    </div>
  )

  return (
    <>
      {topUp === null ? (
        <DropdownMenu.Label className="px-4 py-3 text-sm">{balance}</DropdownMenu.Label>
      ) : (
        /* The whole row is the actionable menu item so it's reachable/operable by
           keyboard (Enter/Space) and avoids an interactive control nested in a
           role="menuitem". The "Buy" pill is a visual affordance only. */
        <DropdownMenu.Item
          className="px-4 py-3 text-sm outline-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-900 data-[highlighted]:bg-gray-100 dark:data-[highlighted]:bg-gray-900"
          onSelect={() => (topUp === 'buy' ? openBuy() : openGrant())}
        >
          <div className="flex items-center justify-between">
            {balance}
            <span className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium bg-yappr-500 text-white">
              {topUp === 'buy'
                ? <><SparklesIcon className="h-3.5 w-3.5" /> Buy</>
                : <><GiftIcon className="h-3.5 w-3.5" /> Claim</>}
            </span>
          </div>
        </DropdownMenu.Item>
      )}
      <DropdownMenu.Separator className="h-px bg-gray-200 dark:bg-gray-800 my-1" />
    </>
  )
}
