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

export type MarkName = 'liked' | 'reposted' | 'bookmarked'

/** Marks where only some were read: `unread` names the rest, which show as unmarked and never decide a write. */
export interface SomeMarks extends ViewerMarks {
  unread?: readonly MarkName[]
}

/** Whether `marks` hold a read value for `name`. */
export function knowsMark(marks: SomeMarks | null | undefined, name: MarkName): boolean {
  return Boolean(marks && !marks.unread?.includes(name))
}

/** Marks for `viewerId` in `session` with none of them read yet. */
export function noMarksRead(viewerId: string, session: number): SomeMarks {
  return { viewerId, session, liked: false, reposted: false, bookmarked: false, unread: ['liked', 'reposted', 'bookmarked'] }
}

/** `base` with `name` set from a read of just that mark (on v10 `reposted` carries its `ownQuote`). */
export function withMark<T extends SomeMarks>(base: T, name: MarkName, read: Partial<Marks>): T {
  const next: T = { ...base, [name]: read[name] === true }
  delete next.unread
  const stillUnread = base.unread?.filter((other) => other !== name) ?? []
  if (stillUnread.length > 0) next.unread = stillUnread
  if (name === 'reposted') {
    delete next.ownQuote
    if (read.ownQuote) next.ownQuote = read.ownQuote
  }
  return next
}

/** `held` with `name` filled from a late read, unless a newer read or write already set it. */
export function fillMark<T extends SomeMarks>(held: T, name: MarkName, read: Partial<Marks>): T {
  return knowsMark(held, name) ? held : withMark(held, name, read)
}

/** One action at a time per key: `hold` runs `action` unless another holds the key, and then resolves null. */
export function createSlotLock() {
  const held = new Set<string>()
  return {
    async hold<T>(key: string, action: () => Promise<T | null>): Promise<T | null> {
      if (held.has(key)) return null
      held.add(key)
      try {
        return await action()
      } finally {
        held.delete(key)
      }
    },
  }
}

/**
 * The quote or repost slot writes this tab made, per session, viewer and
 * post. Every card showing the post consults them before Quote: a card's own
 * marks miss a write another card made, and a read right after a write may
 * not show it yet.
 */
export function createSlotWrites(session: () => number = sessionGeneration) {
  const written = new Map<string, OwnQuote | null>()
  const keyOf = (viewerId: string, postId: string) => `${session()}|${viewerId}|${postId}`
  return {
    /** The viewer now holds `quote` in the slot, or (null) freed it. */
    record(viewerId: string, postId: string, quote: OwnQuote | null) {
      written.set(keyOf(viewerId, postId), quote)
    },
    /** `read` of the slot, with this tab's last write on it in its place. */
    apply(viewerId: string, postId: string, read: Partial<Marks>): Partial<Marks> {
      const quote = written.get(keyOf(viewerId, postId))
      if (quote === undefined) return read
      return quote ? { reposted: true, ownQuote: quote } : { reposted: false }
    },
  }
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
