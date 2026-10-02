import { TtlMap } from '@/lib/caches/ttl-map'
import { POLLR_CONTRACT_ID, POLLR_DOCUMENT_TYPES, YAPPR_CONTRACT_ID } from '@/lib/constants'
import {
  authorDeletesLeaveHoles, canRepost, deletesAreTombstones, hasFlatThreads, referencesMayDangle, repostsAreQuotes, targetKindOf,
  threadRootIdOf, type TargetKind,
} from '@/lib/contract-topology'
import { deletedReplyStubs, unloadedReplyParents } from '@/lib/feed/deleted-reply-stubs'
import { provenAbsent } from '@/lib/feed/prove-absent'
import { isBareRepost, quotedTargetIdOf, splitRepostsAndQuotes } from '@/lib/feed/quote-reposts'
import { likeService } from '@/lib/services/like-service'
import { pollrPollService, type Poll } from '@/lib/services/pollr-poll-service'
import { pollrVoteService, type PollTally } from '@/lib/services/pollr-vote-service'
import { postService, replyToPost } from '@/lib/services/post-service'
import { replyService } from '@/lib/services/reply-service'
import { base58ToBytes } from '@/lib/services/sdk-helpers'
import { repostService } from '@/lib/services/repost-service'
import { loadEngagementCounts } from '@/lib/services/social-stats-service'
import type { Post, Reply } from '@/lib/types'
import { cursorInt, decodeCursor } from '../dto/cursor'
import {
  enrichToDTOs, loadUserSummaries, notSupported, readFailure, requireViewer, searchUserSummaries, toPostDTOs, viewerId, withLoadingAuthor,
} from '../dto/hydrate'
import { emptyPage, endOnProofDirectionBug, nextPage, pageOfList } from '../dto/paging'
import { RpcError } from '../protocol/envelope'
import { assembleFlatThread, assembleV2Thread, flattenThreads, RENDERED_DEPTH, type FlatReply } from '../dto/thread'
import { assertTarget, badRequest, relationProbe, signer, socialDoc, ticketTarget } from '../writes/handler-kit'
import { documentExists, fromBoolean } from '../writes/lib-results'
import { createPublishHandler, validateDraft, type DraftDTO } from '../writes/publish'
import type { TicketStore } from '../writes/tickets'
import type { TargetRef, WriteTicket } from '../writes/types'
import {
  toPostDTO,
  type AuthorDTO, type EngagementCountsDTO, type EngagementDTO, type EngagementPage, type PollDTO, type PostDTO, type ThreadDTO,
  type ThreadReplyDTO, type UserSummaryDTO,
} from './dto'

export type { DraftDTO } from '../writes/publish'

/** What an engagement or count read targets: the id and the doctype it lives in. */
export interface TargetQuery {
  id: string
  kind: TargetKind
}

export type EngagementTab = 'likes' | 'reposts' | 'quotes'

/** `app/post/engagements/page.tsx` reads whole lists; the engine pages them. */
const ENGAGEMENT_PAGE = 30
/** v10 reads the quote list once and splits it into reposts and quotes (the page's cap). */
const QUOTE_LIST_LIMIT = 100
/** v2 thread ancestry walk (`use-post-detail.ts`). */
const MAX_ANCESTORS = 50
/** `components/compose/mention-autocomplete.tsx`. */
const MENTION_MIN_LENGTH = 3
const MENTION_LIMIT = 5

interface EngagementEntry {
  ownerId: string
  quote?: { id: string; content: string }
}

interface QuoteSplit {
  reposts: EngagementEntry[]
  quotes: EngagementEntry[]
  /** The list filled its 100-document read: the counts are floors ("100+"). */
  truncated: boolean
}

const engagementLists = new TtlMap<string, EngagementEntry[]>(60_000)
/** v10: one quote-list read per target serves both tabs and the counts. */
const quoteSplits = new TtlMap<string, QuoteSplit>(60_000)
/** Raw thread reply pages by `root:startAfter`, so widening a thread re-reads only its new page. */
const replyPages = new TtlMap<string, { documents: Reply[]; nextCursor?: string }>(60_000)

