import bs58 from 'bs58'

/**
 * The lanes of a "hide, don't delete" listing (social v18, blog v10,
 * storefront v11; docs/SOCIAL_V18.md "Reading the lanes"), as pure data.
 *
 * Every listing read the client builds pins the listed lane: `mod == null`,
 * after `live == 1` where the index has `live`. An archival build (`NEXT_PUBLIC_MODERATION_VIEW=all`) reads
 * the same request once per lane, with the same order and its own cursor,
 * and merges the pages (lib/services/sdk-lane-fanout.ts). This module finds
 * the lanes in a request and merges what they return. No SDK, no network.
 */

export type WhereClause = [string, string, unknown]
export type OrderClause = [string, string]

/** The values a default-lane pin fans out to, the default first. */
const LANES: Record<string, { pinned: unknown; values: readonly unknown[] }> = {
  mod: { pinned: null, values: [null, 1, 2] },
  live: { pinned: 1, values: [1, 2] },
}

function isPin(clause: unknown, field: string): boolean {
  if (!Array.isArray(clause) || clause[0] !== field || clause[1] !== '==') return false
  return clause[2] === LANES[field].pinned
}

/**
 * Every lane of `where`, the request itself first. A request is laned when
 * it pins `mod == null` (then a `live == 1` beside it is a lane too);
 * anything else (DPNS, follows, `live == true` on v17, a
 * moderation log read on `mod == 1`) has one lane: itself.
 */
export function laneVariants<C extends WhereClause>(where: readonly C[] | undefined): C[][] {
  const clauses = where ?? []
  // Only the listed lane fans out. A read that names another `live` lane
  // (`live == 2, mod == null`: one restricted lane, as the profile's
  // Moderation tab reads it) asks for exactly that lane.
  const laned = clauses.some((clause) => isPin(clause, 'mod'))
    && clauses.every((clause) => clause[0] !== 'live' || isPin(clause, 'live'))
  const slots: Array<{ at: number; values: readonly unknown[] }> = []
  clauses.forEach((clause, at) => {
    if (laned && (isPin(clause, 'mod') || isPin(clause, 'live'))) {
      slots.push({ at, values: LANES[clause[0]].values })
    }
  })
  let variants: C[][] = [clauses.map((clause) => [...clause] as C)]
  for (const { at, values } of slots) {
    variants = variants.flatMap((variant) => values.map((value) => {
      const next = variant.map((clause) => [...clause] as C)
      next[at] = [next[at][0], next[at][1], value] as C
      return next
    }))
  }
  return variants
}

/** True when `where` has more than one lane. */
export function isLaned(where: readonly WhereClause[] | undefined): boolean {
  return laneVariants(where).length > 1
}

/** A sortable key for one order value: numbers, bigints, strings, identifiers (as their bytes' hex), and null first. */
function sortKey(value: unknown): { rank: number; num?: number; str?: string } {
  if (value === null || value === undefined) return { rank: 0 }
  if (typeof value === 'number') return { rank: 1, num: value }
  if (typeof value === 'bigint') return { rank: 1, num: Number(value) }
  if (value instanceof Uint8Array) return { rank: 2, str: bytesHex(value) }
  if (typeof value === 'string') {
    if (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) {
      try {
        const bytes = bs58.decode(value)
        if (bytes.length === 32) return { rank: 2, str: bytesHex(bytes) }
      } catch {
        // Not an identifier: compared as text below.
      }
    }
    return { rank: 3, str: value }
  }
  return { rank: 3, str: String(value) }
}

function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function compareValues(a: unknown, b: unknown): number {
  const ka = sortKey(a)
  const kb = sortKey(b)
  if (ka.rank !== kb.rank) return ka.rank - kb.rank
  if (ka.num !== undefined && kb.num !== undefined) return ka.num - kb.num
  return (ka.str ?? '') < (kb.str ?? '') ? -1 : (ka.str ?? '') > (kb.str ?? '') ? 1 : 0
}

