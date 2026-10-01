'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExclamationTriangleIcon, ShieldExclamationIcon, TrashIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'
import { authorDeletesLeaveHoles, type TargetKind } from '@/lib/contract-topology'
import { provenAbsent } from '@/lib/feed/prove-absent'
import { missingDocumentState, moderationService, postedOnLabel, type DocumentRemoval } from '@/lib/services/moderation-service'

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

/**
 * The hole a moderator-removed post or reply leaves: the document is gone
 * (a fetch returns nothing and by-id joins list it in `missingIds`), and the
 * only trace is the removal record, which this resolves lazily so a page of
 * intact posts pays nothing for it. On v10 authors delete for real too, so a
 * proven absence with no record reads as the author's own delete.
 *
 * On v11 a removal record keeps a post's hashtag and a post's or reply's
 * `$createdAt` (and a reply's `rootPostId`), so a takedown's hole still says
 * where it was and when it was written: "#dash · posted Sep 30".
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
      className={cn(
        'text-sm text-gray-500 dark:text-gray-400',
        variant === 'embed'
          ? 'mt-3 border border-gray-200 dark:border-gray-700 rounded-xl p-3'
          : 'px-4 py-3 border-b border-gray-200 dark:border-gray-800',
        className
      )}
    >
      <p className="flex items-center gap-2 italic">
        <Icon className="h-4 w-4 shrink-0" />
        {state === 'removed'
          ? `This ${noun} was removed by the contract's moderators.`
          : state === 'deleted'
            ? `This ${noun} was deleted by its author.`
            : state === 'loadFailed'
            ? `This ${noun} could not be loaded. Try again later.`
            : `This ${noun} is unavailable.`}
      </p>
      {state === 'removed' && removal?.reason && <p className="mt-1 not-italic">Reason: {removal.reason}</p>}
      {state === 'removed' && removal && <KeptFieldsLine removal={removal} showThread={variant === 'embed'} />}
    </div>
  )
}

/**
 * What the removal record kept of the document (v11): the hashtag it was in,
 * when it was written and, for a quoted reply, a link to its thread. Nothing
 * when the record keeps none.
 */
function KeptFieldsLine({ removal, showThread }: { removal: DocumentRemoval; showThread: boolean }) {
  const { hashtag, createdAt, rootPostId } = removal.kept
  const thread = showThread ? rootPostId : undefined
  if (!hashtag && createdAt === undefined && !thread) return null
  // The stub can sit inside a clickable card: a link here must not also open the card.
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const parts: React.ReactNode[] = []
  if (hashtag) {
    parts.push(
      <Link key="tag" href={`/hashtag?tag=${encodeURIComponent(hashtag)}`} onClick={stop} className="text-yappr-500 hover:underline">
        #{hashtag}
      </Link>
    )
  }
  if (createdAt !== undefined) parts.push(<span key="posted">posted {postedOnLabel(createdAt)}</span>)
  if (thread) {
    parts.push(
      <Link key="thread" href={`/post?id=${encodeURIComponent(thread)}`} onClick={stop} className="text-yappr-500 hover:underline">
        view thread
      </Link>
    )
  }
  return (
    <p data-testid={`removed-kept-${removal.documentId}`} className="mt-1 not-italic">
      {parts.map((part, index) => (
        <span key={index}>{index > 0 && ' · '}{part}</span>
      ))}
    </p>
  )
}
