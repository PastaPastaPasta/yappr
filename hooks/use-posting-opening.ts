'use client'

import { useEffect, useState } from 'react'
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
export function usePostingOpening(): PostingOpening | null {
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
 * Whether posting is closed right now: the answer the "Posting opens on"
 * banner shows (a `notYetUsable` interim and no seated team), through the same
 * shared read. False while it is not known, so a page never claims a closure
 * the chain has not confirmed. Empty states use it to stop inviting posts.
 */
export function usePostingClosed(): boolean {
  const opening = usePostingOpening()
  return opening !== null && postingOpensText(opening) !== null
}