/**
 * A comparator for documents in a request's order. Only the ordered
 * properties that are not pinned by equality distinguish documents across
 * lanes; ties fall back to `$id` (Drive's own tie-break), in the direction of
 * the last ordered property.
 */
export function documentComparator<T>(
  orderBy: readonly OrderClause[] | undefined,
  read: (doc: T, field: string) => unknown,
): (a: T, b: T) => number {
  const order = (orderBy ?? []).filter(([field]) => field !== 'mod' && field !== 'live')
  const lastDesc = order.length > 0 && order[order.length - 1][1] === 'desc'
  return (a, b) => {
    for (const [field, direction] of order) {
      const cmp = compareValues(read(a, field), read(b, field))
      if (cmp !== 0) return direction === 'desc' ? -cmp : cmp
    }
    const cmp = compareValues(read(a, '$id'), read(b, '$id'))
    return lastDesc ? -cmp : cmp
  }
}

/** One lane's page: its documents in order, and whether the lane may hold more. */
export interface LanePage<T> {
  docs: T[]
  /** True when the lane returned a full page, so it may hold more past its last document. */
  full: boolean
}

/** Where each lane stands after a merged page: the id to start after, or `done` when the lane is exhausted. */
export type LaneCursor = string | null | 'done'

/**
 * k-way merge of lane pages: the first `limit` documents of their union in
 * order, and each lane's cursor after it (the last of its documents taken,
 * its previous cursor when none was taken, `done` when it is exhausted and
 * every document it returned was taken).
 */
export function mergeLanePages<T>(
  pages: readonly LanePage<T>[],
  previous: readonly LaneCursor[],
  limit: number,
  compare: (a: T, b: T) => number,
  idOf: (doc: T) => string,
): { docs: T[]; cursors: LaneCursor[]; more: boolean } {
  const heads = pages.map(() => 0)
  const docs: T[] = []
  const seen = new Set<string>()
  while (docs.length < limit) {
    let best = -1
    for (let lane = 0; lane < pages.length; lane++) {
      if (heads[lane] >= pages[lane].docs.length) continue
      if (best < 0 || compare(pages[lane].docs[heads[lane]], pages[best].docs[heads[best]]) < 0) best = lane
    }
    if (best < 0) break
    const doc = pages[best].docs[heads[best]++]
    const id = idOf(doc)
    if (seen.has(id)) continue
    seen.add(id)
    docs.push(doc)
  }
  const cursors = pages.map((page, lane): LaneCursor => {
    if (previous[lane] === 'done') return 'done'
    const consumedAll = heads[lane] >= page.docs.length
    if (consumedAll && !page.full) return 'done'
    return heads[lane] > 0 ? idOf(page.docs[heads[lane] - 1]) : previous[lane] ?? null
  })
  const more = cursors.some((cursor, lane) => cursor !== 'done' && (pages[lane].full || heads[lane] < pages[lane].docs.length))
  return { docs, cursors, more }
}

/** Adds the per-key values of several lanes' maps (counts, sums). */
export function sumLaneMaps<K>(maps: readonly Map<K, bigint>[]): Map<K, bigint> {
  const total = new Map<K, bigint>()
  for (const map of maps) {
    for (const [key, value] of map) total.set(key, (total.get(key) ?? 0n) + BigInt(value))
  }
  return total
}

/** Adds the per-key `{count, sum}` pairs of several lanes' average maps. */
export function sumLaneAverages<K>(maps: readonly Map<K, { count: bigint; sum: bigint }>[]): Map<K, { count: bigint; sum: bigint }> {
  const total = new Map<K, { count: bigint; sum: bigint }>()
  for (const map of maps) {
    for (const [key, value] of map) {
      const prior = total.get(key) ?? { count: 0n, sum: 0n }
      total.set(key, { count: prior.count + BigInt(value.count), sum: prior.sum + BigInt(value.sum) })
    }
  }
  return total
}
