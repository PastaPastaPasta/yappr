import type { EvoSDK } from '@dashevo/evo-sdk'
import bs58 from 'bs58'
import { logger } from '@/lib/logger'
import { moderationViewAll } from '@/lib/moderation-view'
import {
  documentComparator,
  laneVariants,
  mergeLanePages,
  sumLaneAverages,
  sumLaneMaps,
  type LaneCursor,
  type LanePage,
  type OrderClause,
} from '@/lib/moderation-lanes'
import { documentToPlainObject } from './sdk-helpers'
import { chunk, MAX_IN_CLAUSE_VALUES } from './pagination-utils'

/**
 * The archival build's lane fan-out (`NEXT_PUBLIC_MODERATION_VIEW=all`,
 * docs/ARCHIVE_FRONTEND.md), in one place for every page.
 *
 * The services build yap.pr's listed-lane reads only (`live == 1, mod ==
 * null`). On an archival build this shadows
 * `sdk.documents.{query, count, average, ranked, composite}` so every such
 * read is sent once per lane (lib/moderation-lanes.ts) and the answers are
 * merged as if one index held every lane:
 *
 * - documents: a k-way merge in the request's order, each lane with its own
 *   `startAfter`. The next page's `startAfter` is the merged page's last id;
 *   the lanes' own cursors are remembered against it, so paging on is exact;
 * - counts and averages: summed per key;
 * - rankings: summed per group (counts and sums) and re-ranked; an average
 *   ranking is re-read per lane as `{count, sum}` for the groups on any
 *   lane's page (in batches of at most one `in` clause) and re-averaged. Each lane contributes its own top `limit`,
 *   so a group just outside every lane's page can be missed; the ranking is
 *   the best of what the lanes returned;
 * - a composite page: the page is resolved through the merged documents read
 *   and fetched by id, and a laned `counts` sub-query adds the other lanes'
 *   grouped counts.
 *
 * Nothing changes when the flag is off: the shadow is never installed.
 */

type DocumentsFacade = EvoSDK['documents']
type Query = Parameters<DocumentsFacade['query']>[0]
type Where = NonNullable<Query['where']>[number]

const DEFAULT_LIMIT = 100
/** Per-lane cursors of pages already served, keyed by request shape and the page's last id. */
const MAX_REMEMBERED = 500
const remembered = new Map<string, LaneCursor[]>()

/** `query` without its paging keys. */
function withoutPaging(query: Query): Query {
  const rest = { ...query }
  delete rest.startAfter
  delete rest.startAt
  return rest
}

function shapeKey(query: Query): string {
  const { limit, ...shape } = withoutPaging(query)
  return JSON.stringify({ ...shape, limited: limit !== undefined }, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value instanceof Uint8Array ? bs58.encode(value) : value)
}

function remember(key: string, lastId: string, cursors: LaneCursor[]): void {
  remembered.set(`${key}|${lastId}`, cursors)
  if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value as string)
}

const plain = new WeakMap<object, Record<string, unknown>>()
function fieldOf(doc: unknown, field: string): unknown {
  if (!doc || typeof doc !== 'object') return undefined
  let record = plain.get(doc)
  if (!record) {
    record = documentToPlainObject(doc)
    plain.set(doc, record)
  }
  if (field === '$id') return record.$id ?? record.id
  if (field === '$ownerId') return record.$ownerId ?? record.ownerId
  return record[field]
}

function idString(doc: unknown, fallback: string): string {
  const id = fieldOf(doc, '$id')
  if (typeof id === 'string') return id
  if (id instanceof Uint8Array) return bs58.encode(id)
  return fallback
}

/** The merged documents read: every lane with its own cursor, merged in the request's order. */
async function queryLanes(
  original: DocumentsFacade['query'],
  query: Query,
  variants: Where[][],
): Promise<Map<string, unknown>> {
  if (query.startAt !== undefined) {
    logger.warn('Archive view: a startAt read is served from the listed lane only')
    return original(query)
  }
  const key = shapeKey(query)
  const limit = query.limit ?? DEFAULT_LIMIT
  const startAfter = typeof query.startAfter === 'string' ? query.startAfter : query.startAfter instanceof Uint8Array ? bs58.encode(query.startAfter) : null
  let previous: LaneCursor[] = variants.map(() => null)
  if (startAfter) {
    const known = remembered.get(`${key}|${startAfter}`)
    if (!known) {
      logger.warn('Archive view: no lane cursors for this page; continuing from the listed lane only')
      return original(query)
    }
    previous = known
  }
  const pages = await Promise.all(variants.map(async (where, lane): Promise<LanePage<[string, unknown]>> => {
    const cursor = previous[lane]
    if (cursor === 'done') return { docs: [], full: false }
    const result = await original({ ...withoutPaging(query), where, ...(cursor ? { startAfter: cursor } : {}) })
    const docs = Array.from(result.entries()).filter(([, doc]) => doc !== undefined)
    return { docs, full: result.size >= limit }
  }))
  const compare = documentComparator<[string, unknown]>(query.orderBy as OrderClause[] | undefined, ([, doc], field) => fieldOf(doc, field))
  const merged = mergeLanePages(pages, previous, limit, compare, ([id, doc]) => idString(doc, id))
  const last = merged.docs[merged.docs.length - 1]
  if (last) remember(key, idString(last[1], last[0]), merged.cursors)
  return new Map(merged.docs)
}

