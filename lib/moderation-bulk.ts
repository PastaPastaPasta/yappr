/**
 * Hiding (or unhiding) many of one account's posts and replies in one go, on
 * a "hide, don't delete" cut (social v18, docs/SOCIAL_V18.md). The main use is
 * a spam wave: a restriction already keeps the account's NEW writes out of
 * the listings (`live: 2`), so only what it posted before needs hiding.
 *
 * Pure: the reads are lib/services/bulk-hide-service.ts, the signing the
 * moderation service's batch (`ModerationService.openBatch`), and the dialog
 * components/moderation/bulk-hide-modal.tsx.
 *
 * One transition per document. A ContractUserModeration transition carries a
 * single action (`pub action: ContractUserModerationAction`, Platform
 * v5.0.0-rc.4 packages/rs-dpp/src/state_transition/state_transitions/contract/
 * contract_user_moderation_transition/v0/mod.rs:476), and
 * `ChangeDocumentFields` names one document (mod.rs:99). So the hides are
 * signed one after another, each under the moderator's next contract nonce
 * (lib/services/identity-nonce.ts serializes them), and what is done is
 * always read back from the chain rather than trusted to this tab.
 */
import type { ModerationMarks } from './moderation-view'

/** Hide the listed documents, or list the hidden ones again. */
export type BulkMode = 'hide' | 'unhide'

/** The document types the tool reaches. Social only for now; blog and storefront are a follow-up. */
export type BulkKind = 'post' | 'reply'

/**
 * The `mod` a document in `mode`'s lane carries: none before a hide (listed),
 * 1 before an unhide (hidden; a legal hold, 2, is not this tool's to lift).
 */
export const laneMod = (mode: BulkMode): number | null => (mode === 'hide' ? null : 1)

/** True when a stored document is in `mode`'s lane: listed (`live` 1, not posted while restricted) with that `mod`. */
export function inLane(doc: Readonly<Record<string, unknown>>, mode: BulkMode): boolean {
  const mod = typeof doc.mod === 'number' ? doc.mod : null
  return doc.live === 1 && mod === laneMod(mode)
}

/** The tab a stored document is listed in: Showing, Hidden, or neither (a legal hold, a tombstone, unlisted). */
export function laneOf(doc: Readonly<Record<string, unknown>>): BulkMode | null {
  if (inLane(doc, 'hide')) return 'hide'
  return inLane(doc, 'unhide') ? 'unhide' : null
}

/** One of the account's documents, as the dialog lists it. */
export interface BulkItem {
  id: string
  kind: BulkKind
  createdAt: number
  /** The first of its text, for the moderator to recognise it by. */
  preview: string
  /** The block time the listing page it came from was proved at. */
  provedAt?: number
}

/**
 * A document a run changed or read, the tab it is listed in now (null:
 * neither), and the chain's block time that state is known at: its own
 * transition's, or the proved read's. Without one it never outranks a read.
 */
export interface RunChange {
  item: BulkItem
  tab: BulkMode | null
  at?: number
}

/**
 * The tab a run's change puts its document in: one settled by a chain read
 * where the read lists it, this run's own transition per `mode`, else per the
 * marks it holds. Null when it is in neither (a legal hold, or gone).
 */
export function tabAfter(mode: BulkMode, change: BulkChange): BulkMode | null {
  if (change.tab !== undefined) return change.tab
  if (change.marks === undefined) return mode === 'hide' ? 'unhide' : 'hide'
  const mod = change.marks?.mod
  if (mod === undefined) return 'hide'
  return mod === laneMod('unhide') ? 'unhide' : null
}

/** When a read was proved: one block time for all of it, or one per type, as posts and replies are separate listings. */
export type ReadAt = number | undefined | Readonly<Record<BulkKind, number>>

/**
 * The run changes a read proved at block time `readAt` (NaN or undefined:
 * unknown) predates. Each came back proved, but the read can reach a node a
 * block behind them; a read at or after one already shows it, and whatever
 * changed since (an author's tombstone).
 */
function newerThan(changes: ReadonlyMap<string, RunChange>, readAt: ReadAt): RunChange[] {
  return [...changes.values()].filter((change) => {
    if (change.at === undefined) return false
    const at = typeof readAt === 'object' ? readAt[change.item.kind] : readAt
    return at === undefined || !Number.isFinite(at) || change.at > at
  })
}