/** A deleted-reply stub has no author: nothing to name or render an avatar for. */
const STUB_AUTHOR: AuthorDTO = { id: '', username: null, displayName: '', avatar: { uri: null, dicebear: null }, resolved: false }

/** A post, or a reply as a Post, the way web's post page looks an id up. lib answers a failed read as null too. */
async function read(id: string): Promise<Post | null> {
  const post = await postService.getPostById(id, { skipEnrichment: true })
  if (post) return post
  // Replies are a separate doctype; web's usePostDetail falls back the same way.
  const reply = await replyService.getReplyById(id, { skipEnrichment: true })
  return reply ? replyToPost(reply) : null
}

/**
 * Whether a document of one of `types` exists under `id`, by proved reads
 * that throw when they cannot tell. Rejects with the read's failure
 * (`readFailure`), so an unreadable post never reads as a missing one.
 */
async function existsAs(id: string, types: readonly string[], contractId: string): Promise<boolean> {
  try {
    const found = await Promise.all(types.map(type => documentExists({ contractId, type, id })))
    return found.some(Boolean)
  } catch (error) {
    throw readFailure(error)
  }
}

/**
 * `reread` after lib answered null: `null` only when proved missing; the
 * document when it is there after all (lib's read failed: a stale quorum, a
 * lagging node) and a second read gets it; otherwise rejects `NETWORK`.
 */
async function provedMissing<T>(
  id: string, types: readonly string[], reread: () => Promise<T | null>, contractId = YAPPR_CONTRACT_ID,
): Promise<T | null> {
  // No document has an id that is not 32 bytes: nothing to read (the SDK would refuse the id).
  if (base58ToBytes(id)?.length !== 32) return null
  if (!(await existsAs(id, types, contractId))) return null
  const again = await reread()
  if (again) return again
  throw new RpcError(`This ${types[0]} could not be read. Try again.`, 'NETWORK')
}

/** `read`, with `null` kept for a post or reply proved missing; a failed read rejects. */
async function load(id: string): Promise<Post | null> {
  return (await read(id)) ?? provedMissing(id, ['post', 'reply'], () => read(id))
}

/** `load`, following a v10 bare repost to its target, as web's post page redirects to it. */
async function loadFocus(id: string): Promise<Post | null> {
  const post = await load(id)
  const target = post && isBareRepost(post) ? quotedTargetIdOf(post) : undefined
  return target && target !== id ? load(target) : post
}

/**
 * The posts above a reply (`usePostDetail` `fetchReplyChain`): on flat threads
 * the root alone (a missing root is a takedown where references may dangle);
 * on v2 the parent chain, walked one lookup at a time.
 */
async function loadAncestors(focus: Post): Promise<{ chain: Post[]; removed: string[] }> {
  if (hasFlatThreads()) {
    const rootId = threadRootIdOf(focus)
    const readRoot = () => postService.getPostById(rootId, { skipEnrichment: true })
    // Only a proved absence is a removed root: a failed read rejects rather than claim a takedown.
    const root = (await readRoot()) ?? await provedMissing(rootId, ['post'], readRoot)
    if (root) return { chain: [root], removed: [] }
    return { chain: [], removed: referencesMayDangle() ? [rootId] : [] }
  }
  // The chain is context above the focus: an unreadable parent ends it, as on web.
  const chain: Post[] = []
  for (let parentId = focus.parentId; parentId && chain.length < MAX_ANCESTORS;) {
    const parent = await read(parentId)
    if (!parent) break
    chain.unshift(parent)
    parentId = parent.parentId
  }
  return { chain, removed: [] }
}

/** One raw reply page; `fresh` (a first load or refresh, as web's `refresh()`) re-reads it. */
async function replyPage(rootId: string, startAfter: string | undefined, fresh: boolean) {
  const key = `${rootId}:${startAfter ?? ''}`
  const cached = fresh ? undefined : replyPages.get(key)
  if (cached) return cached
  const page = await endOnProofDirectionBug(startAfter !== undefined,
    () => replyService.getReplies(rootId, { skipEnrichment: true, ...(startAfter ? { startAfter } : {}) }),
    () => ({ documents: [] as Reply[], nextCursor: undefined }))
  replyPages.prune()
  replyPages.set(key, page)
  return page
}

