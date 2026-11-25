/**
 * The viewer's own marks on a post or reply (liked, reposted, bookmarked, and
 * on v10 their quote or repost of it), with the viewer a read found them for.
 *
 * A page stays mounted when the viewer signs in, signs out or switches
 * account, so marks loaded for one viewer can still be on screen for the
 * next. Marks are trusted only when they name the current viewer, were read
 * in the current session (a sign-out and back into the same account starts a
 * new one: the account may have acted elsewhere meanwhile), and come from a
 * read that succeeded: a default, or a failed read, leaves them unknown, and
 * an unknown mark never decides what a toggle writes.
 */

import { sessionGeneration } from '@/lib/auth/session-generation'
import type { KindedTarget } from '@/lib/contract-topology'
import type { Post } from '@/lib/types'
import type { OwnQuote } from './quote-reposts'

export interface Marks {
  liked: boolean
  /** v10: true when the viewer has quoted or reposted it (one slot per target). */
  reposted: boolean
  bookmarked: boolean
  /** v10: the viewer's quote or bare repost of it, when `reposted`. */
  ownQuote?: OwnQuote
}

export interface ViewerMarks extends Marks {
  /** The viewer the read was for. */
  viewerId: string
  /** The session generation (lib/auth/session-generation.ts) the read started in. */
  session: number
}

/** Marks a read found, keyed by target id. A target missing from the map was not read. */
export type MarksReader = (targets: readonly KindedTarget[], viewerId: string) => Promise<Map<string, Marks>>

/** The marks a post object carries, when a read for a viewer set them (`marksFor`). */
export function postMarks(post: Pick<Post, 'marksFor' | 'marksSession' | 'liked' | 'reposted' | 'bookmarked' | 'ownQuote'>): ViewerMarks | undefined {
  if (!post.marksFor || post.marksSession === undefined) return undefined
  return {
    viewerId: post.marksFor,
    session: post.marksSession,
    liked: post.liked === true,
    reposted: post.reposted === true,
    bookmarked: post.bookmarked === true,
    ...(post.ownQuote ? { ownQuote: post.ownQuote } : {}),
  }
}

/** `marks` when they were read for `viewerId` in this session, else undefined. Signed out, nobody has marks to trust. */
export function marksFor<T extends ViewerMarks>(marks: T | null | undefined, viewerId: string | undefined): T | undefined {
  return viewerId && marks?.viewerId === viewerId && marks.session === sessionGeneration() ? marks : undefined
}

/**
 * Reads marks for many cards at once. Requests made in the same task are
 * read together, one batch per viewer, and a request for a target already
 * being read for that viewer joins that read. Nothing is kept after a read
 * settles. A target the read did not answer rejects, so it stays unknown.
 */
export function createMarksLoader(reader: MarksReader, schedule: (flush: () => void) => void = (flush) => setTimeout(flush, 0)) {
  type Pending = { target: KindedTarget; session: number; resolve: (marks: ViewerMarks) => void; reject: (error: unknown) => void }
  const inFlight = new Map<string, Promise<ViewerMarks>>()
  let queued = new Map<string, Map<string, Pending>>()
  let scheduled = false

  const keyOf = (viewerId: string, session: number, target: KindedTarget) => `${viewerId}|${session}|${target.kind}|${target.id}`

  const readBatch = async (viewerId: string, batch: Map<string, Pending>) => {
    try {
      const found = await reader(Array.from(batch.values(), (pending) => pending.target), viewerId)
      batch.forEach(({ target, session, resolve, reject }) => {
        const marks = found.get(target.id)
        if (marks) resolve({ ...marks, viewerId, session })
        else reject(new Error(`No marks were read for ${target.kind} ${target.id}`))
      })
    } catch (error) {
      batch.forEach(({ reject }) => reject(error))
    } finally {
      batch.forEach((_, key) => inFlight.delete(key))
    }
  }

  const flush = () => {
    scheduled = false
    const batches = queued
    queued = new Map()
    batches.forEach((batch, viewerId) => {
      readBatch(viewerId, batch).catch(() => undefined)
    })
  }

  return function load(viewerId: string, target: KindedTarget): Promise<ViewerMarks> {
    const session = sessionGeneration()
    const key = keyOf(viewerId, session, target)
    const existing = inFlight.get(key)
    if (existing) return existing
    const read = new Promise<ViewerMarks>((resolve, reject) => {
      const batch = queued.get(viewerId) ?? new Map<string, Pending>()
      batch.set(key, { target, session, resolve, reject })
      queued.set(viewerId, batch)
    })
    inFlight.set(key, read)
    if (!scheduled) {
      scheduled = true
      schedule(flush)
    }
    return read
  }
}

const readMarks: MarksReader = async (targets, viewerId) => {
  const { fetchBatchUserInteractions } = await import('@/lib/services/post-stats-helpers')
  return fetchBatchUserInteractions(targets, viewerId)
}

/** The viewer's marks on `target`, read now (batched with the other cards on screen). */
export const loadViewerMarks = createMarksLoader(readMarks)
