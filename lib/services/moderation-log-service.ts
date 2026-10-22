import { logger } from '@/lib/logger'
import {
  YAPPR_BLOG_CONTRACT_ID,
  YAPPR_CONTRACT_ID,
  YAPPR_STOREFRONT_CONTRACT_ID,
  blogListingsCarryModLane,
  storefrontListingsCarryModLane,
} from '@/lib/constants'
import { moderatorsCannotDelete } from '@/lib/contract-topology'
import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { mergeLanePages, type LaneCursor, type LanePage } from '@/lib/moderation-lanes'
import { getEvoSdk } from './evo-sdk-service'
import { charterReasonText } from './charter-reasons'
import { documentToPlainObject, identifierToBase58, normalizeSDKResponse, type DocumentOrderByClause, type DocumentWhereClause } from './sdk-helpers'

/**
 * The moderation log (`/moderation-log`, `NEXT_PUBLIC_MODERATION_LOG=1`,
 * docs/ARCHIVE_FRONTEND.md): what a contract's moderators have done, newest
 * first, merged from the reads docs/SOCIAL_V18.md lists as the moderation log
 * (`purpose: 'log'` in scripts/hide-moderation-queries.mjs):
 *
 * - every moderated type's `moderated [mod, $moderatedAt]` index, lanes
 *   `mod == 1` (hidden) and `mod == 2` (legal hold). A document that was
 *   unhidden leaves the index, so the log holds what is hidden NOW, not every
 *   hide there ever was;
 * - the contract's `restriction.log [state, $moderatedAt]`, states 1 (in force)
 *   and 2 (lifted), social and blog only;
 * - the warning list, read through `moderationEntriesWithProof`. A warning
 *   carries no moderator id and the list is in identity order, not time order,
 *   so it is read whole (a team warns few people) and merged as a source of
 *   its own.
 *
 * Each source is paged with its own cursor and the pages are k-way merged by
 * time, the archival frontend's lane merge (lib/moderation-lanes.ts). No
 * write, no keys.
 */

export type LogContract = ModeratedContractKey
export const LOG_CONTRACTS: readonly LogContract[] = ['social', 'blog', 'storefront']

/** Rows per page of the merged log, and per source read. */
export const LOG_PAGE_SIZE = 20
/** The warning list is read 100 identities a page, at most this many pages. */
const WARNING_PAGES = 20
const WARNING_PAGE_SIZE = 100

/** The moderated types each contract's log reads. */
const LOGGED_TYPES: Record<LogContract, readonly string[]> = {
  social: ['post', 'reply', 'yapprProfile'],
  blog: ['blog', 'blogPost', 'blogComment'],
  storefront: ['store', 'storeItem', 'storeReview', 'itemReview'],
}
/** The contracts that carry a `restriction` type. */
const RESTRICTION_CONTRACTS: ReadonlySet<LogContract> = new Set(['social', 'blog'])

export type LogAction = 'hidden' | 'legalHold' | 'restricted' | 'restrictionLifted' | 'warned'

/** One line of the log. */
export interface LogRow {
  /** The document id, or a warning's own key: unique across sources, and the paging cursor of its source. */
  key: string
  contract: LogContract
  action: LogAction
  /** The document type acted on; `restriction` for an account restriction, `warning` for a warning. */
  docType: string
  /** The moderator who acted (base58); null for a warning, which stores none. */
  moderatorId: string | null
  /** The author of a hidden item, or the account restricted or warned (base58). */
  subjectId: string | null
  /** When the action was taken (ms). */
  at: number
  /** The charter reason (`modLabel`, or a restriction's `reason`): a number from 1 to 63. */
  reasonCode: number | null
  /** A warning's free-text reason. */
  reasonText: string | null
  /** Where to look at the item or account; null when it cannot be told. */
  href: string | null
  /** A blog comment's post, which its link is read from; null for everything else. */
  parentId: string | null
}

export type LogSource =
  | { id: string; kind: 'moderated'; contract: LogContract; docType: string; mod: 1 | 2 }
  | { id: string; kind: 'restriction'; contract: LogContract; state: 1 | 2 }
  | { id: string; kind: 'warnings'; contract: LogContract }

// ---- availability --------------------------------------------------------------

