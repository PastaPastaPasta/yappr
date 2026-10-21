import { TtlMap } from '@/lib/caches/ttl-map'
import { POLLR_CONTRACT_ID, POLLR_DOCUMENT_TYPES, YAPPR_CONTRACT_ID } from '@/lib/constants'
import {
  canRepost, deletesAreTombstones, hasFlatThreads, referencesMayDangle, repostsAreQuotes, targetKindOf,
  threadRootIdOf, type TargetKind,
} from '@/lib/contract-topology'
import { withMissingReplyParents } from '@/lib/feed/deleted-reply-stubs'
import { provenAbsent } from '@/lib/feed/prove-absent'
import { isBareRepost, quotedTargetIdOf, splitRepostsAndQuotes } from '@/lib/feed/quote-reposts'
import { likeService } from '@/lib/services/like-service'
import { pollrPollService, type Poll } from '@/lib/services/pollr-poll-service'
import { pollIsClosed, pollrVoteService, type PollTally, type SetVoteResult } from '@/lib/services/pollr-vote-service'
import { postService, replyToPost } from '@/lib/services/post-service'
import { replyService } from '@/lib/services/reply-service'
import { base58ToBytes } from '@/lib/services/sdk-helpers'
import { repostService } from '@/lib/services/repost-service'
import { loadEngagementCounts } from '@/lib/services/social-stats-service'
import type { Post, Reply } from '@/lib/types'
import { cursorInt, decodeCursor } from '../dto/cursor'
import {
  enrichToDTOs, loadUserSummaries, notSupported, quoteTargetIds, readFailure, requireViewer, rereadQuotedPosts, searchUserSummaries, toPostDTOs,
  viewerId, withLoadingAuthor,
} from '../dto/hydrate'
import { emptyPage, endOnProofDirectionBug, nextPage, pageOfList } from '../dto/paging'
import { RpcError } from '../protocol/envelope'
import { assembleFlatThread, assembleV2Thread, flattenThreads, RENDERED_DEPTH, type FlatReply } from '../dto/thread'
import { assertId, assertTarget, badRequest, relationProbe, signer, socialDoc, ticketTarget } from '../writes/handler-kit'
import { pollVoting } from '../dto/capabilities'
import { documentExists, fromDeleteBoolean } from '../writes/lib-results'
import { createPublishHandler, validateDraft, type DraftDTO, type FindOwnDocuments, type OwnDocument } from '../writes/publish'
import { classify } from '../writes/classify'
import { NotSentError, type TicketStore, type WriteResult } from '../writes/tickets'
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
export async function readPostOrReply(id: string): Promise<Post | null> {
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
export async function loadPostProved(id: string): Promise<Post | null> {
  return (await readPostOrReply(id)) ?? provedMissing(id, ['post', 'reply'], () => readPostOrReply(id))
}

/** The most documents of each type publish's probe reads (Platform's page). */
const OWN_RECENT_LIMIT = 100

/**
 * The author's newest posts and replies, for publish's "check again"
 * (`ownerAndTime [$ownerId, $createdAt]`, newest first). lib's queries throw
 * on a failed read, so an empty answer is a real one.
 */
const findOwnDocuments: FindOwnDocuments = async (authorId) => {
  const options = { limit: OWN_RECENT_LIMIT }
  const [posts, replies] = await Promise.all([
    postService.getUserPosts(authorId, options),
    replyService.getUserReplies(authorId, { ...options, skipEnrichment: true }),
  ])
  const documents: OwnDocument[] = [
    ...posts.documents.map((doc): OwnDocument => ({
      id: doc.id, type: 'post', content: doc.content, createdAt: doc.createdAt.getTime(), parentId: null,
      quotedId: doc.quotedPostId ?? doc.quotedReplyId ?? null,
    })),
    ...replies.documents.map((doc): OwnDocument => ({
      id: doc.id, type: 'reply', content: doc.content, createdAt: doc.createdAt.getTime(), parentId: doc.parentId ?? null, quotedId: null,
    })),
  ]
  // A capped read holds every document only back to the oldest one it reached.
  const reach = (read: { documents: { createdAt: Date }[] }) =>
    read.documents.length < OWN_RECENT_LIMIT ? 0 : Math.min(...read.documents.map(doc => doc.createdAt.getTime()))
  return { documents, completeSince: Math.max(reach(posts), reach(replies)) }
}

/** `loadPostProved`, following a v10 bare repost to its target, as web's post page redirects to it. */
async function loadFocus(id: string): Promise<Post | null> {
  const post = await loadPostProved(id)
  const target = post && isBareRepost(post) ? quotedTargetIdOf(post) : undefined
  return target && target !== id ? loadPostProved(target) : post
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
    const parent = await readPostOrReply(parentId)
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
 * also fetched level by level, and replies under a missing parent keep
 * their place under its tombstone or a stub (`usePostDetail` `loadPost`).
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

  // A reply whose parent the page lacks keeps its place under the parent's
  // tombstone, read by id where `repliesOf` does not list tombstones, or
  // under a stub for a parent proved gone, as on web.
  replies = await withMissingReplyParents(replies, {
    getMany: ids => replyService.getMany(ids),
    provenAbsent: ids => provenAbsent('reply', ids),
  })
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

interface PollVoteArgs { pollId: string; choices: number[] }

/** A ballot refused before anything was sent: an engine code, so the host shows the sentence. */
const refusedVote = (message: string): WriteResult => ({ state: 'failed', error: new RpcError(message, 'BAD_REQUEST') })
const POLL_GONE = 'This poll is no longer available.'
const POLL_CLOSED = 'This poll has closed.'
const NOT_SAVED = "Your vote wasn't saved. Try again."

const sameChoices = (a: readonly number[], b: readonly number[]) => {
  const key = (choices: readonly number[]) => [...choices].sort((x, y) => x - y).join(',')
  return key(a) === key(b)
}

/**
 * Whether the ballot read back records `wanted`: exactly, where a ballot is
 * replaced (v7/v8); as additions on v3, whose immutable ballots another
 * device may have added to since this one last read them.
 */
const recorded = (ballot: readonly number[], wanted: readonly number[]) =>
  pollVoting() === 'once' ? wanted.every(choice => ballot.includes(choice)) : sameChoices(ballot, wanted)

/** The poll, or null only when Platform says it does not exist; a failed read sent nothing. */
async function readPoll(pollId: string): Promise<Poll | null> {
  try {
    return await pollrPollService.fetchPoll(pollId)
  } catch (error) {
    throw new NotSentError(readFailure(error))
  }
}

/** A v7 ballot `setVote` did not record. `choices` is undefined only when nothing was written. */
function refusedSet(result: SetVoteResult): WriteResult {
  if (result.unconfirmed) return { state: 'unconfirmed' }
  if (result.gone) return refusedVote(POLL_GONE)
  if (result.closed) return refusedVote(POLL_CLOSED)
  if (result.heldBack) return refusedVote('Your last vote is still being confirmed. Try again in a moment.')
  if (result.stale) return refusedVote('Your vote changed on another device. Pull to refresh and try again.')
  // Its ballot read failed: nothing was planned, so nothing was sent.
  if (result.choices === undefined && result.error?.startsWith("Couldn't read your ballot")) {
    throw new NotSentError(readFailure(new Error(result.error)))
  }
  // Refused before writing, or refused and proved unable to land (lib re-read the ballot). Platform's own
  // verdicts the host acts on (too few credits, a revoked key) keep their text, so the classifier names them.
  const error = new Error(result.error ?? NOT_SAVED)
  return ACTIONABLE.has(classify(error, 'poll.vote').code) ? { state: 'failed', error } : refusedVote(NOT_SAVED)
}

/** Refusals with their own guidance in the host (balance, renewing, signing in again). */
const ACTIONABLE: ReadonlySet<string> = new Set(['INSUFFICIENT_CREDITS', 'INSUFFICIENT_YAPP', 'RENEW_REQUIRED', 'KEY_REVOKED', 'NEEDS_WALLET'])

/**
 * Poll ballots (web's `components/poll/poll-card.tsx`). Pollr v7/v8 set the
 * voter's one ballot to exactly `choices` (none withdraws it) until the
 * close; v3 casts one immutable ballot. `pollVoting` says which.
 */
export function createPollWrites(tickets: TicketStore) {
  tickets.register<PollVoteArgs>('poll.vote', {
    persistArgs: true,
    async run({ pollId, choices }, ctx) {
      const ownerId = signer(ctx)
      const poll = await readPoll(pollId)
      if (!poll) return refusedVote(POLL_GONE)
      if (pollIsClosed(poll)) return refusedVote(POLL_CLOSED)
      if (choices.some(choice => choice >= poll.options.length)) return refusedVote('That is not an option of this poll.')
      if (!poll.multiChoice && choices.length > 1) return refusedVote('This poll takes one choice.')
      if (pollVoting() === 'editable') {
        const result = await pollrVoteService.setVote(poll, choices, ownerId)
        return result.success ? { state: 'confirmed' } : refusedSet(result)
      }
      const result = await pollrVoteService.castVote(poll, choices, ownerId)
      // A ballot already cast (on another device): v3 ballots never change.
      const other = result.unresolvedDuplicate || result.alreadyVoted.some(choice => !choices.includes(choice))
      if (other) return refusedVote('You already voted in this poll.')
      // A choice that failed may still have landed; its unique index makes a retry safe.
      if (!result.success) return { state: 'failed', error: new Error(result.error ?? 'Your vote could not be saved') }
      // castVote counts a broadcast whose confirmation wait timed out as cast: only a ballot read
      // back confirms it. Otherwise it stays unconfirmed for the probe (v3 ballots never change).
      const cast = await pollrVoteService.getMyVotes(poll, ownerId).catch(() => null)
      return cast !== null && recorded(cast, choices) ? { state: 'confirmed' } : { state: 'unconfirmed' }
    },
    probe: relationProbe<PollVoteArgs>(async ({ viewer, args }) => {
      if (!args) throw new Error('The ballot is not known')
      const poll = await pollrPollService.fetchPoll(args.pollId)
      if (!poll) throw new Error(POLL_GONE)
      return recorded(await pollrVoteService.getMyVotes(poll, viewer), args.choices)
    }, true),
  })
  return {
    /**
     * Set the viewer's ballot on a poll to `choices` (option indexes). An
     * empty list withdraws it, where ballots are editable (`pollVoting`).
     */
    async vote(pollId: string, choices: number[]): Promise<WriteTicket> {
      requireViewer('Voting')
      assertId(pollId, 'pollId')
      const mode = pollVoting()
      if (!mode) throw notSupported('Voting on polls')
      if (!Array.isArray(choices) || choices.some(choice => !Number.isInteger(choice) || choice < 0) || new Set(choices).size !== choices.length) {
        throw badRequest('choices must be distinct option indexes')
      }
      if (mode === 'once' && choices.length === 0) throw badRequest('Choose an option')
      return tickets.submit<PollVoteArgs>({ op: 'poll.vote', args: { pollId, choices: [...choices] }, target: { pollId } })
    },
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
    const batch = [focus, ...chain, ...live.map(entry => replyToPost(entry.reply))]
    // This page's own quote targets, read again: a quote of a post deleted
    // since the last load must not keep showing the text it had (RC16-I-04).
    rereadQuotedPosts(quoteTargetIds(batch))
    const enriched = await postService.enrichPostsBatch(batch.map(withLoadingAuthor))
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
   * that are floors ("100+"). `fresh` re-reads the list past the split
   * cached for a minute (the caller saw the quote count move).
   */
  async engagementCounts(target: TargetQuery, fresh = false): Promise<EngagementCountsDTO> {
    const counts = await loadEngagementCounts(target.id, target.kind)
    if (!repostsAreQuotes() || counts.quotes === 0) return { ...counts, truncated: false }
    const split = await quoteSplit(target, fresh)
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

/**
 * A `post-created` / `reply-created` event's document as lib's `Post`. One
 * without a valid creation time (lib stamps it, but a write path that did
 * not would be an Invalid Date in the cached feeds) is given this moment.
 */
function createdPost(kind: 'post' | 'reply', detail: Record<string, unknown>): Post | null {
  const document = detail[kind]
  if (!document || typeof document !== 'object') return null
  const post = kind === 'reply' ? replyToPost(document as Reply) : document as Post
  const createdAt: unknown = post.createdAt
  return createdAt instanceof Date && Number.isFinite(createdAt.getTime()) ? post : { ...post, createdAt: new Date() }
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
    const post = await loadPostProved(ticketTarget(ticket).id)
    // lib's single reads answer a failure as "absent", and a tombstone is never absent.
    if (!post) throw new Error('The post could not be read')
    return post.deleted !== true
  }, false)
  tickets.register<DraftDTO>('post.publish', createPublishHandler(loadPostProved, findOwnDocuments))
  tickets.register<{ target: TargetRef }>('post.delete', {
    persistArgs: true,
    async run({ target }, ctx) {
      const viewer = signer(ctx)
      const { id, kind } = target
      try {
        // A tombstone where posts are permanent (v9, v11), a delete elsewhere (`deleteOwnPost`).
        const ok = kind === 'reply' ? await replyService.deleteOwnReply(id, viewer) : await postService.deleteOwnPost(id, viewer)
        return fromDeleteBoolean(ok, ctx.probe)
      } finally {
        // Even unconfirmed: quotes of it read it again rather than show the text it had.
        rereadQuotedPosts([id])
      }
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
