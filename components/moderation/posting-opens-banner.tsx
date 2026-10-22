'use client'

import { useEffect, useState } from 'react'
import { ClockIcon } from '@heroicons/react/24/outline'
import { useSdk } from '@/contexts/sdk-context'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { moderatedContract } from '@/lib/moderated-contracts'
import { watchModeratedTypeOpen } from '@/lib/moderated-type-gate'
import {
  announcesOpening,
  parseCachedOpening,
  postingOpening,
  postingOpensText,
  serializeOpening,
  type PostingOpening,
} from '@/lib/posting-opens'
import { readScoped, removeScoped, writeScoped } from '@/lib/storage-scope'
import { moderationElectionService } from '@/lib/services/moderation-election-service'
import { moderationServiceFor } from '@/lib/services/moderation-service'
import { cn } from '@/lib/utils'

const CACHE_KEY = 'posting-opens'
/** The election status is several reads; every page that shows the banner shares one answer for this long. */
const SHARE_MS = 60_000

let shared: { at: number; answer: Promise<PostingOpening> } | null = null

/**
 * Whether posting is closed on the social contract and, if so, when it opens.
 * One cheap read first (the moderation service's cached team read): an open
 * contract never pays for the election walk.
 */
async function readOpening(): Promise<PostingOpening> {
  if (await moderationServiceFor('social').moderatedTypeOpen('post')) return { kind: 'open' }
  return postingOpening(await moderationElectionService.getStatus(YAPPR_CONTRACT_ID), Date.now())
}

function loadOpening(): Promise<PostingOpening> {
  if (!shared || Date.now() - shared.at >= SHARE_MS) {
    const entry = { at: Date.now(), answer: readOpening() }
    shared = entry
    // A failed read must not pin its failure for the minute.
    entry.answer.catch(() => {
      if (shared === entry) shared = null
    })
  }
  return shared.answer
}

/**
 * The opening time to announce, or null while there is nothing to announce:
 * posting is open, the contract is not closed by a `notYetUsable` interim
 * (/devnet and older cuts), the answer is not read yet, or it could not be.
 *
 * The last answer is remembered for a day and painted on mount, so a repeat
 * visit shows the banner in the first frame and the chain only confirms it
 * (or lifts it, once a team is seated). It keeps asking while posting is closed
 * (every minute, and when the window regains focus), like the compose gate.
 */
function usePostingOpening(): PostingOpening | null {
  const closedByInterim = moderatedContract('social').elected()?.interim === 'notYetUsable'
  const { isReady: sdkReady } = useSdk()
  const [opening, setOpening] = useState<PostingOpening | null>(null)

  useEffect(() => {
    if (!closedByInterim) return
    const remembered = parseCachedOpening(readScoped(CACHE_KEY), Date.now())
    if (remembered) setOpening(remembered)
  }, [closedByInterim])

  useEffect(() => {
    if (!closedByInterim || !sdkReady) return
    return watchModeratedTypeOpen(
      async () => {
        const answer = await loadOpening()
        if (answer.kind === 'open') {
          removeScoped(CACHE_KEY)
          setOpening(answer)
        } else if (announcesOpening(answer)) {
          writeScoped(CACHE_KEY, serializeOpening(answer, Date.now()))
          setOpening(answer)
        } else {
          logger.warn('PostingOpensBanner: the election status could not be read well enough to announce a date')
        }
        return answer.kind === 'open'
      },
      () => undefined,
      { targets: typeof window === 'undefined' ? [] : [window, document] }
    )
  }, [closedByInterim, sdkReady])

  return opening
}

/**
 * A slim "Posting opens on <date>" strip for Home, Explore and the landing
 * page while the social contract is closed (`notYetUsable` interim, no team
 * seated). The date is the chain's: the end of the contest for the seat. With
 * no charter filed there is no date, and it says what posting waits for.
 * Disappears on its own once a team is seated.
 *
 * It renders nothing until it knows (or remembers), and sits above the page's
 * sticky header, so it appears with the page's own loading state rather than
 * pushing a loaded feed. The compose, blog and store notices keep explaining
 * what stays closed.
 */
export function PostingOpensBanner({ className }: { className?: string }) {
  const opening = usePostingOpening()
  const text = opening ? postingOpensText(opening) : null
  if (!text) return null
  return (
    <div
      role="status"
      data-testid="posting-opens-banner"
      className={cn(
        'flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800',
        'dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200',
        className
      )}
    >
      <ClockIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}
