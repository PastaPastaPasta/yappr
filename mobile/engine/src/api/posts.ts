import { TtlMap } from '@/lib/caches/ttl-map'
import { POLLR_CONTRACT_ID } from '@/lib/constants'
import {
  authorDeletesLeaveHoles, canRepost, hasFlatThreads, referencesMayDangle, repostsAreQuotes, targetKindOf, threadRootIdOf,
  type TargetKind,
} from '@/lib/contract-topology'
import { deletedReplyStubs, unloadedReplyParents } from '@/lib/feed/deleted-reply-stubs'
import { provenAbsent } from '@/lib/feed/prove-absent'
import { isBareRepost, quotedTargetIdOf, splitRepostsAndQuotes } from '@/lib/feed/quote-reposts'
import { likeService } from '@/lib/services/like-service'
import { pollrPollService, type Poll } from '@/lib/services/pollr-poll-service'
import { pollrVoteService, type PollTally } from '@/lib/services/pollr-vote-service'
import { postService, replyToPost } from '@/lib/services/post-service'
import { replyService } from '@/lib/services/reply-service'
import { repostService } from '@/lib/services/repost-service'
import { loadEngagementCounts } from '@/lib/services/social-stats-service'
import type { Post, Reply } from '@/lib/types'
import { cursorInt, decodeCursor } from '../dto/cursor'
import {
  enrichToDTOs, loadUserSummaries, notSupported, searchUserSummaries, toPostDTOs, viewerId, withLoadingAuthor,
} from '../dto/hydrate'
import { emptyPage, endOnProofDirectionBug, nextPage, pageOfList } from '../dto/paging'
import { assembleFlatThread, assembleV2Thread, flattenThreads, RENDERED_DEPTH, type FlatReply } from '../dto/thread'
import type {
  AuthorDTO, EngagementCountsDTO, EngagementDTO, EngagementPage, PollDTO, PostDTO, ThreadDTO, ThreadReplyDTO, UserSummaryDTO,
} from './dto'

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

/** A post, or a reply as a Post, the way web's post page looks an id up. */
async function load(id: string): Promise<Post | null> {
  const post = await postService.getPostById(id, { skipEnrichment: true })
  if (post) return post
  // Replies are a separate doctype; web's usePostDetail falls back the same way.
  const reply = await replyService.getReplyById(id, { skipEnrichment: true })
  return reply ? replyToPost(reply) : null
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
    const root = await postService.getPostById(rootId, { skipEnrichment: true })
    if (root) return { chain: [root], removed: [] }
    return { chain: [], removed: referencesMayDangle() ? [rootId] : [] }
  }
  const chain: Post[] = []
  for (let parentId = focus.parentId; parentId && chain.length < MAX_ANCESTORS;) {
    const parent = await load(parentId)
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
   * `null` when nothing exists under the id; lib's single-document reads also
   * report a failed read as absent, so a `null` can mean a transport failure.
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
   * continuation, as web does.
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
   * `myVotes: null` (the ballot stays closed). `null` for a missing poll or
   * an embed on another contract.
   */
  async poll(embed: { contractId?: string; id: string }): Promise<PollDTO | null> {
    if (embed.contractId && embed.contractId !== POLLR_CONTRACT_ID) return null
    const poll = await pollrPollService.getPoll(embed.id)
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