/** The contract's id in this build; empty when its feature is off. */
export function logContractId(contract: LogContract): string {
  switch (contract) {
    case 'social': return YAPPR_CONTRACT_ID
    case 'blog': return YAPPR_BLOG_CONTRACT_ID
    case 'storefront': return YAPPR_STOREFRONT_CONTRACT_ID
  }
}

/** True when this build talks to a cut of the contract that has the moderation log (social v18, blog v10, storefront v11). */
export function logAvailable(contract: LogContract): boolean {
  if (!logContractId(contract)) return false
  switch (contract) {
    case 'social': return moderatorsCannotDelete()
    case 'blog': return blogListingsCarryModLane()
    case 'storefront': return storefrontListingsCarryModLane()
  }
}

/** The contracts whose log this build can show. */
export function availableLogContracts(): LogContract[] {
  return LOG_CONTRACTS.filter(logAvailable)
}

/** Every read source of one contract's log. */
export function logSources(contract: LogContract): LogSource[] {
  const sources: LogSource[] = LOGGED_TYPES[contract].flatMap((docType): LogSource[] =>
    ([1, 2] as const).map((mod) => ({ id: `${docType}:mod${mod}`, kind: 'moderated', contract, docType, mod })))
  if (RESTRICTION_CONTRACTS.has(contract)) {
    for (const state of [1, 2] as const) sources.push({ id: `restriction:state${state}`, kind: 'restriction', contract, state })
  }
  if (moderatedContract(contract).listsKept().includes('warnings')) sources.push({ id: 'warnings', kind: 'warnings', contract })
  return sources
}

// ---- requests (pinned against the read catalogue by the spec) --------------------

export interface LogDocumentRequest {
  documentTypeName: string
  where: DocumentWhereClause[]
  orderBy: DocumentOrderByClause[]
  limit: number
  startAfter?: string
}

/** The document read of a `moderated` or `restriction` source: the newest action first, after `startAfter`. */
export function logRequest(source: LogSource, limit = LOG_PAGE_SIZE, startAfter?: string): LogDocumentRequest | null {
  if (source.kind === 'warnings') return null
  const [documentTypeName, key, value] = source.kind === 'moderated'
    ? [source.docType, 'mod', source.mod] as const
    : ['restriction', 'state', source.state] as const
  return {
    documentTypeName,
    where: [[key, '==', value], ['$moderatedAt', '>', 0]],
    orderBy: [['$moderatedAt', 'desc']],
    limit,
    ...(startAfter ? { startAfter } : {}),
  }
}

// ---- rows (pure) ---------------------------------------------------------------

const asMs = (value: unknown): number | null => {
  const ms = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  return Number.isFinite(ms) && ms > 0 ? ms : null
}
const asCode = (value: unknown): number | null => {
  const code = Number(value)
  return Number.isInteger(code) && code > 0 ? code : null
}
const asText = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** Where to look at what a document is about; null when the document does not say. */
export function logHref(docType: string, doc: Record<string, unknown>, id: string, subjectId: string | null): string | null {
  const text = (field: string) => asText(identifierToBase58(doc[field]) ?? doc[field])
  const q = encodeURIComponent
  switch (docType) {
    case 'post': return `/post?id=${q(id)}`
    case 'reply': {
      const root = text('rootPostId')
      return root ? `/post?id=${q(root)}&reply=${q(id)}` : null
    }
    case 'yapprProfile':
    case 'restriction':
      return subjectId ? `/user?id=${q(subjectId)}` : null
    case 'blog': return `/blog?blog=${q(id)}`
    case 'blogPost': {
      const blog = text('blogId')
      const slug = asText(doc.slug)
      return blog && slug ? `/blog?blog=${q(blog)}&post=${q(slug)}` : null
    }
    case 'store': return `/store/view?id=${q(id)}`
    case 'storeItem': return `/item?id=${q(id)}`
    case 'storeReview': {
      const store = text('storeId')
      return store ? `/store/view?id=${q(store)}` : null
    }
    case 'itemReview': {
      const item = text('itemId')
      return item ? `/item?id=${q(item)}` : null
    }
    default: return null
  }
}

/**
 * A log row for a stored document read through `source`, or null when it is
 * not one the source describes (a malformed document, or a `moderated` one
 * with no moderation stamp). The time is the moderator's stamp,
 * `$moderatedAt`.
 */