/**
 * A flat thread's first `pages` reply pages, re-nested. A focused reply
 * deep in a long thread may sit past the loaded pages, so its subtree is
 * also fetched level by level, and replies under a proved-deleted parent
 * (v10) keep their place under a stub (`usePostDetail` `loadPost`).
 */
async function loadFlatReplies(focus: Post, pages: number): Promise<{ replies: FlatReply[]; hasMore: boolean }> {
  const rootId = threadRootIdOf(focus)
  const isReply = targetKindOf(focus) === 'reply'
  const byId = new Map<string, Reply>()
  let next: string | undefined
  for (let index = 0; index < pages; index++) {
    // Only a continuation reuses the pages it already read.
    const page = await replyPage(rootId, next, pages === 1)
    for (const reply of page.documents) byId.set(reply.id, reply)
    next = page.nextCursor
    if (!next) break
  }
  let replies = Array.from(byId.values())

  if (isReply && (next || pages > 1)) {
    let frontier = [focus.id]
    for (let depth = 0; depth < RENDERED_DEPTH && frontier.length > 0; depth++) {
      const children = await replyService.getNestedReplies(frontier, { rootPostId: rootId, skipEnrichment: true })
      const known = new Set(replies.map(reply => reply.id))
      replies = [...replies, ...Array.from(children.values()).flat().filter(reply => !known.has(reply.id))]
      const parents = new Set(frontier)
      frontier = replies.filter(reply => reply.replyToReplyId && parents.has(reply.replyToReplyId)).map(reply => reply.id)
    }
  }

  if (authorDeletesLeaveHoles()) {
    const candidates = unloadedReplyParents(replies)
    const deleted = candidates.length > 0 ? await provenAbsent('reply', candidates) : new Set<string>()
    replies = [...deletedReplyStubs(replies, deleted), ...replies]
  }
  const threads = assembleFlatThread({ id: focus.id, authorId: focus.author.id, isReply }, replies)
  return { replies: flattenThreads(threads), hasMore: next !== undefined }
}

async function loadV2Replies(focus: Post): Promise<FlatReply[]> {
  // v2's getReplies covers one level and web reads only its first page.
  const { documents } = await replyService.getReplies(focus.id, { skipEnrichment: true })
  const threads = await assembleV2Thread({ id: focus.id, authorId: focus.author.id }, documents,
    parentIds => replyService.getNestedReplies(parentIds, { skipEnrichment: true }))
  return flattenThreads(threads)
}

const asQuotes = (posts: Post[]): EngagementEntry[] =>
  posts.map(post => ({ ownerId: post.author.id, quote: { id: post.id, content: post.content } }))

/** v10: no repost doctype; the quote list holds the bare reposts and the quotes with text. */
async function quoteSplit(target: TargetQuery, fresh: boolean): Promise<QuoteSplit> {
  const key = `${target.kind}:${target.id}`
  const cached = fresh ? undefined : quoteSplits.get(key)
  if (cached) return cached
  const list = await postService.getQuotePosts(target.id, target.kind, { limit: QUOTE_LIST_LIMIT })
  const { reposts, quotes } = splitRepostsAndQuotes(list)
  const split = { reposts: asQuotes(reposts), quotes: asQuotes(quotes), truncated: list.length >= QUOTE_LIST_LIMIT }
  quoteSplits.prune()
  quoteSplits.set(key, split)
  return split
}

/** The users behind an engagement list, as the engagements page reads them (whole). */
async function loadEngagementList(target: TargetQuery, tab: EngagementTab): Promise<EngagementEntry[]> {
  if (tab === 'likes') {
    return (await likeService.getPostLikes(target.id, target.kind)).map(like => ({ ownerId: like.$ownerId }))
  }
  if (repostsAreQuotes()) return (await quoteSplit(target, true))[tab]
  if (tab === 'quotes') return asQuotes(await postService.getQuotePosts(target.id, target.kind))
  if (!canRepost(target.kind)) throw notSupported(`Reposts of a ${target.kind}`)
  return (await repostService.getPostReposts(target.id)).map(repost => ({ ownerId: repost.$ownerId }))
}

