/**
 * The follower move after a private-feed renewal, as a job this device keeps
 * until it finishes (PF4): which followers move from which feed to which, how
 * far it got, and whether the old feed's grants go at the end (PF6, PF6b).
 * It survives a reload or a crash; private-feed-move.ts runs it.
 *
 * Nothing in it is secret (identity ids and feed numbers), so it is kept
 * outside the `yappr:pf:` secure area.
 */

import { scopedKey } from '@/lib/storage-scope'
import { logger } from '@/lib/logger'

export interface MoveJob {
  ownerId: string
  from: number
  to: number
  /** Every follower to move, in the old feed's leaf order; follower i gets leaf i (deterministic across devices). */
  recipients: string[]
  /** Moved (granted in `to`). */
  done: string[]
  /** Left behind: no encryption key to seal to, or their request is gone. */
  skipped: string[]
  /** True after a move with a history link: the old feed's grants are deleted at the end (PF6). */
  deleteOldGrants: boolean
  /** The last error that paused the move, shown with a Continue button. */
  error?: string
}

const jobKey = (ownerId: string) => scopedKey(`yappr_pf_move:${ownerId}`)
const listeners = new Set<() => void>()

export function loadMove(ownerId: string): MoveJob | null {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(jobKey(ownerId))
    return raw ? (JSON.parse(raw) as MoveJob) : null
  } catch {
    return null
  }
}

export function saveMove(job: MoveJob): void {
  try {
    window.localStorage.setItem(jobKey(job.ownerId), JSON.stringify(job))
  } catch (error) {
    logger.error('PrivateFeed: could not save the follower move', error)
  }
  listeners.forEach((listener) => listener())
}

export function clearMove(ownerId: string): void {
  try {
    window.localStorage.removeItem(jobKey(ownerId))
  } catch {
    // nothing to clear
  }
  listeners.forEach((listener) => listener())
}

/** True while this device has an unfinished follower move for `ownerId`: private posting, approvals and revocations wait (PF4). */
export function moveInProgress(ownerId: string): boolean {
  return loadMove(ownerId) !== null
}

export function subscribeMove(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** How many of a job's followers are settled (moved or left behind). */
export function moveProgress(job: MoveJob): { done: number; total: number } {
  return { done: job.done.length + job.skipped.length, total: job.recipients.length }
}