/** `tab`'s list as a read proved it at block time `readAt`, with the run changes it predates where they now belong. */
export function withRunChanges(items: readonly BulkItem[], tab: BulkMode, changes: ReadonlyMap<string, RunChange>, readAt: ReadAt): BulkItem[] {
  const recent = newerThan(changes, readAt)
  if (recent.length === 0) return [...items]
  const moved = new Map(recent.map((change) => [change.item.id, change]))
  const kept = items.filter((item) => !moved.has(item.id) || moved.get(item.id)?.tab === tab)
  const listed = new Set(kept.map((item) => item.id))
  const added = recent.filter((change) => change.tab === tab && !listed.has(change.item.id)).map((change) => change.item)
  return added.length === 0 ? kept : [...kept, ...added].sort((a, b) => b.createdAt - a.createdAt)
}

/** Whether a read proved at block time `readAt` predates a run change: the lists are read again a little later. */
export function readPredatesRun(changes: ReadonlyMap<string, RunChange>, readAt: ReadAt): boolean {
  return newerThan(changes, readAt).length > 0
}

/** How far back "select by time" reaches. */
export type BulkRange = 'day' | 'week' | 'all'

const RANGE_MS: Record<Exclude<BulkRange, 'all'>, number> = { day: 86_400_000, week: 7 * 86_400_000 }

/** The ids of `items` written within `range` of `now`. */
export function idsWithin(items: readonly BulkItem[], range: BulkRange, now = Date.now()): Set<string> {
  if (range === 'all') return new Set(items.map((item) => item.id))
  const since = now - RANGE_MS[range]
  return new Set(items.filter((item) => item.createdAt >= since).map((item) => item.id))
}

/** Posts and replies in one list, newest first (each input is already newest first). Ties keep posts first. */
export function newestFirst(posts: readonly BulkItem[], replies: readonly BulkItem[]): BulkItem[] {
  const merged: BulkItem[] = []
  let p = 0
  let r = 0
  while (p < posts.length || r < replies.length) {
    if (r >= replies.length || (p < posts.length && posts[p].createdAt >= replies[r].createdAt)) merged.push(posts[p++])
    else merged.push(replies[r++])
  }
  return merged
}

/** One page of a listing: its items, the cursor for the next (absent on the last page), and the block time it was proved at. */
export interface BulkPage {
  items: BulkItem[]
  next?: string
  at?: number
}

/** The block time of a read made of several proved answers: the oldest of them (NaN when one carries none). */
export function oldestBlockTime(times: readonly (number | undefined)[]): number {
  return times.reduce<number>((oldest, time) => (time === undefined || !Number.isFinite(time) ? NaN : Math.min(oldest, time)), Infinity)
}

/** Most documents of one type the dialog reads for an account. */
export const MAX_ITEMS_PER_KIND = 5000

/**
 * Every page of a listing, from the first, following `next` until a page has
 * none or `max` items are in. `onPage` sees the total so far after each page.
 * Returns the items, whether `max` cut the listing short, and the block time
 * of its oldest page.
 */
export async function readEveryPage(
  readPage: (startAfter?: string) => Promise<BulkPage>,
  { max = MAX_ITEMS_PER_KIND, onPage }: { max?: number; onPage?: (items: readonly BulkItem[]) => void } = {}
): Promise<{ items: BulkItem[]; truncated: boolean; at: number }> {
  const items: BulkItem[] = []
  const seen = new Set<string>()
  const times: (number | undefined)[] = []
  let cursor: string | undefined
  let stalled = false
  do {
    const page = await readPage(cursor)
    times.push(page.at)
    for (const item of page.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(page.at !== undefined && Number.isFinite(page.at) ? { ...item, provedAt: page.at } : item)
    }
    onPage?.(items)
    // A cursor that does not move would read the same page forever; the
    // listing may go on past it, so it is reported as incomplete.
    stalled = page.next !== undefined && page.next === cursor
    cursor = page.next && !stalled ? page.next : undefined
  } while (cursor && items.length < max)
  return { items: items.slice(0, max), truncated: stalled || cursor !== undefined || items.length > max, at: oldestBlockTime(times) }
}

