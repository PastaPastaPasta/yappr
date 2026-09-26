'use client'

import { useRouter } from 'next/navigation'
import { NoSymbolIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logger'
import { useBlockProvenance } from '@/hooks/use-block'

interface BlockedOwnerBannerProps {
  ownerId: string | undefined
  className?: string
}

const BUTTON_CLASS = 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40'

/**
 * Warns that the viewer blocks this store's owner. An own block can be lifted
 * here; a block inherited from a followed block list can only be managed in
 * privacy settings, so that case links there instead.
 */
export function BlockedOwnerBanner({ ownerId, className = '' }: BlockedOwnerBannerProps) {
  const router = useRouter()
  const { isBlocked, isOwnBlock, isLoading, unblock } = useBlockProvenance(ownerId)

  if (!isBlocked) return null

  return (
    <div role="alert" className={`p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg ${className}`}>
      <div className="flex items-center gap-3">
        <NoSymbolIcon className="h-6 w-6 flex-shrink-0 text-red-500" aria-hidden="true" />
        <div className="flex-1">
          <p className="font-medium text-red-700 dark:text-red-400">
            {isOwnBlock ? 'You have blocked this store owner' : 'This store owner is blocked'}
          </p>
          <p className="text-sm text-red-600 dark:text-red-400/80">
            {isOwnBlock
              ? "This store won't appear in store listings."
              : "Blocked by a block list you follow. This store won't appear in store listings."}
          </p>
        </div>
        {isOwnBlock ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => { unblock().catch((error) => logger.error('BlockedOwnerBanner: unblock failed:', error)) }}
            disabled={isLoading}
            className={BUTTON_CLASS}
          >
            Unblock
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push('/settings?section=privacy')}
            className={BUTTON_CLASS}
          >
            Manage block lists
          </Button>
        )}
      </div>
    </div>
  )
}