/** Groups a ranked result's entries by `groupKeyHex`. */
type RankedResult = Awaited<ReturnType<DocumentsFacade['ranked']>>
type RankedEntry = RankedResult['entries'][number]
type RankedQuery = Parameters<DocumentsFacade['ranked']>[0]
type RankedPin = NonNullable<RankedQuery['where']>[number]

/** The unshadowed facade methods: lane reads must never fan out again. */
interface Originals {
  query: DocumentsFacade['query']
  count: DocumentsFacade['count']
  average: DocumentsFacade['average']
  ranked: DocumentsFacade['ranked']
  composite: DocumentsFacade['composite']
}

async function rankedLanes(
  originals: Originals,
  query: RankedQuery,
  variants: RankedPin[][],
): Promise<RankedResult> {
  const results = await Promise.all(variants.map((where) => originals.ranked({ ...query, where })))
  const first = results[0]
  const groups = new Map<string, RankedEntry>()
  const aggregate = query.aggregate
  const isAverage = aggregate.type === 'avg'
  for (const result of results) {
    for (const entry of result.entries) {
      const prior = groups.get(entry.groupKeyHex)
      if (!prior) groups.set(entry.groupKeyHex, { ...entry })
      else if (!isAverage) groups.set(entry.groupKeyHex, { ...prior, value: prior.value + entry.value })
    }
  }
  const scale = first?.valueScale ?? 1n
  if (aggregate.type === 'avg' && groups.size > 0) {
    // Re-average from each lane's {count, sum} for the groups any lane ranked.
    const values = Array.from(new Set(Array.from(groups.values()).map((entry) => entry.groupValue).filter((value) => value !== undefined)));
    // Up to lanes x limit groups can be ranked, over what one `in` clause may hold: read them in batches.
    // The batches hold different groups, so their per-group {count, sum} simply add up with the lanes'.
    const sums = await Promise.all(variants.flatMap((where) => chunk(values, MAX_IN_CLAUSE_VALUES).map((batch) => originals.average({
      dataContractId: query.dataContractId,
      documentTypeName: query.documentTypeName,
      where: [...where, [query.groupBy, 'in', batch]],
      groupBy: [query.groupBy],
    }, aggregate.property))))
    const totals = sumLaneAverages(sums.map((map) => new Map(Array.from(map.entries()).map(([k, v]) => [k.toLowerCase(), v]))))
    for (const [hex, entry] of groups) {
      const total = totals.get(hex.toLowerCase())
      if (total && total.count > 0n) groups.set(hex, { ...entry, value: (total.sum * scale) / total.count })
    }
  }
  const descending = (query.direction ?? 'desc') === 'desc'
  const ranked = Array.from(groups.values())
    .sort((a, b) => (a.value === b.value ? 0 : (a.value > b.value) === descending ? -1 : 1))
    .slice(0, query.limit)
  const startingRank = first?.startingRank ?? 0n
  const entries = ranked.map((entry, index) => ({
    ...entry,
    rank: startingRank + BigInt(index),
    valueAsNumber: Number(entry.value) / Number(scale),
  }))
  return { ...first, entries } as RankedResult
}

type CompositeQuery = Parameters<DocumentsFacade['composite']>[0]
type CompositeResult = Awaited<ReturnType<DocumentsFacade['composite']>>

function boundValues(result: { pageDocuments: unknown[]; subResults: CompositeResult['subResults'] }, source: 'page' | number | undefined, property: string): string[] {
  const docs = source === undefined || source === 'page'
    ? result.pageDocuments
    : (result.subResults[source] as { documents?: unknown[] } | undefined)?.documents ?? []
  const values = new Set<string>()
  for (const doc of docs) {
    const value = fieldOf(doc, property)
    if (typeof value === 'string' && value) values.add(value)
    else if (value instanceof Uint8Array) values.add(bs58.encode(value))
  }
  return Array.from(values)
}