export function rowFromDocument(source: LogSource, doc: Record<string, unknown>): LogRow | null {
  if (source.kind === 'warnings') return null
  const id = identifierToBase58(doc.$id ?? doc.id)
  const at = asMs(doc.$moderatedAt)
  if (!id || at === null) return null
  const moderatorId = identifierToBase58(doc.$moderatedBy)
  if (source.kind === 'restriction') {
    const target = identifierToBase58(doc.target)
    if (!target || (Number(doc.state) !== 1 && Number(doc.state) !== 2)) return null
    return {
      key: id, contract: source.contract, action: Number(doc.state) === 1 ? 'restricted' : 'restrictionLifted', docType: 'restriction',
      moderatorId, subjectId: target, at, reasonCode: asCode(doc.reason), reasonText: null,
      href: logHref('restriction', doc, id, target), parentId: null,
    }
  }
  const mod = Number(doc.mod)
  if (mod !== 1 && mod !== 2) return null
  const subjectId = identifierToBase58(doc.$ownerId)
  return {
    key: id, contract: source.contract, action: mod === 2 ? 'legalHold' : 'hidden', docType: source.docType,
    moderatorId, subjectId, at, reasonCode: asCode(doc.modLabel), reasonText: null,
    href: logHref(source.docType, doc, id, subjectId),
    parentId: source.docType === 'blogComment' ? identifierToBase58(doc.blogPostId) : null,
  }
}

/** The warning entries of a page of the warning list, one row per warning. */
export function warningRows(contract: LogContract, entries: ReadonlyArray<{ identityId: string; warnings?: ReadonlyArray<{ warnedAt: bigint | number; reason: { text: string } }> }>): LogRow[] {
  return entries.flatMap((entry) => (entry.warnings ?? []).flatMap((warning, index): LogRow[] => {
    const at = asMs(warning.warnedAt)
    if (at === null) return []
    return [{
      key: `warning:${entry.identityId}:${at}:${index}`, contract, action: 'warned', docType: 'warning',
      moderatorId: null, subjectId: entry.identityId, at, reasonCode: null, reasonText: asText(warning.reason.text),
      href: `/user?id=${encodeURIComponent(entry.identityId)}`, parentId: null,
    }]
  }))
}

/** Newest first; equal times by key, descending, as Drive breaks them within a read. */
export function compareLogRows(a: LogRow, b: LogRow): number {
  return b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)
}

/** The rows of a fully read, time-sorted source that follow `after` (a row key), one page of them. */
export function pageAfter(sorted: readonly LogRow[], after: string | null, limit: number): LanePage<LogRow> {
  const start = after === null ? 0 : sorted.findIndex((row) => row.key === after) + 1
  const docs = sorted.slice(start, start + limit)
  return { docs, full: start + limit < sorted.length }
}

/**
 * The first `limit` rows of the sources' pages in time order, and each
 * source's cursor after it (`done` once exhausted). A cursor is the key of the
 * source's last row taken, which the next read starts after. Rows another
 * source already supplied are skipped.
 */
export function mergeLog(pages: readonly LanePage<LogRow>[], previous: readonly LaneCursor[], limit = LOG_PAGE_SIZE): { rows: LogRow[]; cursors: LaneCursor[]; more: boolean } {
  const merged = mergeLanePages(pages, previous, limit, compareLogRows, (row) => row.key)
  return { rows: merged.docs, cursors: merged.cursors, more: merged.more }
}

// ---- wording (pure) --------------------------------------------------------------

const NOUNS: Record<string, string> = {
  post: 'Post', reply: 'Reply', yapprProfile: 'Profile', blog: 'Blog', blogPost: 'Blog post', blogComment: 'Blog comment',
  store: 'Store', storeItem: 'Listing', storeReview: 'Store review', itemReview: 'Listing review',
}

/** What happened, as a short line: "Post hidden", "Account restricted". */
export function actionText(row: Pick<LogRow, 'action' | 'docType'>): string {
  const noun = NOUNS[row.docType] ?? 'Item'
  switch (row.action) {
    case 'hidden': return `${noun} hidden`
    case 'legalHold': return `${noun} hidden for legal reasons`
    case 'restricted': return 'Account restricted'
    case 'restrictionLifted': return 'Restriction lifted'
    case 'warned': return 'Account warned'
  }
}

/**
 * The reason line of a row: a warning's own text, or a hide's `modLabel` or a
 * restriction's `reason` read the way every label reads it
 * (lib/services/charter-reasons.ts). Null when the row gives no reason, and
 * when nothing explains its label (the charter could not be read, or does not
 * list it): never a bare number.
 */
