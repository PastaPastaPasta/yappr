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

/** Documents per moderation transition: one (see the module comment). */
export const DOCUMENTS_PER_TRANSITION = 1

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

/** One of the account's documents, as the dialog lists it. */
export interface BulkItem {
  id: string
  kind: BulkKind
  createdAt: number
  /** The first of its text, for the moderator to recognise it by. */
  preview: string
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

/** One page of a listing: its items and the cursor for the next, absent on the last page. */
export interface BulkPage {
  items: BulkItem[]
  next?: string
}

/** Most documents of one type the dialog reads for an account. */
export const MAX_ITEMS_PER_KIND = 5000

/**
 * Every page of a listing, from the first, following `next` until a page has
 * none or `max` items are in. `onPage` sees the total so far after each page.
 * Returns the items and whether `max` cut the listing short.
 */
export async function readEveryPage(
  readPage: (startAfter?: string) => Promise<BulkPage>,
  { max = MAX_ITEMS_PER_KIND, onPage }: { max?: number; onPage?: (items: readonly BulkItem[]) => void } = {}
): Promise<{ items: BulkItem[]; truncated: boolean }> {
  const items: BulkItem[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await readPage(cursor)
    for (const item of page.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
    onPage?.(items)
    // A cursor that does not move would read the same page forever.
    cursor = page.next && page.next !== cursor ? page.next : undefined
  } while (cursor && items.length < max)
  return { items: items.slice(0, max), truncated: cursor !== undefined || items.length > max }
}

/**
 * What one hide costs, in credits (about 6¢): measured on the /beta
 * rehearsal contracts (testnet, social v18) on 2026-10-22, as the
 * moderator's balance before and after bulk-hiding three seeded posts and a
 * reply (397,423,040 credits for four). A longer document costs a little
 * more; an unhide about the same.
 */
export const HIDE_FEE_CREDITS = 99_400_000

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
  return `About ${formatCredits(total)} credits (${formatCents(creditsToCents(total))}), ${each}.`
}

/** A change's answer, as the moderation service gives it. */
export interface BulkApplyResult {
  success: boolean
  error?: string
  errorCode?: string
}

/** One document that did not change, and why, in words. */
export interface BulkFailure {
  item: BulkItem
  error: string
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

export interface BulkRunDeps {
  /** Signs and sends the change for one document; resolves with the service's answer. */
  apply: (item: BulkItem) => Promise<BulkApplyResult>
  /** Reads the chain: the ids of `items` still to change (for a hide, those whose `mod` is still absent). */
  pending: (items: readonly BulkItem[]) => Promise<Set<string>>
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
  'ABILITY_NOT_GRANTED',
  'REASON_NOT_LISTED',
  'INVALID_LABEL',
  'REASON_TOO_LONG',
])

/** Answers that may hide a change that landed: settled by reading the chain again. */
const UNCONFIRMED = new Set(['MAYBE_APPLIED', 'NETWORK_ERROR'])

/** The document already reads the way it was asked to (another moderator, or an earlier run). */
const ALREADY = 'NOTHING_TO_CHANGE'

const UNCONFIRMED_ERROR = 'The network did not confirm this one. Try again.'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Changes `items` one transition at a time, newest first as given.
 *
 * 1. Reads the chain first: what is already changed (an earlier run, closed
 *    halfway, or another moderator) counts as done and is not sent again.
 * 2. Sends each of the rest in turn, {@link PACE_MS} apart. A proved answer
 *    counts it done. An unconfirmed one (a gateway timeout) is set aside and
 *    the run waits a moment before the next.
 * 3. Reads the set-aside ones again: landed ones count as done, the rest fail.
 *
 * Stops after the transition under way when `cancelled()` turns true, and at
 * once on an answer every other document would get too (no key, not a
 * moderator, a reason the charter does not list). Never throws for one
 * document: its failure is listed and the run goes on.
 */
export async function runBulk(items: readonly BulkItem[], deps: BulkRunDeps): Promise<BulkSummary> {
  const pause = deps.pause ?? sleep
  const progress: BulkProgress = { total: items.length, done: 0, current: null, failures: [] }
  const report = () => deps.onProgress?.({ ...progress, failures: [...progress.failures] })
  const finish = (stopped: BulkSummary['stopped'], error?: string): BulkSummary => {
    progress.current = null
    report()
    return { ...progress, failures: [...progress.failures], stopped, ...(error ? { error } : {}) }
  }

  let todo: BulkItem[]
  try {
    const pending = await deps.pending(items)
    todo = items.filter((item) => pending.has(item.id))
  } catch {
    // Without a read nothing is known done: send them all, and let the
    // contract's "already reads that way" answer the ones that are.
    todo = [...items]
  }
  progress.done = items.length - todo.length
  report()

  const unconfirmed: BulkItem[] = []
  let stopped: BulkSummary['stopped'] = null
  let stopError: string | undefined
  let sent = 0
  for (const item of todo) {
    if (deps.cancelled?.()) {
      stopped = 'cancelled'
      break
    }
    if (sent > 0) await pause(PACE_MS)
    sent++
    progress.current = item
    report()
    let result: BulkApplyResult
    try {
      result = await deps.apply(item)
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error), errorCode: 'NETWORK_ERROR' }
    }
    if (result.success || result.errorCode === ALREADY) {
      progress.done++
    } else if (closedKeySheet(result.errorCode)) {
      stopped = 'cancelled'
      break
    } else if (result.errorCode && FATAL.has(result.errorCode)) {
      stopped = 'fatal'
      stopError = result.error ?? 'That did not go through.'
      break
    } else if (result.errorCode && UNCONFIRMED.has(result.errorCode)) {
      unconfirmed.push(item)
      progress.current = null
      report()
      await pause(UNCONFIRMED_BACKOFF_MS)
    } else {
      progress.failures.push({ item, error: result.error ?? 'That did not go through.' })
    }
  }

  if (unconfirmed.length > 0) {
    let still: Set<string>
    try {
      still = await deps.pending(unconfirmed)
    } catch {
      still = new Set(unconfirmed.map((item) => item.id))
    }
    for (const item of unconfirmed) {
      if (still.has(item.id)) progress.failures.push({ item, error: UNCONFIRMED_ERROR })
      else progress.done++
    }
  }
  return finish(stopped, stopError)
}