/**
 * What one hide costs, in credits (about 6¢): measured on the /beta
 * rehearsal contracts (testnet, social v18) on 2026-10-22, as the
 * moderator's balance before and after bulk-hiding three seeded posts and a
 * reply (397,423,040 credits for four). A longer document costs a little
 * more.
 */
export const HIDE_FEE_CREDITS = 99_400_000

/** What one unhide costs (about 3.8¢): the same four unhidden, 256,163,500 credits. */
export const UNHIDE_FEE_CREDITS = 64_000_000

/** Credits per DASH, and the DASH price the ¢ figures assume. */
const CREDITS_PER_DASH = 100_000_000_000
const USD_PER_DASH = 60

/** `credits` in US cents at {@link USD_PER_DASH}. */
export function creditsToCents(credits: number): number {
  return (credits / CREDITS_PER_DASH) * USD_PER_DASH * 100
}

/** "1.2B", "940M", "52K" credits. */
export function formatCredits(credits: number): string {
  const units: Array<[number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [size, suffix] of units) {
    if (credits >= size) return `${Number((credits / size).toFixed(credits >= size * 10 ? 0 : 1))}${suffix}`
  }
  return String(Math.round(credits))
}

/** "5.6¢", "$1.25" (from a dollar up), "0.06¢". */
export function formatCents(cents: number): string {
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`
  if (cents >= 10) return `${Math.round(cents)}¢`
  return `${Number(cents.toPrecision(2))}¢`
}

/** What changing `count` documents costs, as the dialog says it. */
export function bulkCostLine(count: number, perDocument = HIDE_FEE_CREDITS): string {
  const total = count * perDocument
  const each = `${formatCredits(perDocument)} credits (${formatCents(creditsToCents(perDocument))}) each`
  if (count === 0) return `About ${each}.`
  if (count === 1) return `About ${formatCredits(total)} credits (${formatCents(creditsToCents(total))}).`
  return `About ${formatCredits(total)} credits (${formatCents(creditsToCents(total))}), ${each}.`
}

/** A change's answer, as the moderation service gives it. */
export interface BulkApplyResult {
  success: boolean
  error?: string
  errorCode?: string
  /** The change's own block time, from the proved answer. */
  moderatedAt?: number
  /** The changed document as the proved answer gave it. */
  document?: Readonly<Record<string, unknown>>
}

/** One document that did not change, and why, in words. */
export interface BulkFailure {
  item: BulkItem
  error: string
  /** False when it changed some other way (a legal hold): nothing to try again, and it stays listed here whatever the lists show. */
  retryable: boolean
}

/**
 * What a confirmed document now holds, for the cards on screen: `marks` from a
 * chain read (null: listed), or undefined for "as this run asked"; `at` the
 * block time it was changed at, when known.
 */
export interface BulkChange {
  marks?: ModerationMarks | null
  /** For one settled by a chain read or this run's proved write: the tab the proved document is listed in (null: neither). */
  tab?: BulkMode | null
  at?: number
  /** For one settled by a chain read: the block time the read was proved at. */
  seenAt?: number
}

/** Where a chain read found a document that changed some other way: the tab it is listed in (null: neither), as of `seenAt`. */
export interface BulkSeen {
  tab: BulkMode | null
  seenAt?: number
}

export interface BulkProgress {
  /** How many the run is about. */
  total: number
  /** How many are confirmed changed (a proved answer, or a proved re-read). */
  done: number
  /** The one being signed now, null between transitions and at the end. */
  current: BulkItem | null
  failures: BulkFailure[]
}

/** Where a document stands against a run, read from the chain ({@link chainState}). */
export type BulkChainState = 'todo' | 'done' | 'changed'

/**
 * Where `doc` (undefined: not in state) stands against `mode`:
 * - `todo`: still in the lane the run started from;
 * - `done`: in the state the run asks for. For a hide that is anything out of
 *   the listings (hidden, under legal hold, tombstoned or gone); for an unhide,
 *   listed again (`mod` absent);
 * - `changed`: neither, for an unhide (another moderator put it under legal
 *   hold, or it is gone): it is not counted as done.
 */
export function chainState(doc: Readonly<Record<string, unknown>> | undefined, mode: BulkMode): BulkChainState {
  if (doc && inLane(doc, mode)) return 'todo'
  if (mode === 'hide') return 'done'
  return doc && typeof doc.mod !== 'number' ? 'done' : 'changed'
}

/** A chain read for a run: the ids still to do, and those that changed some other way. */
export interface BulkChainRead {
  todo: Set<string>
  changed: Set<string>
  /** What each document read holds now (null: no marks), for the cards on screen. */
  marks?: Map<string, ModerationMarks | null>
  /** The tab each document no longer to do is listed in now ({@link laneOf}; null: neither, or gone). */
  lanes?: Map<string, BulkMode | null>
  /** The block time the read was proved at (the oldest of its answers). */
  at?: number
  /** The block time of the answer that covered each document, where it differs from `at`. */
  ats?: Map<string, number>
}

/** The block time the answer covering `id` in `read` was proved at. */
export function provedAt(read: BulkChainRead, id: string): number | undefined {
  return read.ats?.get(id) ?? read.at
}

/**
 * A run's guard on its by-ID reads ({@link BulkRunDeps.pending}, `recheck`):
 * a read answering an asked document from before `listedAt()` (the newest list
 * read the dialog showed, as of the read), the listing page it came from, what a run proved of it, or an earlier read this
 * run accepted for it cannot settle it, and rejects, so nothing is counted,
 * announced or sent on it.
 */
export function freshReads(changes: ReadonlyMap<string, RunChange>, listedAt: () => number) {
  const accepted = new Map<string, number>()
  const known = (time: number | undefined) => (time !== undefined && Number.isFinite(time) ? time : -Infinity)
  const floor = (item: BulkItem) => Math.max(known(listedAt()), known(item.provedAt), known(changes.get(item.id)?.at), known(accepted.get(item.id)))
  return (asked: readonly BulkItem[]) => (read: BulkChainRead): BulkChainRead => {
    const behind = asked.some((item) => {
      const min = floor(item)
      const at = provedAt(read, item.id)
      return min !== -Infinity && !(at !== undefined && at >= min)
    })
    if (behind) throw new Error('read behind what the dialog already showed')
    for (const item of asked) {
      const at = provedAt(read, item.id)
      if (at !== undefined && Number.isFinite(at)) accepted.set(item.id, Math.max(at, accepted.get(item.id) ?? -Infinity))
    }
    return read
  }
}

/** Where `item` stands in a chain read ({@link BulkRunDeps.pending}): an id in neither set is done. */
export function stateIn(read: BulkChainRead, item: BulkItem): BulkChainState {
  if (read.todo.has(item.id)) return 'todo'
  return read.changed.has(item.id) ? 'changed' : 'done'
}

export interface BulkRunDeps {
  /**
   * Signs and sends the change for one document; resolves with the service's
   * answer. `guard` must run under the write lock, just before signing (after
   * any nonce wait): false sends nothing and answers `PRECONDITION_FAILED`.
   */
  apply: (item: BulkItem, guard: () => Promise<boolean>) => Promise<BulkApplyResult>
  /** Reads the chain: where each of `items` stands ({@link chainState}); an id in neither set is done. */
  pending: (items: readonly BulkItem[]) => Promise<BulkChainRead>
  /**
   * Reads one document again just before its transition is signed, so a
   * change since the first read (another moderator's legal hold, above all)
   * is never overwritten: the same read as `pending`, for that one. Rejects
   * when the read fails.
   */
  recheck?: (item: BulkItem) => Promise<BulkChainRead>
  /**
   * Each document confirmed in the state asked for: by this run's own proved
   * transition (`change.marks` undefined, `at` its block time), or by a chain
   * read (`change.marks` what the read holds, which may be another moderator's).
   */
  onDone?: (item: BulkItem, change: BulkChange) => void
  /** Each document a chain read found changed some other way, with where that read lists it: not done, but no longer where it was. */
  onSeen?: (item: BulkItem, seen: BulkSeen) => void
  onProgress?: (progress: BulkProgress) => void
  /** Checked before each transition: true stops the run after the one under way. */
  cancelled?: () => boolean
  /** Waits between transitions. */
  pause?: (ms: number) => Promise<void>
}

export interface BulkSummary extends BulkProgress {
  /** Why the run stopped before the end, if it did: the moderator stopped it, or nothing more could go through. */
  stopped: 'cancelled' | 'fatal' | null
  /** What stopped it, when `stopped` is `fatal`. */
  error?: string
}

/** Between two transitions, and after one the network did not confirm. */
export const PACE_MS = 400
export const UNCONFIRMED_BACKOFF_MS = 3000

/**
 * How often one document waits for an earlier change still going through
 * (`WRITE_PENDING`: the nonce lock holds a write whose outcome is unknown for
 * up to a minute) before it is listed as failed.
 */
export const MAX_PENDING_WAITS = 20

/** The same refusal this many times in a row stops the run: every other document would get it too. */
export const SAME_REFUSAL_LIMIT = 3

/**
 * True for the answer of a moderator who closed the sheet asking for the
 * CRITICAL key (`CANCELLED`, the step-up signing of lib/auth/critical-key.ts):
 * nothing was signed, and there is nothing to say.
 */
export function closedKeySheet(errorCode: string | undefined): boolean {
  return errorCode === 'CANCELLED'
}

/** Answers that will be the same for every other document too: the run stops at the first. */
const FATAL = new Set([
  'NEEDS_CRITICAL_KEY',
  'INVALID_KEY',
  'NOT_MODERATOR',
  'NOT_MODERATED',
  'NOT_YET_SEATED',
  'TEAM_NOT_SEATED',
  'ABILITY_NOT_GRANTED',
  'REASON_NOT_LISTED',
  'INVALID_REASON_DOCUMENTS',
  'INVALID_LABEL',
  'REASON_TOO_LONG',
  // The author is a moderator (or the protected owner): every one of their documents is refused, paid (41102).
  'TARGET_PROTECTED',
  'FIELD_NOT_CHANGEABLE',
  'MODERATOR_FIELD',
  // The moderator's account cannot pay for the next one either.
  'INSUFFICIENT_CREDITS',
])

/** Answers that may hide a change that landed: settled by reading the chain again. */
const UNCONFIRMED = new Set(['MAYBE_APPLIED', 'NETWORK_ERROR'])

/** The gateway's timeout on a write that usually landed: common, so it never trips {@link SAME_REFUSAL_LIMIT}. */
const TIMEOUT = 'MAYBE_APPLIED'

/** An earlier change is still going through, so this one was not sent: wait, and send it again. */
const WRITE_PENDING = 'WRITE_PENDING'

/** The document already reads the way it was asked to (another moderator, or an earlier run). */
const ALREADY = 'NOTHING_TO_CHANGE'

/** What the check just before a transition found, as the loop reads it: nothing was sent. */
const FOUND_DONE = 'FOUND_DONE'
const FOUND_CHANGED = 'FOUND_CHANGED'
const RECHECK_FAILED = 'RECHECK_FAILED'
/** The guard said no under the write lock: nothing went out (the service's code). */
const PRECONDITION_FAILED = 'PRECONDITION_FAILED'

const UNCONFIRMED_ERROR = 'The network did not confirm this one. Try again.'
const RECHECK_ERROR = 'Couldn’t check this one just before changing it, so it was left as it is. Try again.'
const READ_ERROR = 'Couldn’t check where their posts stand right now, so nothing was changed. Try again.'
const CHANGED_ERROR = 'This changed in the meantime (another moderator may have acted on it), so it was left as it is.'
const FAILED_ERROR = 'That did not go through.'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Changes `items` one transition at a time, newest first as given.
 *
 * 1. Reads the chain first: what is already changed (an earlier run, closed
 *    halfway, or another moderator) counts as done and is not sent again.
 *    Without that read nothing is sent.
 * 2. Sends each of the rest in turn, {@link PACE_MS} apart, each read again
 *    just before (`recheck`), so what changed since is left as it is. A proved answer
 *    counts it done. An unconfirmed one (a gateway timeout) is set aside and
 *    the run waits a moment before the next. One held back because an earlier
 *    change is still going through is sent again after a wait.
 * 3. Reads the set-aside ones again: landed ones count as done, the rest fail.
 *
 * Stops before the next transition once `cancelled()` turns true (checked
 * after every wait, so a stop never sends one more), and at once on an answer
 * every other document would get too (no key, not a moderator, a reason the
 * charter does not list, a protected author), or on the same refusal
 * {@link SAME_REFUSAL_LIMIT} times in a row. A closed key sheet stops it
 * quietly. Never throws for one document: its failure is listed and the run
 * goes on.
 */
export async function runBulk(items: readonly BulkItem[], deps: BulkRunDeps): Promise<BulkSummary> {
  const pause = deps.pause ?? sleep
  const cancelled = () => deps.cancelled?.() ?? false
  const progress: BulkProgress = { total: items.length, done: 0, current: null, failures: [] }
  const report = () => deps.onProgress?.({ ...progress, failures: [...progress.failures] })

  /** Counts `item` done, and announces it with what confirmed it. */
  const markDone = (item: BulkItem, change: BulkChange) => {
    progress.done++
    deps.onDone?.(item, change)
  }
  const fail = (item: BulkItem, error: string, retryable = true) => {
    progress.failures.push({ item, error, retryable })
  }
  const seenAt = (read: BulkChainRead, item: BulkItem) => {
    const at = provedAt(read, item.id)
    return at !== undefined ? { seenAt: at } : {}
  }
  /** What a read that found `item` done holds for it; null when it did not find it (gone). */
  const readChange = (read: BulkChainRead, item: BulkItem): BulkChange | null => {
    const marks = read.marks?.get(item.id)
    if (marks === undefined) return null
    const tab = read.lanes?.get(item.id)
    return tab === undefined ? { marks, ...seenAt(read, item) } : { marks, tab, ...seenAt(read, item) }
  }
  /** Where a read that found `item` changed some other way lists it, if the read says. */
  const readSeen = (read: BulkChainRead, item: BulkItem): BulkSeen | null => {
    const tab = read.lanes?.get(item.id)
    return tab === undefined ? null : { tab, ...seenAt(read, item) }
  }
  /** Fails `item` as changed some other way, and says where the read lists it now. */
  const failChanged = (item: BulkItem, seen: BulkSeen | null) => {
    fail(item, CHANGED_ERROR, false)
    if (seen) deps.onSeen?.(item, seen)
  }
  /**
   * Counts what a chain read says is done or changed; returns what it says is
   * still to do. What it counts done is announced with the marks the read
   * holds, never as this run's change: a read cannot tell them apart (a legal
   * hold reads as done for a hide).
   */
  const settle = (read: BulkChainRead, asked: readonly BulkItem[], stillError: string | null): BulkItem[] => {
    const still: BulkItem[] = []
    for (const item of asked) {
      if (read.changed.has(item.id)) failChanged(item, readSeen(read, item))
      else if (!read.todo.has(item.id)) {
        // Announced with what the read holds; a document the read did not find (gone) is counted, not announced.
        const change = readChange(read, item)
        if (change) markDone(item, change)
        else progress.done++
      }
      else if (stillError) fail(item, stillError)
      else still.push(item)
    }
    return still
  }

  let todo: BulkItem[]
  try {
    todo = settle(await deps.pending(items), items, null)
  } catch {
    // Without the read nothing is known about where each one stands now (an
    // unhide must never clear a legal hold set since it was listed), so
    // nothing is sent: the moderator tries again.
    return { ...progress, failures: [], stopped: 'fatal', error: READ_ERROR }
  }
  report()

  const unconfirmed: BulkItem[] = []
  let stopped: BulkSummary['stopped'] = null
  let stopError: string | undefined
  /** The last refusal's code, and how many times in a row it came. */
  let streakCode: string | null = null
  let streakCount = 0
  let waitMs = 0

  /** What the check just before a transition read for each one it found done already, or changed some other way. */
  const foundDone = new Map<string, BulkChange | null>()
  const foundChanged = new Map<string, BulkSeen | null>()
  /**
   * Whether `item` may still be sent: the run not stopped, and the chain read
   * just now still showing it to do. Its answer, when it says no, as the loop
   * reads it (nothing was sent).
   */
  const mayStillSend = async (item: BulkItem): Promise<BulkApplyResult | null> => {
    if (cancelled()) return { success: false, errorCode: 'CANCELLED' }
    if (!deps.recheck) return null
    let read: BulkChainRead
    try {
      read = await deps.recheck(item)
    } catch {
      return { success: false, error: RECHECK_ERROR, errorCode: RECHECK_FAILED }
    }
    // The read took a moment: a stop pressed meanwhile still stops before signing.
    if (cancelled()) return { success: false, errorCode: 'CANCELLED' }
    const state = stateIn(read, item)
    if (state === 'done') {
      foundDone.set(item.id, readChange(read, item))
      return { success: false, errorCode: FOUND_DONE }
    }
    if (state === 'changed') {
      foundChanged.set(item.id, readSeen(read, item))
      return { success: false, error: CHANGED_ERROR, errorCode: FOUND_CHANGED }
    }
    return null
  }

  const send = async (item: BulkItem): Promise<BulkApplyResult> => {
    for (let waits = 0; ; waits++) {
      if (waitMs > 0) await pause(waitMs)
      progress.current = item
      report()
      const before = await mayStillSend(item)
      if (before) return before
      // Asked again under the write lock, after any nonce wait, just before signing.
      const last: { refusal: BulkApplyResult | null } = { refusal: null }
      const guard = async () => {
        last.refusal = await mayStillSend(item)
        return last.refusal === null
      }
      let result: BulkApplyResult
      try {
        result = await deps.apply(item, guard)
      } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : String(error), errorCode: 'NETWORK_ERROR' }
      }
      if (result.errorCode === PRECONDITION_FAILED) return last.refusal ?? { success: false, error: RECHECK_ERROR, errorCode: RECHECK_FAILED }
      waitMs = PACE_MS
      if (result.errorCode !== WRITE_PENDING) return result
      if (waits + 1 >= MAX_PENDING_WAITS) return { ...result, errorCode: 'NETWORK_ERROR' }
      progress.current = null
      report()
      waitMs = UNCONFIRMED_BACKOFF_MS
    }
  }

  for (const item of todo) {
    const result = await send(item)
    if (result.success) {
      // As this run asked; ordered by its own block time when the answer gave it.
      markDone(item, {
        ...(result.moderatedAt !== undefined ? { at: result.moderatedAt } : {}),
        ...(result.document ? { tab: laneOf(result.document) } : {}),
      })
      streakCode = null
      continue
    }
    if (result.errorCode === ALREADY) {
      // Already that way on chain, by no change of this run's: settled by the proved read at the end, like an unconfirmed one.
      unconfirmed.push(item)
      streakCode = null
      continue
    }
    if (result.errorCode === FOUND_DONE) {
      // Done before its turn, perhaps by another moderator and some other way: announced with what that read holds.
      const change = foundDone.get(item.id)
      if (change) markDone(item, change)
      else progress.done++
      continue
    }
    if (result.errorCode === FOUND_CHANGED) {
      failChanged(item, foundChanged.get(item.id) ?? null)
      continue
    }
    if (closedKeySheet(result.errorCode)) {
      stopped = 'cancelled'
      break
    }
    const code = result.errorCode ?? 'UNKNOWN'
    if (FATAL.has(code)) {
      stopped = 'fatal'
      stopError = result.error ?? FAILED_ERROR
      break
    }
    if (UNCONFIRMED.has(code)) {
      unconfirmed.push(item)
      progress.current = null
      report()
      waitMs = UNCONFIRMED_BACKOFF_MS
    } else {
      fail(item, result.error ?? FAILED_ERROR)
    }
    // A gateway timeout neither counts toward a streak nor breaks one.
    if (code === TIMEOUT) continue
    streakCount = code === streakCode ? streakCount + 1 : 1
    streakCode = code
    if (streakCount >= SAME_REFUSAL_LIMIT) {
      stopped = 'fatal'
      stopError = result.error ?? FAILED_ERROR
      break
    }
  }

  if (unconfirmed.length > 0) {
    let read: BulkChainRead
    try {
      read = await deps.pending(unconfirmed)
    } catch {
      read = { todo: new Set(unconfirmed.map((item) => item.id)), changed: new Set() }
    }
    settle(read, unconfirmed, UNCONFIRMED_ERROR)
  }
  progress.current = null
  report()
  return { ...progress, failures: [...progress.failures], stopped, ...(stopError ? { error: stopError } : {}) }
}