function toPollDTO(poll: Poll, tally: PollTally | null, myVotes?: number[] | null): PollDTO {
  return {
    id: poll.id,
    ownerId: poll.ownerId,
    question: poll.question,
    options: poll.options.map((text, index) => ({ text, votes: tally?.counts[index] ?? 0 })),
    multiChoice: poll.multiChoice,
    endsAt: poll.endsAt === undefined ? null : new Date(poll.endsAt),
    createdAt: poll.createdAt,
    totalVotes: tally ? tally.total : null,
    tallyIncludesLate: tally?.lateIncluded === true,
    ...(myVotes !== undefined ? { myVotes } : {}),
  }
}

export const posts = {
  /**
   * One post or reply with its author, stats and quoted post. A v10 bare
   * repost resolves to its target, as web's post page redirects to it.
   * `null` only when proved reads find nothing under the id; a read that
   * fails rejects (`NETWORK`, `TIMEOUT` or `RATE_LIMITED`).
   */
  async get(id: string): Promise<PostDTO | null> {
    const post = await loadFocus(id)
    if (!post) return null
    const [dto] = await enrichToDTOs([withLoadingAuthor(post)])
    return dto ?? null
  },

  /**
   * A post's page (`hooks/use-post-detail.ts`): the focus, the posts above
   * it, and its replies flattened to one indent level with the author's own
   * thread first. Flat threads (v9/v10) page their replies; pass the
   * returned cursor for more, and render the latest page (replies are
   * cumulative). v2 reads one level of replies plus the author's
   * continuation, as web does. `focus: null` only when the post is proved
   * missing; a failed read of the focus or of a thread root rejects, as
   * `get` does (a root reported in `removedAncestorIds` was proved absent).
   */
  // TODO(post-1.0): each continuation redoes the whole thread so far (enrichment, the
  // focused reply's subtree walk, provenAbsent) and resends it; cache those per root
  // alongside replyPages if long threads get slow.
  async thread(id: string, cursor?: string | null): Promise<ThreadDTO> {
    const pages = 1 + (cursorInt(decodeCursor<{ pages: number }>(cursor, `thread:${id}`)?.pages ?? 0))
    const focus = await loadFocus(id)
    if (!focus) return { focus: null, ancestors: [], removedAncestorIds: [], replies: emptyPage() }

    const isReply = targetKindOf(focus) === 'reply'
    const [{ chain, removed }, { replies, hasMore }] = await Promise.all([
      isReply ? loadAncestors(focus) : { chain: [], removed: [] },
      hasFlatThreads() ? loadFlatReplies(focus, pages) : loadV2Replies(focus).then(replies => ({ replies, hasMore: false })),
    ])

    // One enrichment batch for the page; deleted-reply stubs are not documents and skip it.
    const live = replies.filter(entry => !entry.reply.deletedStub)
    const enriched = await postService.enrichPostsBatch(
      [focus, ...chain, ...live.map(entry => replyToPost(entry.reply))].map(withLoadingAuthor))
    // Stub authors have id '', which the avatar read skips; the stub's author is blanked below.
    const stubs = replies.filter(entry => entry.reply.deletedStub).map(entry => ({ ...replyToPost(entry.reply), deleted: true }))
    const dtos = new Map((await toPostDTOs([...enriched, ...stubs])).map(dto => [dto.id, dto]))

    const items = replies.flatMap(({ reply, depth, isAuthorThread, hiddenReplyCount }): ThreadReplyDTO[] => {
      const dto = dtos.get(reply.id)
      if (!dto) return []
      return [reply.deletedStub
        ? { ...dto, author: STUB_AUTHOR, depth, isAuthorThread, hiddenReplyCount, deletedStub: true }
        : { ...dto, depth, isAuthorThread, hiddenReplyCount }]
    })
    return {
      focus: dtos.get(focus.id) ?? null,
      ancestors: chain.flatMap(post => dtos.get(post.id) ?? []),
      removedAncestorIds: removed,
      replies: nextPage(items, `thread:${id}`, hasMore ? { pages } : null),
    }
  },

  /**
   * Who liked, reposted or quoted a post or reply (`app/post/engagements/page.tsx`):
   * the whole list once, then 30 users a page with names, profiles and,
   * signed in, follow status. v10 splits its quote list into bare reposts
   * and quotes; reposts reject with `NOT_SUPPORTED` where the kind cannot be
   * reposted. `truncated`: v10's quote list filled its 100-document read, so
   * the list (and its count) stops there.
   */
  async engagements(target: TargetQuery, tab: EngagementTab, cursor?: string | null): Promise<EngagementPage> {
    const page = await pageOfList({
      kind: 'engagements',
      key: `${tab}:${target.kind}:${target.id}`,
      cursor,
      size: ENGAGEMENT_PAGE,
      cache: engagementLists,
      load: () => loadEngagementList(target, tab),
      hydrate: async (slice) => {
        const users = await loadUserSummaries(slice.map(entry => entry.ownerId))
        return slice.flatMap((entry): EngagementDTO[] => {
          const user = users.get(entry.ownerId)
          return user ? [{ user, ...(entry.quote ? { quote: entry.quote } : {}) }] : []
        })
      },
    })
    const truncated = tab !== 'likes' && repostsAreQuotes() && quoteSplits.get(`${target.kind}:${target.id}`)?.truncated === true
    return { ...page, truncated }
  },

  /**
   * Like, repost and quote counts (`loadEngagementCounts`). On v10 the count
   * trees cannot tell a bare repost from a quote, so, as web's engagements
   * page does, the quote list is read and split; `truncated` marks counts
   * that are floors ("100+").
   */
  async engagementCounts(target: TargetQuery): Promise<EngagementCountsDTO> {
    const counts = await loadEngagementCounts(target.id, target.kind)
    if (!repostsAreQuotes() || counts.quotes === 0) return { ...counts, truncated: false }
    const split = await quoteSplit(target, false)
    return { likes: counts.likes, reposts: split.reposts.length, quotes: split.quotes.length, truncated: split.truncated }
  },

  /**
   * A Pollr poll (`PostDTO.poll.id`), read-only, as
   * `components/poll/poll-card.tsx` loads it: the poll, its tally and, signed
   * in, the viewer's choices. Each part degrades alone, as on web: an
   * unreadable tally is `totalVotes: null` (never zeros), unreadable choices
   * `myVotes: null` (the ballot stays closed). `null` for a poll proved
   * missing or an embed on another contract; an unreadable poll rejects.
   */
  async poll(embed: { contractId?: string; id: string }): Promise<PollDTO | null> {
    if (embed.contractId && embed.contractId !== POLLR_CONTRACT_ID) return null
    const readPoll = () => pollrPollService.getPoll(embed.id)
    const poll = (await readPoll()) ?? await provedMissing(embed.id, [POLLR_DOCUMENT_TYPES.POLL], readPoll, POLLR_CONTRACT_ID)
    if (!poll) return null
    const viewer = viewerId()
    const [tally, myVotes] = await Promise.allSettled([
      pollrVoteService.getTally(poll),
      viewer ? pollrVoteService.getMyVotes(poll, viewer) : Promise.resolve(undefined),
    ])
    return toPollDTO(poll,
      tally.status === 'fulfilled' ? tally.value : null,
      myVotes.status === 'fulfilled' ? myVotes.value : null)
  },

  /**
   * Compose's @-mention suggestions: DPNS names starting with `prefix` (at
   * least 3 characters, as web), one per identity, at most 5.
   */
  async mentionCandidates(prefix: string): Promise<UserSummaryDTO[]> {
    const query = prefix.trim().replace(/^@/, '')
    if (query.length < MENTION_MIN_LENGTH) return []
    return searchUserSummaries(query, MENTION_LIMIT)
  },
}

