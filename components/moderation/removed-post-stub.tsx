'use client'

import { useEffect, useState } from 'react'
import { ExclamationTriangleIcon, ShieldExclamationIcon, TrashIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'
import { authorDeletesLeaveHoles, type TargetKind } from '@/lib/contract-topology'
import { provenAbsent } from '@/lib/feed/prove-absent'
import { missingDocumentState, moderationService, type DocumentRemoval } from '@/lib/services/moderation-service'

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
  /**
   * True when the viewer's own moderator action just removed it. The fresh
   * removal record may not be readable yet, and the hole must never read as
   * the author's delete meanwhile, so no absence is proved here.
   */
  removedByModerator?: boolean
}

/** A stub's frame: a feed item (`card`) or an inline quote box (`embed`). */
function stubFrameClass(variant: 'card' | 'embed', className?: string): string {
  return cn(
    'text-sm text-gray-500 dark:text-gray-400',
    variant === 'embed'
      ? 'mt-3 border border-gray-200 dark:border-gray-700 rounded-xl p-3'
      : 'px-4 py-3 border-b border-gray-200 dark:border-gray-800',
    className
  )
}

/**
 * The hole a moderator-removed post or reply leaves: the document is gone
 * (a fetch returns nothing and by-id joins list it in `missingIds`), and the
 * only trace is the removal record, which this resolves lazily so a page of
 * intact posts pays nothing for it. On v10 authors delete for real too, so a
 * proven absence with no record reads as the author's own delete. A
 * takedown shows the moderators' reason when the record gives one, and
 * nothing else of what the record kept.
 */
export function RemovedPostStub({ documentId, kind, className, variant = 'embed', proven = false, removedByModerator = false }: RemovedPostStubProps) {
  // Null until (and unless) a record is found.
  const [removal, setRemoval] = useState<DocumentRemoval | null>(null)
  // True once the record lookup ANSWERED. On v10 a proven hole with no record
  // is the author's delete, but only a lookup that succeeded can say "no
  // record": while it is pending, or after it failed, a takedown would read
  // as the author's delete, so the stub claims neither.
  const [recordsRead, setRecordsRead] = useState(false)
  // Where authors delete for real (v10), a hole nobody proved yet is proved
  // here: absent from its doctype with no removal record is the author's
  // delete rather than a failed read. Only for a known kind, which callers
  // pass for references that once resolved (a thread root, a quote); a bare
  // detail-page id may never have existed, so it keeps saying "unavailable".
  const [provedHere, setProvedHere] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Removal records are kept per document type; an unknown kind asks both.
    const kinds: TargetKind[] = kind ? [kind] : ['post', 'reply']
    setRecordsRead(false)
    setProvedHere(false)
    Promise.all(kinds.map((k) => moderationService.readRemovals(k, [documentId])))
      .then(async (pages) => {
        const found = pages.map((page) => page.get(documentId)).find(Boolean) ?? null
        if (cancelled) return
        setRemoval(found)
        setRecordsRead(true)
        // Only once no standing record claims it, so a takedown never reads
        // as the author's delete while its record is still loading. A
        // restored record still needs the proof: the author may have deleted
        // the document after it came back.
        if (found?.restoredAt === null || proven || removedByModerator || !kind || !authorDeletesLeaveHoles()) return
        const absent = await provenAbsent(kind, [documentId])
        if (!cancelled) setProvedHere(absent.has(documentId))
      })
      // A failed lookup leaves recordsRead false: the hole stays neutral.
      .catch(() => {
        if (!cancelled) setRemoval(null)
      })
    return () => {
      cancelled = true
    }
  }, [documentId, kind, proven, removedByModerator])

  const noun = kind === 'reply' ? 'reply' : 'post'
  const state = missingDocumentState(removal, proven || provedHere, { recordsRead })
  const Icon = state === 'loadFailed' ? ExclamationTriangleIcon : state === 'deleted' ? TrashIcon : ShieldExclamationIcon
  return (
    <div
      data-testid={`removed-${noun}-${documentId}`}
      className={stubFrameClass(variant, className)}
    >
      <p className="flex items-center gap-2 italic">
        <Icon className="h-4 w-4 shrink-0" />
        {state === 'removed'
          ? `This ${noun} was removed by community moderators.`
          : state === 'deleted'
            ? `This ${noun} was deleted by its author.`
            : state === 'loadFailed'
            ? `This ${noun} could not be loaded. Try again later.`
            : `This ${noun} is unavailable.`}
      </p>
      {state === 'removed' && removal?.reason && <p className="mt-1 not-italic">Reason: {removal.reason}</p>}
    </div>
  )
}

/**
 * A post or reply its author tombstoned (v11, {@link tombstonesAreHidden}):
 * the document still exists, `deleted` and blank, so unlike
 * {@link RemovedPostStub} there is no record to look up and no doubt about
 * who removed it. Holds the place of a thread parent with live replies, a
 * quote's target or a direct link, and offers nothing to interact with.
 */
export function AuthorDeletedStub({ documentId, kind, className, variant = 'embed' }: Pick<RemovedPostStubProps, 'documentId' | 'kind' | 'className' | 'variant'>) {
  const noun = kind === 'reply' ? 'reply' : 'post'
  return (
    <div
      data-testid={`tombstoned-${noun}-${documentId}`}
      className={stubFrameClass(variant, className)}
    >
      <p className="flex items-center gap-2 italic">
        <TrashIcon className="h-4 w-4 shrink-0" />
        {`This ${noun} was deleted by its author.`}
      </p>
    </div>
  )
}
