import { extractErrorMessage } from '@/lib/error-utils'
import type { TtlMap } from '@/lib/caches/ttl-map'
import type { Page } from '../api/dto'
import { badCursor, cursorInt, cursorString, decodeCursor, encodeCursor, type CursorFields } from './cursor'

/**
 * evo-sdk proof verification fails when a mixed-direction query (`x asc,
 * $createdAt desc`) pages past its last document on testnet, instead of
 * proving an empty page: https://github.com/dashpay/platform/issues/5244.
 * Only a continuation can hit it, and there it means the end of the list.
 */
const PROOF_DIRECTION_BUG = /Proof op family does not match the query direction/i

export async function endOnProofDirectionBug<T>(isContinuation: boolean, read: () => Promise<T>, end: () => T): Promise<T> {
  try {
    return await read()
  } catch (error) {
    // The SDK's WasmSdkError is not an Error subclass; extractErrorMessage reads its message getter.
    if (isContinuation && PROOF_DIRECTION_BUG.test(extractErrorMessage(error))) return end()
    throw error
  }
}

/** A page continued by a cursor of `kind` holding `next`, or the last page when `next` is null. */
export function nextPage<T>(items: T[], kind: string, next: CursorFields | null): Page<T> {
  return { items, cursor: next ? encodeCursor(kind, next) : null, hasMore: next !== null }
}

export const onePage = <T>(items: T[]): Page<T> => ({ items, cursor: null, hasMore: false })
export const emptyPage = <T>(): Page<T> => onePage([])

/**
 * A keyset page continued after a document id (`startAfter`): decodes the
 * `{after}` cursor of `kind`, runs `read`, ends a continuation that hits
 * #5244, and encodes the `next` id `build` reports (none at the end). With
 * `empty`, the end of the list still goes through `build` (with that result),
 * so a page that holds items back can flush them.
 */
export async function pageAfter<R, T>(
  kind: string,
  cursor: string | null | undefined,
  read: (after: string | undefined) => Promise<R>,
  build: (result: R, after: string | undefined) => Promise<{ items: T[]; next: string | null | undefined }>,
  empty?: R,
): Promise<Page<T>> {
  const fields = decodeCursor<{ after: string }>(cursor, kind)
  const after = fields ? cursorString(fields.after) : undefined
  const result = await endOnProofDirectionBug<R | null>(after !== undefined, () => read(after), () => empty ?? null)
  if (result === null) return emptyPage()
  const { items, next } = await build(result, after)
  return nextPage(items, kind, next ? { after: next } : null)
}

/**
 * One page of a list lib reads whole (followers, engagements, mentions, v2
 * tags). The list is fetched once per `key` and kept for a minute, so the
 * pages of one scroll agree; a cursor outliving it re-reads the list.
 */
export async function pageOfList<T, R>(options: {
  kind: string
  key: string
  cursor: string | null | undefined
  size: number
  cache: TtlMap<string, T[]>
  load: () => Promise<T[]>
  hydrate: (slice: T[]) => Promise<R[]>
}): Promise<Page<R>> {
  const fields = decodeCursor<{ key: string; offset: number }>(options.cursor, options.kind)
  if (fields && fields.key !== options.key) throw badCursor('issued for another list')
  const offset = fields ? cursorInt(fields.offset) : 0
  let list = options.cache.get(options.key)
  if (!list || !fields) {
    list = await options.load()
    // Expired entries linger in a TtlMap until pruned; a long session visits many lists.
    options.cache.prune()
    options.cache.set(options.key, list)
  }
  const end = offset + options.size
  return nextPage(await options.hydrate(list.slice(offset, end)), options.kind, end < list.length ? { key: options.key, offset: end } : null)
}
