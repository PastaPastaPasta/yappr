'use client'

import { useEffect, useState } from 'react'
import { ShieldExclamationIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'
import type { TargetKind } from '@/lib/contract-topology'
import { moderationService, type DocumentRemoval } from '@/lib/services/moderation-service'

interface RemovedPostStubProps {
  /** The id the reader expected and the chain no longer has. */
  documentId: string
  /** Omit when the caller cannot tell a post from a reply (an absent detail page). */
  kind?: TargetKind
  className?: string
  /** `card` renders as a feed item; `embed` as an inline quote box. */
  variant?: 'card' | 'embed'
  /**
   * True when a join PROVED the document absent (`missingIds`). Only then does
   * the stub assert a takedown before the removal record is in hand; a document
   * that merely failed to load says "unavailable" until a record proves otherwise.
   */
  proven?: boolean
}

/**
 * The hole a moderator-removed post or reply leaves: the document is gone
 * (a fetch returns nothing and by-id joins list it in `missingIds`), and the
 * only trace is the removal record, which this resolves lazily so a page of
 * intact posts pays nothing for it.
 */
export function RemovedPostStub({ documentId, kind, className, variant = 'embed', proven = false }: RemovedPostStubProps) {
  // Null until (and unless) a record is found: the stub reads the same either
  // way, so there is no separate "still looking" rendering to distinguish.
  const [removal, setRemoval] = useState<DocumentRemoval | null>(null)

  useEffect(() => {
    let cancelled = false
    // Removal records are kept per document type; an unknown kind asks both.
    const kinds: TargetKind[] = kind ? [kind] : ['post', 'reply']
    Promise.all(kinds.map((k) => moderationService.getRemovals(k, [documentId])))
      .then((pages) => {
        if (!cancelled) setRemoval(pages.map((page) => page.get(documentId)).find(Boolean) ?? null)
      })
      .catch(() => {
        if (!cancelled) setRemoval(null)
      })
    return () => {
      cancelled = true
    }
  }, [documentId, kind])

  const noun = kind === 'reply' ? 'reply' : 'post'
  const removed = proven || removal !== null
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
        {removed ? `This ${noun} was removed by the contract's moderators.` : `This ${noun} is unavailable.`}
      </p>
      {removal?.reason && <p className="mt-1 not-italic">Reason: {removal.reason}</p>}
    </div>
  )
}
