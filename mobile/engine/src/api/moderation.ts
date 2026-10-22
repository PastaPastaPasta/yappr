import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import { postingOpening, type PostingOpening } from '@/lib/posting-opens'
import { moderationElectionService } from '@/lib/services/moderation-election-service'
import { moderationServiceFor } from '@/lib/services/moderation-service'

/**
 * When posting opens (the web banner's answer, `lib/posting-opens.ts`):
 * `open` (a team is seated, or the contract is not closed by an interim),
 * `at` (a team can be seated at `atMs`), `soon`, `pending` (no charter has
 * entered the contest, so no date) or `unknown` (the status could not be read
 * well enough to say; show nothing). The host formats the date.
 */
export type PostingOpeningDTO = PostingOpening

/** The election status is several reads; callers share one answer for this long (as the web banner). */
const SHARE_MS = 60_000

let shared: { at: number; answer: Promise<PostingOpeningDTO> } | null = null

/**
 * One cheap read first (the moderation service's cached team read): an open
 * contract never pays for the election walk. Rejects when a read fails.
 */
async function readOpening(): Promise<PostingOpeningDTO> {
  if (await moderationServiceFor('social').moderatedTypeOpen('post')) return { kind: 'open' }
  return postingOpening(await moderationElectionService.getStatus(YAPPR_CONTRACT_ID), Date.now())
}

export const moderation = {
  /**
   * Whether posting is closed on the social contract and when it opens
   * (`capabilities.postingMayBeClosed` says whether to ask at all). A failed
   * read rejects and is not kept.
   */
  postingOpening(): Promise<PostingOpeningDTO> {
    if (!shared || Date.now() - shared.at >= SHARE_MS) {
      const entry = { at: Date.now(), answer: readOpening() }
      shared = entry
      entry.answer.catch(() => {
        if (shared === entry) shared = null
      })
    }
    return shared.answer
  },
}

/** Forgets the shared answer (tests). */
export function forgetPostingOpening(): void {
  shared = null
}
