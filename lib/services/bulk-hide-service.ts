import { listingsCarryModLane } from '@/lib/contract-topology'
import { logger } from '@/lib/logger'
import { moderatedContract } from '@/lib/moderated-contracts'
import { inLane, laneMod, newestFirst, readEveryPage, type BulkItem, type BulkKind, type BulkMode, type BulkPage } from '@/lib/moderation-bulk'
import { getEvoSdk } from './evo-sdk-service'
import { moderationService } from './moderation-service'
import { MAX_IN_CLAUSE_VALUES } from './pagination-utils'
import { identifierToBase58, normalizeSDKResponse } from './sdk-helpers'

/**
 * The reads behind the bulk hide (lib/moderation-bulk.ts) on social v18: one
 * account's posts and replies in one moderation lane, and, for a run, which
 * of them still read the way they did, straight from the chain (proved).
 *
 * Both lanes are on `post.ownerAndTime` and `reply.ownerAndTime`, keyed
 * `[live, mod, $ownerId, $createdAt]` (docs/SOCIAL_V18.md, "Reading the
 * lanes"): a hide lists `live == 1, mod == null` (what yap.pr shows), an
 * unhide `live == 1, mod == 1` (hidden, not under legal hold). What was
 * posted while restricted (`live == 2`) is out of every feed already.
 * Every document read is checked against its lane again here, so an archive
 * build, whose SDK merges every lane into a listing read
 * (lib/services/sdk-lane-fanout.ts), lists the same documents.
 */

const KINDS: readonly BulkKind[] = ['post', 'reply']
const PAGE_SIZE = 100
const PREVIEW_CHARS = 200

/** Where the tool works: social v18, with the moderators able to hide posts and replies. */
export function bulkHideAvailable(): boolean {
  return listingsCarryModLane() && moderationService.canHide('post') && moderationService.canHide('reply')
}

function toItem(doc: Record<string, unknown>, kind: BulkKind): BulkItem | null {
  const id = identifierToBase58(doc.$id ?? doc.id)
  if (!id) return null
  const content = typeof doc.content === 'string' ? doc.content.trim() : ''
  return { id, kind, createdAt: Number(doc.$createdAt ?? doc.createdAt ?? 0), preview: content.slice(0, PREVIEW_CHARS) }
}

class BulkHideService {
  private get contractId(): string {
    return moderatedContract('social').contractId
  }

  /** One page of `authorId`'s `kind` documents in `mode`'s lane, newest first. */
  async readPage(kind: BulkKind, authorId: string, mode: BulkMode, startAfter?: string): Promise<BulkPage> {
    const sdk = await getEvoSdk()
    const response = await sdk.documents.query({
      dataContractId: this.contractId,
      documentTypeName: kind,
      where: [['live', '==', 1], ['mod', '==', laneMod(mode)], ['$ownerId', '==', authorId], ['$createdAt', '>', 0]],
      orderBy: [['live', 'asc'], ['mod', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: PAGE_SIZE,
      ...(startAfter ? { startAfter } : {}),
    })
    const docs = normalizeSDKResponse(response)
    const last = docs.length > 0 ? identifierToBase58(docs[docs.length - 1].$id ?? docs[docs.length - 1].id) : null
    const items = docs.filter((doc) => inLane(doc, mode)).map((doc) => toItem(doc, kind)).filter((item): item is BulkItem => item !== null)
    return { items, ...(docs.length >= PAGE_SIZE && last ? { next: last } : {}) }
  }

  /**
   * Every post and reply of `authorId` in `mode`'s lane, newest first, read
   * page by page; `onProgress` sees how many so far. `truncated` when one type
   * holds more than the dialog reads (lib/moderation-bulk.ts MAX_ITEMS_PER_KIND).
   */
  async readAll(authorId: string, mode: BulkMode, onProgress?: (count: number) => void): Promise<{ items: BulkItem[]; truncated: boolean }> {
    const counts = new Map<BulkKind, number>()
    const [posts, replies] = await Promise.all(KINDS.map((kind) => readEveryPage(
      (startAfter) => this.readPage(kind, authorId, mode, startAfter),
      {
        onPage: (items) => {
          counts.set(kind, items.length)
          onProgress?.([...counts.values()].reduce((sum, n) => sum + n, 0))
        },
      }
    )))
    return { items: newestFirst(posts.items, replies.items), truncated: posts.truncated || replies.truncated }
  }

  /**
   * The ids of `items` still in `mode`'s lane, read from the chain (`$id in`,
   * at most 100 per read): for a hide, the ones not hidden yet. A document
   * gone from state is not pending. Rejects when a read fails.
   */
  async pending(items: readonly BulkItem[], mode: BulkMode): Promise<Set<string>> {
    const sdk = await getEvoSdk()
    const still = new Set<string>()
    for (const kind of KINDS) {
      const ids = items.filter((item) => item.kind === kind).map((item) => item.id)
      for (let start = 0; start < ids.length; start += MAX_IN_CLAUSE_VALUES) {
        const batch = ids.slice(start, start + MAX_IN_CLAUSE_VALUES)
        const response = await sdk.documents.query({
          dataContractId: this.contractId,
          documentTypeName: kind,
          where: [['$id', 'in', batch]],
          limit: batch.length,
        })
        for (const doc of normalizeSDKResponse(response)) {
          const id = identifierToBase58(doc.$id ?? doc.id)
          if (id && inLane(doc, mode)) still.add(id)
        }
      }
    }
    logger.info(`bulkHide: ${still.size} of ${items.length} still to ${mode}`)
    return still
  }
}

export const bulkHideService = new BulkHideService()
