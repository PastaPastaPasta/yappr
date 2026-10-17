'use client'

import { useEffect, useState } from 'react'
import { XMarkIcon } from '@heroicons/react/20/solid'
import { getConfiguredNetwork } from '@/lib/constants'
import { readScoped, writeScoped } from '@/lib/storage-scope'

const DISMISSED_KEY = 'yappr_network_pill_dismissed'

const LABELS = {
  testnet: { name: 'Testnet', detail: 'Yappr is running on the Dash test network.' },
  devnet: { name: 'Devnet', detail: 'Yappr is running on a Dash development network. Its data may be reset.' },
} as const

/**
 * A small label hanging from the top edge naming the test network the build
 * runs on. Never rendered on mainnet; dismissing it hides it on this browser.
 */
export function NetworkPill() {
  const network = getConfiguredNetwork()
  // Hidden until mounted: the dismissal lives in localStorage, which the static HTML cannot know.
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    setDismissed(readScoped(DISMISSED_KEY) === '1')
  }, [])

  if (network === 'mainnet' || dismissed) return null
  const { name, detail } = LABELS[network]

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[45] flex justify-center">
      <div
        data-testid="network-pill"
        title={detail}
        className="pointer-events-auto flex items-center gap-0.5 rounded-b-lg bg-amber-100 py-0.5 pl-2.5 pr-1 text-[11px] font-semibold leading-4 text-amber-900 shadow-sm ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900"
      >
        <span>{name}</span>
        <span className="sr-only">. {detail}</span>
        <button
          type="button"
          aria-label={`Hide the ${name} label`}
          onClick={() => {
            writeScoped(DISMISSED_KEY, '1')
            setDismissed(true)
          }}
          className="rounded-full p-0.5 text-amber-700 hover:bg-amber-200 hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300 dark:hover:bg-amber-900"
        >
          <XMarkIcon className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
