'use client'

import { useEffect, useState } from 'react'
import { ShieldExclamationIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'
import type { TargetKind } from '@/lib/contract-topology'
import { moderationService, type DocumentRemoval } from '@/lib/services/moderation-service'

interface RemovedPostStubProps {
  /** The id the reader expected and the chain no longer has. */
  documentId: string
  kind: TargetKind
  className?: string
  /** `card` renders as a feed item; `embed` as an inline quote box. */
  variant?: 'card' | 'embed'
}

/**
 * The hole a moderator-removed post or reply leaves: the document is gone
 * (a fetch returns nothing and by-id joins list it in `missingIds`), and the
 * only trace is the removal record, which this resolves lazily so a page of
 * intact posts pays nothing for it.
 */
export function RemovedPostStub({ documentId, kind, className, variant = 'embed' }: RemovedPostStubProps) {
  const [removal, setRemoval] = useState<DocumentRemoval | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    moderationService.getRemovals(kind, [documentId]).then((removals) => {
      if (!cancelled) setRemoval(removals.get(documentId) ?? null)
    }).catch(() => {
      if (!cancelled) setRemoval(null)
    })
    return () => {
      cancelled = true
    }
  }, [documentId, kind])

  const noun = kind === 'reply' ? 'reply' : 'post'
  return (
    <div
      data-testid={`removed-${noun}-${documentId}`}
      className={cn(
        'text-sm text-gray-500 dark:text-gray-400',
        variant === 'embed'
          ? 'mt-3 border border-gray-200 dark:border-gray-700 rounded-xl p-3'
          : 'px-4 py-3 border-b border-gray-200 dark:border-gray-800',
        className
      )}
    >
      <p className="flex items-center gap-2 italic">
        <ShieldExclamationIcon className="h-4 w-4 shrink-0" />
        This {noun} was removed by the contract&apos;s moderators.
      </p>
      {removal?.reason && <p className="mt-1 not-italic">Reason: {removal.reason}</p>}
    </div>
  )
}