async function compositeLanes(originals: Originals, query: CompositeQuery): Promise<CompositeResult> {
  let request = query
  let order: string[] | null = null
  const pageVariants = laneVariants(query.where)
  if (pageVariants.length > 1) {
    const page = await queryLanes(originals.query, {
      dataContractId: query.dataContractId,
      documentTypeName: query.documentType,
      where: query.where,
      orderBy: query.orderBy,
      limit: query.limit,
    }, pageVariants)
    order = Array.from(page.entries()).map(([id, doc]) => idString(doc, id))
    if (order.length === 0) {
      return {
        pageDocuments: [],
        subResults: query.subQueries.map((sub) => (sub.kind === 'counts'
          ? { kind: 'counts', counts: new Map<string, bigint>() }
          : { kind: 'documents', documents: [], missingIds: [], removed: [] })),
      } as unknown as CompositeResult
    }
    request = { ...query, where: [['$id', 'in', order]], orderBy: undefined }
  }
  const result = await originals.composite(request)
  if (order) {
    const position = new Map(order.map((id, index) => [id, index]))
    result.pageDocuments.sort((a, b) => (position.get(idString(a, '')) ?? 0) - (position.get(idString(b, '')) ?? 0))
  }
  await Promise.all(query.subQueries.map(async (sub, index) => {
    const variants = laneVariants(sub.where)
    const target = result.subResults[index]
    if (variants.length < 2 || sub.kind !== 'counts' || !sub.bind || target?.kind !== 'counts') return
    const values = boundValues(result, sub.bind.source, sub.bind.sourceProperty)
    if (values.length === 0) return
    const field = sub.bind.field
    const extra = await Promise.all(variants.slice(1).map((where) => originals.count({
      dataContractId: sub.dataContractId ?? query.dataContractId,
      documentTypeName: sub.documentType,
      where: [...where, [field, 'in', values]],
      groupBy: [field],
    })))
    // Grouped counts key by the value's bytes as hex; the composite keys by base58.
    const asBase58 = extra.map((map) => new Map(Array.from(map.entries()).map(([key, count]) =>
      [/^[0-9a-fA-F]{64}$/.test(key) ? bs58.encode(Uint8Array.from(key.match(/../g) ?? [], (h) => parseInt(h, 16))) : key, count])))
    target.counts = sumLaneMaps([target.counts, ...asBase58])
  }))
  return result
}

/**
 * Shadow `sdk.documents` so every laned read covers every lane. Installed once
 * per constructed SDK by `evo-sdk-service`, and only on an archival build.
 */
export function installLaneFanout(sdk: EvoSDK): void {
  if (!moderationViewAll()) return
  const facade = sdk.documents
  if (!facade) return
  const originals: Originals = {
    query: facade.query.bind(facade),
    count: facade.count.bind(facade),
    average: facade.average.bind(facade),
    ranked: facade.ranked.bind(facade),
    composite: facade.composite.bind(facade),
  }
  const shadow = <K extends keyof DocumentsFacade>(name: K, value: DocumentsFacade[K]) =>
    Object.defineProperty(facade, name, { configurable: true, writable: true, value })

  shadow('query', (async (request: Query) => {
    const variants = laneVariants(request.where)
    return variants.length > 1 ? queryLanes(originals.query, request, variants) : originals.query(request)
  }) as DocumentsFacade['query'])

  shadow('count', (async (request: Query) => {
    const variants = laneVariants(request.where)
    if (variants.length < 2) return originals.count(request)
    const maps = await Promise.all(variants.map((where) => originals.count({ ...request, where })))
    return sumLaneMaps(maps)
  }) as DocumentsFacade['count'])

  shadow('average', (async (request: Query, property: string) => {
    const variants = laneVariants(request.where)
    if (variants.length < 2) return originals.average(request, property)
    const maps = await Promise.all(variants.map((where) => originals.average({ ...request, where }, property)))
    return sumLaneAverages(maps)
  }) as DocumentsFacade['average'])

  shadow('ranked', (async (request: RankedQuery) => {
    const variants = laneVariants(request.where)
    return variants.length > 1 ? rankedLanes(originals, request, variants) : originals.ranked(request)
  }) as DocumentsFacade['ranked'])

  shadow('composite', (async (request: CompositeQuery) => {
    const laned = laneVariants(request.where).length > 1 || request.subQueries.some((sub) => laneVariants(sub.where).length > 1)
    return laned ? compositeLanes(originals, request) : originals.composite(request)
  }) as DocumentsFacade['composite'])
}

/** Test seam: forget remembered lane cursors. */
export function resetLaneCursorsForTests(): void {
  remembered.clear()
}