export async function reasonText(contract: LogContract, row: Pick<LogRow, 'reasonCode' | 'reasonText'>): Promise<string | null> {
  if (row.reasonText) return row.reasonText
  if (row.reasonCode === null) return null
  return charterReasonText(contract, row.reasonCode)
}

// ---- reads ---------------------------------------------------------------------

export interface LogPage {
  rows: LogRow[]
  cursors: LaneCursor[]
  more: boolean
}

/**
 * One contract's log. A reader holds the (whole) warning list it has read, so
 * make a new one to start over.
 */
export class ModerationLogReader {
  readonly sources: LogSource[]
  private warnings: Promise<LogRow[]> | null = null

  constructor(readonly contract: LogContract) {
    this.sources = logSources(contract)
  }

  /** The cursors of a first page. */
  initialCursors(): LaneCursor[] {
    return this.sources.map(() => null)
  }

  /** The next page after `cursors`. Rejects when any source cannot be read: a partial log would read as a complete one. */
  async page(cursors: readonly LaneCursor[], limit = LOG_PAGE_SIZE): Promise<LogPage> {
    const pages = await Promise.all(this.sources.map((source, index) =>
      cursors[index] === 'done' ? Promise.resolve<LanePage<LogRow>>({ docs: [], full: false }) : this.readSource(source, cursors[index], limit)))
    const merged = mergeLog(pages, cursors, limit)
    return { ...merged, rows: await this.withCommentLinks(merged.rows) }
  }

  private async readSource(source: LogSource, cursor: LaneCursor, limit: number): Promise<LanePage<LogRow>> {
    const after = typeof cursor === 'string' && cursor !== 'done' ? cursor : null
    if (source.kind === 'warnings') {
      this.warnings ??= this.readWarnings().catch((error: unknown) => {
        this.warnings = null
        throw error
      })
      return pageAfter(await this.warnings, after, limit)
    }
    const request = logRequest(source, limit, after ?? undefined)
    if (!request) return { docs: [], full: false }
    const sdk = await getEvoSdk()
    const response = await sdk.documents.query({ dataContractId: logContractId(source.contract), ...request })
    const docs = normalizeSDKResponse(response)
    return {
      docs: docs.flatMap((doc) => rowFromDocument(source, doc) ?? []),
      full: docs.length >= limit,
    }
  }

  /** Every warning, newest first. */
  private async readWarnings(): Promise<LogRow[]> {
    const sdk = await getEvoSdk()
    const rows: LogRow[] = []
    let startAfter: string | undefined
    for (let page = 0; page < WARNING_PAGES; page++) {
      const { data } = await sdk.contracts.moderationEntriesWithProof({
        contractId: logContractId(this.contract), list: 'warnings', limit: WARNING_PAGE_SIZE, ...(startAfter ? { startAfter } : {}),
      })
      rows.push(...warningRows(this.contract, data.entries))
      startAfter = data.nextStartAfter
      if (!startAfter) break
    }
    return rows.sort(compareLogRows)
  }

  /** A blog comment names only its post: read the posts to link to them. */
  private async withCommentLinks(rows: LogRow[]): Promise<LogRow[]> {
    const parentIds = [...new Set(rows.flatMap((row) => (row.docType === 'blogComment' && row.href === null && row.parentId ? [row.parentId] : [])))]
    if (parentIds.length === 0) return rows
    const sdk = await getEvoSdk()
    const hrefs = new Map<string, string>()
    await Promise.all(parentIds.map(async (postId) => {
      try {
        const post = await sdk.documents.get(logContractId('blog'), 'blogPost', postId)
        const plain = post ? documentToPlainObject(post) : null
        const blogId = plain ? identifierToBase58(plain.blogId) : null
        const slug = plain ? asText(plain.slug) : null
        if (blogId && slug) hrefs.set(postId, `/blog?blog=${encodeURIComponent(blogId)}&post=${encodeURIComponent(slug)}`)
      } catch (error) {
        logger.warn('moderationLog: could not link a blog comment to its post', error)
      }
    }))
    return rows.map((row) => (row.parentId && hrefs.has(row.parentId) ? { ...row, href: hrefs.get(row.parentId) ?? null } : row))
  }
}