/** `content.created`: a post or reply this engine published, for feeds to insert at once (`use-feed-data.ts`). */
export interface ContentCreatedEvent {
  kind: 'post' | 'reply'
  id: string
  /** False when the network had not confirmed it yet (the DAPI wait timed out). */
  confirmed: boolean
  post: PostDTO
}

let contentSink: ((event: ContentCreatedEvent) => void) | null = null

/** A `post-created` / `reply-created` event's document as lib's `Post`. */
function createdPost(kind: 'post' | 'reply', detail: Record<string, unknown>): Post | null {
  const document = detail[kind]
  if (!document || typeof document !== 'object') return null
  return kind === 'reply' ? replyToPost(document as Reply) : document as Post
}
let forwarding = false

/**
 * Forward the window `post-created` / `reply-created` events `publishThread`
 * dispatches for a thread's first part as `content.created`, with the
 * document as a `PostDTO`: enriched where the reads answer, else as created.
 * One listener per bundle; the latest engine API receives them.
 */
function forwardCreatedContent(emit: (event: ContentCreatedEvent) => void): void {
  contentSink = emit
  if (forwarding || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  forwarding = true
  for (const kind of ['post', 'reply'] as const) {
    window.addEventListener(`${kind}-created`, (event) => {
      const detail = ((event as CustomEvent).detail ?? {}) as Record<string, unknown>
      const post = createdPost(kind, detail)
      if (!post) return
      const confirmed = detail.confirmed !== false
      enrichToDTOs([withLoadingAuthor(post)])
        .catch((): PostDTO[] => [])
        .then(([dto]) => contentSink?.({ kind, id: post.id, confirmed, post: dto ?? toPostDTO(post, { signedIn: true, avatars: new Map() }) }))
        .catch(() => {
          // A DTO that would not map: feeds pick the post up on their next read.
        })
    })
  }
}

/**
 * `posts.publish` and `posts.delete` (ENGINE.md §6.3), on the ticket store.
 * `emit` receives `content.created`.
 */
export function createPostWrites(tickets: TicketStore, emit: (event: 'content.created', payload: ContentCreatedEvent) => void) {
  forwardCreatedContent(payload => emit('content.created', payload))
  const tombstoned = relationProbe<{ target: TargetRef }>(async ({ ticket }) => {
    const post = await load(ticketTarget(ticket).id)
    // lib's single reads answer a failure as "absent", and a tombstone is never absent.
    if (!post) throw new Error('The post could not be read')
    return post.deleted !== true
  }, false)
  tickets.register<DraftDTO>('post.publish', createPublishHandler(load))
  tickets.register<{ target: TargetRef }>('post.delete', {
    persistArgs: true,
    async run({ target }, ctx) {
      const viewer = signer(ctx)
      const { id, kind } = target
      // A tombstone where posts are permanent (v9, v11), a delete elsewhere (`deleteOwnPost`).
      return fromBoolean(kind === 'reply' ? await replyService.deleteOwnReply(id, viewer) : await postService.deleteOwnPost(id, viewer))
    },
    // A real delete names the document, proved absent; a tombstone (v9, v11) stays, blanked.
    probe: (ticket, args, kit) => deletesAreTombstones()
      ? tombstoned(ticket, args, kit)
      : kit.proveDocuments(ticket.documents),
  })

  return {
    /**
     * Publish a post, a reply, a quote or a thread of up to 10 parts
     * (`DraftDTO`), as web's composer does through `publishThread`. The
     * ticket's `progress` counts parts, and its `documents` name each posted
     * part by `part` index. After a partial failure, `writes.retry` resumes
     * where a retry is allowed; otherwise publish again with
     * `resume.postedIds` from those documents.
     */
    async publish(draft: DraftDTO): Promise<WriteTicket> {
      validateDraft(draft)
      requireViewer('Posting')
      return tickets.submit<DraftDTO>({ op: 'post.publish', args: draft, target: draft.replyTo ?? draft.quote ?? null })
    },

    /**
     * Delete the viewer's own post or reply (`post-card.tsx` `handleDelete`):
     * a real delete, or a tombstone where the topology keeps them
     * (`capabilities.deletesAreTombstones`).
     */
    async delete(target: TargetRef): Promise<WriteTicket> {
      assertTarget(target)
      if (requireViewer('Deleting') !== target.ownerId) throw badRequest('Only your own posts can be deleted')
      const tombstone = deletesAreTombstones()
      return tickets.submit({
        op: 'post.delete',
        args: { target },
        target,
        documents: tombstone ? [] : [socialDoc(target.kind, target.id, 'delete')],
      })
    },
  }
}
