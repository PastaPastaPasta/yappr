/**
 * Everything that differs between the social contract interaction topologies,
 * in one frozen descriptor.
 *
 * `v2` is the testnet contract (staging, production, /testing). `v9` is the
 * beta.4-beta.6 devnet contract (`contracts/yappr-social-contract-v9.json`,
 * docs/SOCIAL_V9.md), which replaces every polymorphic identifier field with a
 * mono-typed, `refersTo`-checked one. `v10` is the 4.2.0-beta.7 devnet contract
 * (`contracts/yappr-social-contract-v10.json`, docs/SOCIAL_V10.md): v9's
 * interaction surfaces with real deletes instead of tombstones, no `beat`
 * companion, moderator-resolved reports and the DashPay profile extension. That splits what used to be a single
 * query surface in two: a like of a post lands in `like`, a like of a reply in
 * `likeReply`; a reply names its thread root and its presentational parent
 * separately; reposts and bookmarks stop accepting reply ids at all. Which
 * surface a lookup uses therefore depends on whether the thing being looked at
 * is a `post` document or a `reply` document — its {@link TargetKind}.
 *
 * On **v2 both kinds resolve to identical surfaces**, which is what lets the
 * kind-aware plumbing issue byte-identical queries to the pre-topology code:
 * {@link groupByInteractionSurface} collapses to a single group, so a mixed
 * feed page still costs exactly one grouped count query per stat.
 *
 * The descriptor is resolved from `NEXT_PUBLIC_CONTRACT_TOPOLOGY` once, on
 * first use, and deep-frozen: nothing may mutate the shape of the contract the
 * app believes it is talking to part-way through a session.
 */

import { DASHPAY_CONTRACT_ID, getContractTopology, type ContractTopology } from './constants'
import socialContractV9 from '@/contracts/yappr-social-contract-v9.json'
import socialContractV10 from '@/contracts/yappr-social-contract-v10.json'
import socialContractV11 from '@/contracts/yappr-social-contract-v11.json'
import socialContractV12 from '@/contracts/yappr-social-contract-v12.json'

/**
 * Whether a Post-shaped object is backed by a `post` document or a `reply`
 * document. The app renders both through `PostCard`, so the distinction is not
 * visible in the UI types — but it decides which doctypes an interaction reads
 * and writes.
 */
export type TargetKind = 'post' | 'reply'

/** A Post-shaped object reduced to what topology dispatch needs. */
export interface KindedTarget {
  id: string
  kind: TargetKind
  /**
   * A reply's thread root, when known. On v10 a reply's child count lives
   * under `repliesOf [rootPostId, replyToReplyId, ...]`, so it can only be
   * read with the root pinned ({@link replyCountNeedsRoot}).
   */
  rootPostId?: string
}

/**
 * A unique index of the form "(this owner, that target)" — what the
 * "did I like / repost / bookmark this?" lookups read.
 */
export interface OwnedTargetIndex {
  /** Document type holding these documents. */
  docType: string
  /** The identifier property naming the target. */
  field: string
  /**
   * True when the contract declares the index as `[$ownerId, field]`, false when
   * it is `[field, $ownerId]`. Dash Platform requires the query's where/orderBy
   * order to match the index declaration, so this is not cosmetic.
   */
  ownerFirst: boolean
  /**
   * The property denormalizing the *target's* owner (for notification queries),
   * or null when the doctype carries none.
   */
  ownerField: string | null
  /**
   * True when `$ownerId` is the non-unique TERMINAL of an indexOnly `[field]`
   * index (v10's `like.byPost` / `likeReply.byReply`) rather than a property of
   * a unique (owner, target) index. Two things follow, both proven live on
   * bonsia: the liked state of a batch is ONE `[field in [...], $ownerId ==]`
   * read ordered `[field asc, $ownerId asc]` (an `in` on an indexOnly terminal
   * needs that orderBy), and a lookup bound to page ids is not value-bounded,
   * so a composite slot must carry a `limit`. Absent everywhere else.
   */
  ownerIsTerminal?: boolean
}

/**
 * The extra content properties an indexOnly like doctype carries, all consensus-
 * checked against the referenced target via `propertyAgreement` (40127): the
 * like MUST repeat the target's values exactly, so the client sources them from
 * the target document rather than computing anything.
 */
export interface IndexOnlyLikeShape {
  /** Property naming the target's author — agreement-bound to `<target>.$ownerId`. */
  authorField: string
  /**
   * Property carrying the post's hashtag (agreement-bound to `post.hashtag`),
   * or null on a doctype without one (`likeReply`). The property is optional
   * and an untagged like OMITS it — absence-aware propertyAgreement treats
   * both-absent as agreement, and sending `''` against an absent
   * `post.hashtag` would be a 40127 mismatch.
   */
  hashtagField: string | null
  /**
   * The index pinned on {@link authorField} whose projection carries the
   * consensus `$createdAt` (the delete tuple's timestamp and the like
   * notification's time): v9 `byAuthorTimePost [postAuthor, $createdAt, postId]`
   * / `byAuthorTimeReply`, v10 `byAuthorPostTime [postAuthor, postId,
   * $createdAt]` / `byAuthorReplyTime`. Null on v11, where no index keeps a
   * like's time (see {@link deleteNamesCreatedAt}).
   */
  authorTimeIndex: string | null
  /**
   * True when that index keys the target BEFORE `$createdAt` (v10): every read
   * of it pins the target too (`author == A && target == T`, or `target in
   * [...]`, ordered `[author, target, $createdAt desc]`), so "likes of
   * anything of mine since T" needs the targets first
   * ({@link likeNotificationsPinTarget}).
   */
  authorTimeKeysTarget: boolean
  /**
   * True when an unlike's delete-by-values must carry the like's consensus
   * `$createdAt` (v9, v10), recovered off {@link authorTimeIndex}. False on
   * v11: every like index involving `$createdAt` is a trend window marked
   * `outlivesDelete`, so the row stops committing to the time (the SDK drops
   * a `$createdAt` passed on such a type; the client passes none). The unlike
   * names only the like's content properties, and its trend-window entries stay counted until their
   * window expires (up to 72 h for posts, 24 h for tags).
   */
  deleteNamesCreatedAt: boolean
  /**
   * True when the author index (`like.byAuthorPost [postAuthor, postId]`,
   * `likeReply.byAuthorReply [replyAuthor, replyId]`) keeps one counter per
   * target instead of an entry per like (v12: `summableOffCountIndex` on
   * `byPost` / `byReply`, platform#5250). Counts, sums and rankings read the
   * same through it, but it returns no like documents: who liked a target is
   * only ever read through the target index (`byPost` / `byReply`).
   */
  authorIndexIsCounter: boolean
}

/** The doctypes and fields one target kind's engagements live in. */
export interface InteractionSurface {
  /** Likes of this kind. */
  like: OwnedTargetIndex
  /**
   * Set when this kind's like doctype is `indexOnly` (v9): creates must carry
   * the agreement-bound denormalizations, unlike is a delete-by-values needing
   * the full tuple (including the consensus `$createdAt`), and nothing may key
   * state off a like document's `$id` (create-time and query-synthesized ids
   * differ). Null on v2, where likes are ordinary stored documents.
   */
  indexOnlyLike: IndexOnlyLikeShape | null
  /**
   * `repost` documents of this kind, or null when there are none: v9 forbids
   * reposting a reply, and v10 has no repost doctype (a repost is a quote).
   */
  repost: OwnedTargetIndex | null
  /** Bookmarks of this kind, or null when the topology forbids bookmarking it. */
  bookmark: OwnedTargetIndex | null
  /**
   * The `post` property that names a quote of this kind, or null when the kind
   * cannot be quoted. Doubles as the countable-index group field for its
   * quote count.
   */
  quoteField: string | null
  /**
   * The `reply` property whose count tree answers "how many replies does this
   * have?" for this kind. On v2 both kinds group on the polymorphic `parentId`.
   * On v9 a post's reply count is its whole thread (`rootPostId`) while a
   * reply's is its direct children (`replyToReplyId`).
   */
  replyCountField: string
}

/** How a reply document names the thing(s) it hangs off. */
export interface ReplyLinkage {
  /**
   * The field a whole-thread fetch and the thread-size count tree key on. On v2
   * this is the polymorphic `parentId` (the *direct* parent, so a thread must be
   * walked); on v9 it is `rootPostId`, which every reply in a thread shares.
   */
  root: string
  /**
   * The presentational-nesting field, or null on v2 where `parentId` serves
   * double duty as both root link and nesting link.
   */
  replyToReply: string | null
  /**
   * True when every reply index starts at the root (v10's single
   * `repliesOf [rootPostId, replyToReplyId, $createdAt]`): a reply's children
   * are only reachable, listed or counted, with `rootPostId ==` pinned, and a
   * whole-thread listing comes back grouped by parent rather than by time.
   * False on v9 (`rootAndTime` and `replyToReplyAndTime` are separate indexes)
   * and v2.
   */
  nestedUnderRoot: boolean
}

/**
 * The properties a tombstone REPLACE has to carry over from the stored
 * document, split by how `tombstoneDocument` has to re-encode them.
 *
 * On v9 it is exactly the doctype's `immutable` list minus `deleted` (which
 * the tombstone sets itself, under `immutableAllowSetting`): consensus rejects
 * a replace that changes, adds OR DROPS a frozen property with 40128, so an
 * incomplete preserve set is a hard rejection rather than a silent data loss.
 * `lib/contract-topology.test.ts` pins these lists against the contract JSON.
 */
export interface TombstonePreservation {
  /** Identifier-typed properties; re-encoded to raw bytes for the write path. */
  readonly identifiers: readonly string[]
  /** Scalar properties, carried over as-is. */
  readonly scalars: readonly string[]
}

export interface ContractTopologyDescriptor {
  readonly topology: ContractTopology
  /** Reply parent linkage field names. */
  readonly replyLinkage: Readonly<ReplyLinkage>
  /** Engagement surfaces per target kind. */
  readonly interactions: Readonly<Record<TargetKind, InteractionSurface>>
  /** What a tombstone of each doctype must reproduce verbatim. */
  readonly tombstonePreserves: Readonly<Record<TargetKind, TombstonePreservation>>
}

/** Nothing to carry over: the topology deletes documents instead of blanking them. */
const NOTHING_PRESERVED: TombstonePreservation = { identifiers: [], scalars: [] }

/**
 * A reply's parent linkage, preserved by every reply tombstone.
 * `replyToReplyId` is optional and `tombstoneDocument` skips absent fields, so
 * a direct reply reproduces its absence; losing it would move the tombstone —
 * and every live reply nested under it — to the top of the thread.
 */
const REPLY_LINKAGE_PRESERVED: TombstonePreservation = {
  identifiers: ['rootPostId', 'replyToReplyId', 'parentOwnerId'],
  scalars: [],
}

/**
 * v2's engagement surface, encoded exactly as the chain declares it.
 *
 * The index orders matter and are NOT uniform: `like.postAndOwner` is
 * `[postId, $ownerId]` while `repost.ownerAndPost` and `bookmark.ownerAndPost`
 * are `[$ownerId, postId]`. Every v2 identifier field is polymorphic over
 * post|reply, so a reply resolves to this surface too.
 */
const V2_INTERACTIONS: InteractionSurface = {
  like: { docType: 'like', field: 'postId', ownerFirst: false, ownerField: 'postOwnerId' },
  indexOnlyLike: null,
  repost: { docType: 'repost', field: 'postId', ownerFirst: true, ownerField: 'postOwnerId' },
  bookmark: { docType: 'bookmark', field: 'postId', ownerFirst: true, ownerField: null },
  quoteField: 'quotedPostId',
  replyCountField: 'parentId',
}

/** v2 — testnet (staging, production, /testing). Both kinds share every surface. */
const V2_DESCRIPTOR: ContractTopologyDescriptor = {
  topology: 'v2',
  replyLinkage: { root: 'parentId', replyToReply: null, nestedUnderRoot: false },
  interactions: { post: V2_INTERACTIONS, reply: V2_INTERACTIONS },
  // v2 posts and replies are ordinary deletable documents, so a delete is a
  // delete and no tombstone is ever built ({@link deletesAreTombstones}).
  tombstonePreserves: { post: NOTHING_PRESERVED, reply: NOTHING_PRESERVED },
}

/**
 * v9 — `contracts/yappr-social-contract-v9.json`, the moutai devnet
 * (docs/SOCIAL_V9.md).
 *
 * - **Flat threads.** A reply names its thread root (`rootPostId`) and the
 *   reply it nests under (`replyToReplyId`) separately; a post's reply count
 *   is its whole thread, a reply's its direct children.
 * - **Mono-typed references.** Reply likes live in `likeReply.replyId`;
 *   repost and bookmark keep only their post surfaces (consensus rejects a
 *   reply id outright, so the nulls mirror a chain rule); quotes of replies
 *   use the second `post.quotedReplyId` field.
 * - **indexOnly likes.** `like`/`likeReply` have no stored body: structural
 *   one-like-per-(target, owner) uniqueness, delete-by-values with refund. The
 *   liked-state reads are owner-first — `[$ownerId ==, target ==]` and the
 *   batched `[$ownerId ==, target in [...]]` — lowering onto `byLiker`. The
 *   delete tuple and like notifications come off `byAuthorTimePost
 *   [postAuthor, $createdAt, postId]` / `byAuthorTimeReply`.
 *   `postAuthor`/`replyAuthor` are bound to the target's `$ownerId` by a
 *   system-field `propertyAgreement`, and `like.hashtag` to `post.hashtag`.
 * - **Tombstones.** `post` and `reply` are permanent and declare `immutable`
 *   lists; the preserve sets below are exactly those lists minus `deleted`,
 *   which the tombstone sets itself under `immutableAllowSetting`.
 */
const V9_POST_INTERACTIONS: InteractionSurface = {
  ...V2_INTERACTIONS,
  like: { docType: 'like', field: 'postId', ownerFirst: true, ownerField: 'postAuthor' },
  indexOnlyLike: { authorField: 'postAuthor', hashtagField: 'hashtag', authorTimeIndex: 'byAuthorTimePost', authorTimeKeysTarget: false, deleteNamesCreatedAt: true, authorIndexIsCounter: false },
  replyCountField: 'rootPostId',
}

const V9_REPLY_INTERACTIONS: InteractionSurface = {
  like: { docType: 'likeReply', field: 'replyId', ownerFirst: true, ownerField: 'replyAuthor' },
  indexOnlyLike: { authorField: 'replyAuthor', hashtagField: null, authorTimeIndex: 'byAuthorTimeReply', authorTimeKeysTarget: false, deleteNamesCreatedAt: true, authorIndexIsCounter: false },
  repost: null,
  bookmark: null,
  quoteField: 'quotedReplyId',
  replyCountField: 'replyToReplyId',
}

const V9_DESCRIPTOR: ContractTopologyDescriptor = {
  topology: 'v9',
  replyLinkage: { root: 'rootPostId', replyToReply: 'replyToReplyId', nestedUnderRoot: false },
  tombstonePreserves: {
    post: {
      // post.immutable minus `deleted`: the quote graph and the embed triple
      // join `language`/`hashtag`, because dropping a frozen property is the
      // same 40128 rejection as changing one. A tombstoned quote or poll post
      // keeps pointing at its target; PostCard short-circuits on `deleted`, so
      // none of it renders.
      identifiers: ['quotedPostId', 'quotedReplyId', 'quotedPostOwnerId', 'embedContractId', 'embedId'],
      scalars: ['language', 'hashtag', 'embedDocType'],
    },
    reply: REPLY_LINKAGE_PRESERVED,
  },
  interactions: { post: V9_POST_INTERACTIONS, reply: V9_REPLY_INTERACTIONS },
}

/**
 * v10 — `contracts/yappr-social-contract-v10.json`, the 4.2.0-beta.7 devnet
 * (docs/SOCIAL_V10.md). Likes, bookmarks, quotes and the reply linkage FIELDS
 * are v9's; what differs:
 *
 * - **Reposts are quotes.** There is no `repost` doctype: a repost is a `post`
 *   naming its target in `quotedPostId`/`quotedReplyId` with no content, so
 *   posts AND replies can be reposted, the quote count is the repost count,
 *   and the unique `ownerAndQuotedPost`/`ownerAndQuotedReply` indexes allow
 *   one quote or repost per author and target (a second is 40105). See
 *   {@link repostsAreQuotes} and {@link ownQuoteIndexFor}.
 * - **One reply index.** `repliesOf [rootPostId, replyToReplyId, $createdAt]`
 *   replaces `rootAndTime`/`byRoot`/`replyToReplyAndTime`/`byReplyToReply`:
 *   every reply read pins the root ({@link replyCountNeedsRoot}).
 * - **Merged count indexes.** `X ==`/`X in` counts are served by the
 *   rangeCountable list indexes (`quotesOfPost`, `ownerAndTime`, `followers`,
 *   `following`); the posts-per-author ranking is a ranked query on
 *   `ownerAndTime` ({@link authorPostCountsAreRanked}).
 * - **Real deletes.** `post`/`reply` are immutable and owner-deletable: a
 *   delete removes the document, nothing is preserved, and a reply, quote,
 *   like, bookmark or report aimed at a deleted post is refused 40120.
 * - **No `beat`, rolling windows.** Trending tags read
 *   `like.byTrendHashtagPost` (24h windows every 6h, `skipIfAbsent`) and top
 *   posts `like.byTrendPost` (72h windows every 24h); there is no windowed
 *   creator axis ({@link windowedRankingFor}).
 * - **No `byLiker` (like design C).** The liked state reads the target-first
 *   `byPost [postId]` / `byReply [replyId]` with `$ownerId` as their terminal
 *   ({@link OwnedTargetIndex.ownerIsTerminal}). `byAuthorPostTime [postAuthor,
 *   postId, $createdAt]` replaces both `byAuthorPost` (same ranked chain at
 *   `[postAuthor, postId]`) and `byAuthorTimePost`, and `byAuthorReplyTime
 *   [replyAuthor, replyId, $createdAt]` replaces `byAuthorTimeReply`: the
 *   target sits before the time, so the unlike tuple and like notifications
 *   are read per target ({@link likeNotificationsPinTarget}).
 */
const V10_DESCRIPTOR: ContractTopologyDescriptor = {
  topology: 'v10',
  replyLinkage: { ...V9_DESCRIPTOR.replyLinkage, nestedUnderRoot: true },
  tombstonePreserves: { post: NOTHING_PRESERVED, reply: NOTHING_PRESERVED },
  interactions: {
    post: {
      ...V9_POST_INTERACTIONS,
      like: { docType: 'like', field: 'postId', ownerFirst: false, ownerField: 'postAuthor', ownerIsTerminal: true },
      indexOnlyLike: { authorField: 'postAuthor', hashtagField: 'hashtag', authorTimeIndex: 'byAuthorPostTime', authorTimeKeysTarget: true, deleteNamesCreatedAt: true, authorIndexIsCounter: false },
      repost: null,
    },
    reply: {
      ...V9_REPLY_INTERACTIONS,
      like: { docType: 'likeReply', field: 'replyId', ownerFirst: false, ownerField: 'replyAuthor', ownerIsTerminal: true },
      indexOnlyLike: { authorField: 'replyAuthor', hashtagField: null, authorTimeIndex: 'byAuthorReplyTime', authorTimeKeysTarget: true, deleteNamesCreatedAt: true, authorIndexIsCounter: false },
    },
  },
}

/**
 * v11 — `contracts/yappr-social-contract-v11.json`, the 5.0.0-beta.1 devnet
 * (docs/SOCIAL_V11.md). Every v10 surface, with likes made cheaper by
 * `outlivesDelete` (#5232/#5233):
 *
 * - `like.byAuthorPost [postAuthor, postId]` (ranked at `[postAuthor,
 *   postId]`, the same chain as v10's `byAuthorPostTime`) and
 *   `likeReply.byAuthorReply [replyAuthor, replyId]` drop `$createdAt`, and
 *   the two trend windows outlive deletes. No like index keeps a like's time,
 *   so an unlike names no `$createdAt` ({@link IndexOnlyLikeShape.deleteNamesCreatedAt})
 *   and like notifications are timeless ({@link likeNotificationsAreTimeless}).
 * - Moderation (not in this descriptor): {@link settledDeletionFor} and
 *   {@link removalKeptFieldsFor}.
 * - **Moderated posts and replies (design M).** `post` and `reply` are
 *   `canBeDeleted: false`: only a moderator removes one, leaving a removal
 *   record, and every reference at them is `moderatedDocument`, so it keeps
 *   resolving (to the record) after a removal. An author "deletes" with a
 *   tombstone: a replace setting `deleted` that clears every content field
 *   ({@link deletesAreTombstones}); a tombstone of a quote or bare repost
 *   clears its quote too, which frees the one-quote-per-target slot, so
 *   undoing a repost is a tombstone and redoing it a new post. The like trees
 *   are preallocated by the post's (reply's) creator
 *   ({@link likeTreesArePreallocated}).
 */
const V11_DESCRIPTOR: ContractTopologyDescriptor = {
  ...V10_DESCRIPTOR,
  topology: 'v11',
  // `hashtag` (and a reply's linkage) is frozen; every other content field is
  // cleared by the tombstone (`tombstoneIsBlank`), so nothing else is carried.
  tombstonePreserves: { post: { identifiers: [], scalars: ['hashtag'] }, reply: REPLY_LINKAGE_PRESERVED },
  interactions: {
    post: {
      ...V10_DESCRIPTOR.interactions.post,
      indexOnlyLike: { authorField: 'postAuthor', hashtagField: 'hashtag', authorTimeIndex: null, authorTimeKeysTarget: true, deleteNamesCreatedAt: false, authorIndexIsCounter: false },
    },
    reply: {
      ...V10_DESCRIPTOR.interactions.reply,
      indexOnlyLike: { authorField: 'replyAuthor', hashtagField: null, authorTimeIndex: null, authorTimeKeysTarget: true, deleteNamesCreatedAt: false, authorIndexIsCounter: false },
    },
  },
}

/**
 * v12 — `contracts/yappr-social-contract-v12.json`, the 5.0.0-beta.2 devnet
 * (docs/SOCIAL_V12.md). v11 with two beta.2 keywords:
 *
 * - **Counter author indexes** (`summableOffCountIndex`, platform#5250).
 *   `like.byAuthorPost`, `like.byHashtagPost` and `likeReply.byAuthorReply`
 *   keep one counter per post (reply) of how many entries `byPost` (`byReply`)
 *   holds for it, instead of an entry per like. Counts and rankings read the
 *   same; documents do not exist there any more, so likers are read through
 *   the target index only ({@link IndexOnlyLikeShape.authorIndexIsCounter}).
 * - **`retractedWhen: { present: "deleted" }`** (platform#5253) on post and
 *   reply: a banned or suspended author can still tombstone its own post or
 *   reply ({@link barredAuthorsCanTombstone}), and nothing else.
 */
const V12_DESCRIPTOR: ContractTopologyDescriptor = {
  ...V11_DESCRIPTOR,
  topology: 'v12',
  interactions: {
    post: {
      ...V11_DESCRIPTOR.interactions.post,
      indexOnlyLike: { authorField: 'postAuthor', hashtagField: 'hashtag', authorTimeIndex: null, authorTimeKeysTarget: true, deleteNamesCreatedAt: false, authorIndexIsCounter: true },
    },
    reply: {
      ...V11_DESCRIPTOR.interactions.reply,
      indexOnlyLike: { authorField: 'replyAuthor', hashtagField: null, authorTimeIndex: null, authorTimeKeysTarget: true, deleteNamesCreatedAt: false, authorIndexIsCounter: true },
    },
  },
}

/** Recursively freezes a plain-object descriptor. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

const DESCRIPTORS: Readonly<Record<ContractTopology, ContractTopologyDescriptor>> = {
  v2: V2_DESCRIPTOR,
  v9: V9_DESCRIPTOR,
  v10: V10_DESCRIPTOR,
  v11: V11_DESCRIPTOR,
  v12: V12_DESCRIPTOR,
}

let resolved: ContractTopologyDescriptor | null = null

/** The descriptor for the configured topology, resolved once and frozen. */
export function topologyDescriptor(): ContractTopologyDescriptor {
  if (!resolved) resolved = deepFreeze(DESCRIPTORS[getContractTopology()])
  return resolved
}

/**
 * True on a moderated devnet contract (v9 and v10). Every capability below
 * that exists on both and not on v2 asks this; the helpers keep their own
 * names because each call site is asking about one capability, not about
 * which network it runs on.
 */
function isDevnetCut(): boolean {
  return topologyDescriptor().topology !== 'v2'
}

/**
 * True on the 4.2.0-beta.7 cut (v10) and on its 5.0 successors (v11, v12),
 * which keep every v10 surface: real deletes, no `beat`, no
 * `post.language`, `keyGeneration` for the private feed, media hashes,
 * moderator-resolved reports, the DashPay-based profile and a paused,
 * unpriced YAPP. What v11 changes on top asks {@link isV11}.
 */
export function isV10(): boolean {
  const { topology } = topologyDescriptor()
  return topology === 'v10' || topology === 'v11' || topology === 'v12'
}

/**
 * True on the 5.0.0-beta.1 cut (v11) and on its 5.0.0-beta.2 successor (v12),
 * which keeps every v11 rule: v10 plus timeless likes (`outlivesDelete`),
 * removal records that keep fields, and settled posts and replies only the
 * seated team deletes together. What v12 changes on top asks
 * {@link IndexOnlyLikeShape.authorIndexIsCounter} and
 * {@link barredAuthorsCanTombstone}.
 */
export function isV11(): boolean {
  const { topology } = topologyDescriptor()
  return topology === 'v11' || topology === 'v12'
}

/**
 * True when a banned or suspended author may still tombstone its own post or
 * reply (v12: `retractedWhen: { present: "deleted" }`, platform#5253). On v11
 * Drive refuses a barred identity every replace, so a barred author cannot
 * take its own post down at all (41107/41108).
 */
export function barredAuthorsCanTombstone(): boolean {
  return topologyDescriptor().topology === 'v12'
}

/** How reply documents name their parents on this topology. */
export function replyLinkage(): Readonly<ReplyLinkage> {
  return topologyDescriptor().replyLinkage
}

/** The engagement doctypes and fields for a target kind. */
function interactionsFor(kind: TargetKind): InteractionSurface {
  return topologyDescriptor().interactions[kind]
}

/** Where this kind's likes live. Every kind is likeable on both topologies. */
export function likeIndexFor(kind: TargetKind): OwnedTargetIndex {
  return interactionsFor(kind).like
}

/**
 * Where this kind's `repost` DOCUMENTS live, or null when there are none: a
 * v9 reply, and every kind on v10, where a repost is a quote post
 * ({@link repostsAreQuotes}). Null does not mean "cannot be reposted"; ask
 * {@link canRepost} for that.
 */
export function repostIndexFor(kind: TargetKind): OwnedTargetIndex | null {
  return interactionsFor(kind).repost
}

/**
 * True when a repost is a `post` quoting its target with no content (v10):
 * no `repost` doctype, the quote count IS the repost count, un-reposting
 * deletes that post, and reposts arrive in feeds through ordinary post
 * queries instead of a separate repost merge.
 */
export function repostsAreQuotes(): boolean {
  return isV10()
}

/**
 * The unique "(this author, that target)" quote index for a kind (v10:
 * `post.ownerAndQuotedPost [$ownerId, quotedPostId]` and
 * `post.ownerAndQuotedReply [$ownerId, quotedReplyId]`, both `skipIfAbsent`),
 * which answers "has the viewer already quoted or reposted this?". Null where
 * quotes are not unique per author (v2's `quotedPostAndOwner` is target-first
 * and v9 has none), or the kind cannot be quoted.
 */
export function ownQuoteIndexFor(kind: TargetKind): (OwnedTargetIndex & { index: string }) | null {
  const field = quoteFieldFor(kind)
  if (!repostsAreQuotes() || !field) return null
  return {
    docType: 'post',
    index: field === 'quotedReplyId' ? 'ownerAndQuotedReply' : 'ownerAndQuotedPost',
    field,
    ownerFirst: true,
    ownerField: 'quotedPostOwnerId',
  }
}

/** Where this kind's bookmarks live, or null when the kind cannot be bookmarked. */
export function bookmarkIndexFor(kind: TargetKind): OwnedTargetIndex | null {
  return interactionsFor(kind).bookmark
}

/** The `post` property naming a quote of this kind, or null when unquotable. */
export function quoteFieldFor(kind: TargetKind): string | null {
  return interactionsFor(kind).quoteField
}

/**
 * The second property of the index a quote LISTING query must order by.
 *
 * v2's only quote index is the unique `quotedPostAndOwner [quotedPostId,
 * $ownerId]`. v9 has chronological `quotesOfPost`/`quotesOfReply
 * [<field>, $createdAt]` indexes instead, because uniqueness was dropped (quotes
 * are content, not toggles) and a newest-first listing is what the UI wants.
 */
export function quoteListingOrderProperty(): '$ownerId' | '$createdAt' {
  return isDevnetCut() ? '$createdAt' : '$ownerId'
}

/** The `reply` property whose count tree holds this kind's reply count. */
export function replyCountFieldFor(kind: TargetKind): string {
  return interactionsFor(kind).replyCountField
}

/**
 * True when counting this kind's replies needs the thread root pinned as well
 * (v10 replies): `repliesOf` starts at `rootPostId`, so a reply's children
 * are `rootPostId == R && replyToReplyId == P` (batched: `replyToReplyId in`
 * grouped by `replyToReplyId`, one query per root). A post's count is its
 * whole thread, `rootPostId ==`, on every topology.
 */
export function replyCountNeedsRoot(kind: TargetKind): boolean {
  return kind === 'reply' && replyLinkage().nestedUnderRoot
}

/**
 * True when "posts per author" is a proved ranked query (v10: `ranked` on
 * `post` grouped by `$ownerId`, served by `ownerAndTime`'s
 * `rankedCountable {at: $ownerId}`). Elsewhere it is a range-distinct count
 * over an index ending in `$ownerId` (v9's `byOwner`), with a scan fallback.
 */
export function authorPostCountsAreRanked(): boolean {
  return isV10()
}

/**
 * True when replies name their thread root directly (v9's `rootPostId`) rather
 * than chaining through a polymorphic direct parent — i.e. when a whole thread
 * is one query and nesting is a client-side grouping.
 */
export function hasFlatThreads(): boolean {
  return replyLinkage().replyToReply !== null
}

/**
 * True when each quote field names exactly one document type, so a quote target
 * can be resolved from the field it is stored in instead of being probed against
 * one doctype after another. Also implies cross-contract quotes (blog posts) must
 * use the embed triple, since the in-contract fields are `refersTo`-checked.
 */
export function quoteFieldsAreSplit(): boolean {
  return quoteFieldFor('post') !== quoteFieldFor('reply')
}

/**
 * True when likes of posts and likes of replies live in DIFFERENT doctypes, so a
 * caller wanting both has to read two owner indexes and merge. Deliberately
 * narrower than {@link interactionSurfacesAreIdentical}: that folds in repost,
 * bookmark and quote too, and a topology that split only one of those would make
 * a like reader double-count.
 */
export function likeSurfacesAreSplit(): boolean {
  return likeIndexFor('post').docType !== likeIndexFor('reply').docType
}

/**
 * True when consensus checks that every identifier field points at a document
 * that actually exists (`refersTo`). Where it does, a write naming a parent that
 * has not landed yet is rejected — and charged for — so dependent writes have to
 * wait for an unconfirmed parent instead of racing it.
 */
export function referencesAreEnforced(): boolean {
  return isDevnetCut()
}

/**
 * True when post and reply documents are permanent (`canBeDeleted: false`) and a
 * "delete" is therefore an edit that blanks the content and sets `deleted: true`
 * rather than a document removal (v9, v11). On v10 a delete removes the document.
 */
export function deletesAreTombstones(): boolean {
  const { topology } = topologyDescriptor()
  return topology === 'v9' || topology === 'v11' || topology === 'v12'
}

/**
 * True when a tombstone keeps an EMPTY `content` (v9: `content: ''`, and
 * `tombstoneIsBlank` reads its length); false when it leaves every content
 * field out (v11: `tombstoneIsBlank` requires them absent, and a quote's
 * `quotedPostId`/`quotedReplyId`/`quotedPostOwnerId` go too).
 */
export function tombstoneKeepsEmptyContent(): boolean {
  return topologyDescriptor().topology === 'v9'
}

/**
 * True when a reply can outlive its parent (v10, v11): consensus lets a
 * parent go while the replies naming it stay, so a reader proves the hole and
 * stubs it instead of dropping the replies under it. On v10 the hole is an
 * author's delete or a moderator removal; on v11 only a moderator removal
 * (authors tombstone). False on v2 and v9, which prove no reply-parent holes.
 * {@link authorDeletesLeaveHoles} says who made a hole, for wording.
 */
export function repliesOutliveTheirParent(): boolean {
  return isV10()
}

/**
 * True when an author's tombstone is hidden wherever posts are listed and,
 * where something must hold its place (a thread parent with live replies, a
 * quote's target, a direct link), shows as a "deleted by its author" stub
 * with nothing to interact with (v11). On v9 a tombstone stays in place as a
 * deleted card. Consensus still accepts likes, replies, quotes and bookmarks
 * of a tombstone on both, so this is the client's call.
 */
export function tombstonesAreHidden(): boolean {
  return isV11()
}

/**
 * True when the like trees of a post or reply are built when it is created,
 * paid by its creator (`preallocated` on like.byPost/byAuthorPost/
 * byHashtagPost and likeReply.byReply/byAuthorReply, v11). Every like then
 * costs the same, and a post with no likes still sits in its trees with a
 * count of zero: ranked reads and grouped counts can return ZERO-count
 * groups, which a leaderboard must drop.
 */
export function likeTreesArePreallocated(): boolean {
  return isV11()
}

/**
 * True when an author's delete removes a post or reply that other documents
 * may still name (v10: real deletes, `deletableDocument` references). A reply
 * then outlives its deleted parent and a quote its deleted target, and a
 * proven absence with no moderator removal record is the author's delete.
 * Readers render a deleted stub in the hole instead of dropping the reply's
 * context or the subtree under it. False on v2 (nothing a post points at can
 * disappear) and v9 (an author's delete is a tombstone that keeps its place).
 */
export function authorDeletesLeaveHoles(): boolean {
  return referencesMayDangle() && !deletesAreTombstones()
}

/**
 * The properties a tombstone of this kind must reproduce verbatim.
 *
 * On v9 these are exactly the doctype's consensus-`immutable` properties
 * minus `deleted` (which the tombstone sets itself). Under-listing one is a
 * hard 40128 rejection rather than a silent field loss, so the list is pinned
 * against the contract JSON in `lib/contract-topology.test.ts`.
 */
export function tombstonePreservationFor(kind: TargetKind): TombstonePreservation {
  return topologyDescriptor().tombstonePreserves[kind]
}

/**
 * The indexOnly shape of this kind's like doctype, or null when likes are
 * ordinary stored documents (v2). Non-null means: creates must carry the
 * agreement-bound fields, unlikes are deletes-by-values, confirmation resolves
 * as AffectedState rather than ExecutionProved, and like `$id`s must never be
 * used as keys or compared across sources.
 */
export function indexOnlyLikeShapeFor(kind: TargetKind): IndexOnlyLikeShape | null {
  return interactionsFor(kind).indexOnlyLike
}

/** True when the configured topology's like doctypes are indexOnly (v9). */
export function likesAreIndexOnly(): boolean {
  return indexOnlyLikeShapeFor('post') !== null
}

/**
 * True when "likes of my content since T" cannot be read off one author-pinned
 * index (v10, like design C): the author-time index keys the target before
 * `$createdAt`, so like notifications go through the recipient's recent posts
 * and replies (their like counts, then one `target in [liked]` read per kind)
 * instead of a `[author ==, $createdAt >]` source in the permanent
 * notification bundle.
 */
export function likeNotificationsPinTarget(): boolean {
  return indexOnlyLikeShapeFor('post')?.authorTimeKeysTarget === true
}

/**
 * True when no like index keeps the time of a like (v11): like notifications
 * are found by diffing a recent target's likers (`byPost`/`byReply`) against
 * what this device saw last, and are dated when the app first noticed them.
 * A new device starts from a baseline (no backlog), and an unlike is a
 * delete-by-values without `$createdAt`.
 */
export function likeNotificationsAreTimeless(): boolean {
  const shape = indexOnlyLikeShapeFor('post')
  return shape !== null && !shape.deleteNamesCreatedAt
}

/**
 * True when a post carries its (single) hashtag inline in `post.hashtag` and
 * the `postHashtag` doctype does not exist (v9). Tag listings then query
 * `post.tagAndTime` directly, the compose flow writes no secondary hashtag
 * documents, and there is nothing to "recover" when one is missing.
 *
 * The inline `hashtag` is OPTIONAL: an untagged post omits it, and a like
 * must mirror the post's absence — absence-aware propertyAgreement treats
 * both-absent as agreement, while writing `''` against an absent
 * `post.hashtag` is a 40127 mismatch. `like.byHashtagPost` is `skipIfAbsent`,
 * so untagged likes write no per-tag index entries at all.
 *
 * In memory `Post.hashtag === ''` still means "known untagged" (and
 * `undefined` means "unknown — fetch the post"), so caches, `LikeTargetInfo`
 * and the tuple plumbing round-trip absence without a third state. The
 * `''` ↔ absent translation happens exactly once, at the chain boundary (post
 * create, like create, unlike delete-by-values, post transform).
 */
export function hashtagsAreInline(): boolean {
  return isDevnetCut()
}

/**
 * The longest hashtag the v9 `post.hashtag`/`like.hashtag` pattern accepts:
 * an at-level ranked string key must fit the 247-byte encoded ceiling, which
 * 63 (v2's `postHashtag` limit) does not.
 */
export const HASHTAG_MAX_LENGTH = 61

/**
 * True when the like doctype's at-form `rankedCountable` chains can answer
 * proved PREFIX-level ranked groupBy queries (v9): trending hashtags off
 * `byHashtagPost {at: hashtag}` and the creator leaderboard off
 * `byAuthorPost {at: [postAuthor, postId]}` (v10: `byAuthorPostTime`, the
 * same chain at `[postAuthor, postId]`).
 */
export function prefixRankingsAvailable(): boolean {
  return isDevnetCut()
}

/**
 * True when follows carry a ranked chain at `followingId` (v9's
 * `followerCount [followingId]`, v10's `followers [followingId, $createdAt]`
 * ranked at `followingId`), making "most followed" a proved ranked groupBy on
 * `followingId`. The O(1) follower COUNT exists on every topology and is not
 * gated here.
 */
export function followRankingsAvailable(): boolean {
  return isDevnetCut()
}

/** The ranked surfaces that can be read over a recent window. */
export type RankingAxis = 'posts' | 'hashtags' | 'creators'

/** How one axis's recent window is read: the index's doctype and grid, and which window. */
export interface WindowedRanking {
  /** The indexOnly doctype carrying the windowed index. */
  readonly docType: 'like' | 'beat'
  /** The index (documentation and tests; the query names the grid, not the index). */
  readonly index: string
  /** The window grid in seconds, as the contract declares it; `documents.ranked()` names it. */
  readonly grid: { readonly range: number; readonly step: number }
  /**
   * `newest` is the window that started last (up to one `step` of history);
   * `oldest` is the oldest window still open, which covers nearly a full
   * `range`. A daily grid has one window, so v9 reads `newest`; v10's rolling
   * grids read `oldest` so the answer always spans ~18-24h / ~48-72h.
   */
  readonly selector: 'newest' | 'oldest'
  /** What the window toggle calls it. */
  readonly label: string
}

type LikeIndexJson = { name: string; timeRange?: { range: number; step: number } }

/** A windowed index of `docType` in `contract`, read off the committed JSON so the grid cannot drift. */
function windowOf(contract: SocialContractJson, docType: 'like' | 'beat', index: string, selector: WindowedRanking['selector'], label: string): WindowedRanking {
  const schemas = contract.documentSchemas as unknown as Record<string, { indices?: LikeIndexJson[] }>
  const timeRange = schemas[docType]?.indices?.find((entry) => entry.name === index)?.timeRange
  if (!timeRange) throw new Error(`${docType}.${index} declares no timeRange`)
  return { docType, index, grid: { range: timeRange.range, step: timeRange.step }, selector, label }
}

let windowedRankings: Readonly<Record<RankingAxis, WindowedRanking | null>> | null = null

/**
 * The recent window of a ranked axis on the configured contract, or null when
 * the axis is all-time only (every axis on v2; creators on v10).
 *
 * - **v9** (daily grid, `newest` = today, UTC): top posts `like.byDayPost`,
 *   trending tags and per-tag top `beat.byDayHashtagPost`, top creators and a
 *   profile's top `like.byDayAuthorPost`.
 * - **v10** (rolling, `oldest` = the full window): top posts
 *   `like.byTrendPost` (72h, a new window every 24h: "3 days"), trending tags
 *   and per-tag top `like.byTrendHashtagPost` (24h, every 6h: "24h"). No
 *   creator window: the creator leaderboard and a profile's top stay all-time.
 */
export function windowedRankingFor(axis: RankingAxis): WindowedRanking | null {
  if (!windowedRankingsAvailable()) return null
  if (!windowedRankings) {
    windowedRankings = deepFreeze(isV10()
      ? {
        posts: windowOf(devnetContract(), 'like', 'byTrendPost', 'oldest', '3 days'),
        hashtags: windowOf(devnetContract(), 'like', 'byTrendHashtagPost', 'oldest', '24h'),
        creators: null,
      }
      : {
        posts: windowOf(socialContractV9, 'like', 'byDayPost', 'newest', 'Today'),
        hashtags: windowOf(socialContractV9, 'beat', 'byDayHashtagPost', 'newest', 'Today'),
        creators: windowOf(socialContractV9, 'like', 'byDayAuthorPost', 'newest', 'Today'),
      })
  }
  return windowedRankings[axis]
}

/**
 * True when the like axes have windowed ranked twins (v9, v10): see
 * {@link windowedRankingFor} for which axis reads which index. A
 * `timeRange: [{ field: '$createdAt', selector, grid }]` entry on
 * `documents.ranked()` pins the window; the node resolves it from block time.
 */
export function windowedRankingsAvailable(): boolean {
  return isDevnetCut()
}

/**
 * True when a post or reply names at most one mentioned identity inline, in
 * its own `mentionedUserId` (optional, `refersTo` identity), and the
 * `postMention` doctype does not exist (v10). The compose flow indexes only
 * the first @mention of the public content, like the single inline hashtag;
 * the rest stay plain text. Mentions are read off the permanent
 * `post.mentionedUserAndTime` / `reply.mentionedUserAndTime [mentionedUserId,
 * $createdAt]` (shaped like `tagAndTime`), so the Mentions tab keeps its full
 * history.
 */
export function mentionsAreInline(): boolean {
  return isV10()
}

/**
 * The doctypes mentions are read from, each pinned on `mentionedUserId` and
 * walked by `$createdAt`: the mentioning `post` and `reply` themselves on
 * v10, a `postMention` document elsewhere. Same field, same index order on
 * all of them.
 */
export function mentionDocTypes(): readonly ('post' | 'reply' | 'postMention')[] {
  return mentionsAreInline() ? ['post', 'reply'] : ['postMention']
}

/**
 * The notification sources that v10 keeps on windows: replies and
 * quotes/reposts (stored doctypes). Mentions (post and reply) stay permanent
 * (the Mentions tab keeps its history), and likes are not windowed: the node
 * refuses a windowed document read of an indexOnly type, so like
 * notifications are read over the recent targets off the permanent `byAuthorPostTime`/`byAuthorReplyTime`
 * ({@link likeNotificationsPinTarget}).
 */
export type WindowedNotificationSource = 'reply' | 'quote'

/** How one windowed notification source is read (v10). */
export interface NotificationWindow {
  readonly docType: string
  /** The index (documentation and tests; the query names the grid, not the index). */
  readonly index: string
  /** The recipient property the read pins with `==`: the index's second property. */
  readonly recipientField: string
  /**
   * The window grid in seconds, as the contract declares it: non-overlapping
   * (`step == range`) with `ttl` twice the range, so the current window
   * (`newest`) and the one before it (named `byStart`) hold the last week.
   * The node's `oldest` is the oldest window still containing now, which on
   * this grid is the current one again (see lib/services/notification-windows).
   */
  readonly grid: { readonly range: number; readonly step: number }
}

type IndexJson = { name: string; properties: Array<Record<string, string>>; timeRange?: { range: number; step: number } }

/** A windowed notification index read off the committed JSON, so grid and fields cannot drift. */
function notificationWindowOf(docType: string, index: string): NotificationWindow {
  const schemas = devnetContract().documentSchemas as unknown as Record<string, { indices?: IndexJson[] }>
  const declared = schemas[docType]?.indices?.find((entry) => entry.name === index)
  const recipientField = declared?.properties[1] ? Object.keys(declared.properties[1])[0] : undefined
  if (!declared?.timeRange || !recipientField) throw new Error(`${docType}.${index} is not a windowed notification index`)
  return {
    docType,
    index,
    recipientField,
    grid: { range: declared.timeRange.range, step: declared.timeRange.step },
  }
}

let notificationWindows: Readonly<Record<WindowedNotificationSource, NotificationWindow>> | null = null

/**
 * The rolling windows a notification source is read from (v10), or null
 * where the source is a permanent `[recipient, $createdAt]` index read with
 * `$createdAt >` (v2, v9). Follows, follow requests and likes stay on
 * permanent indexes on every topology (v10 likes per target, see
 * {@link likeNotificationsPinTarget}).
 *
 * A source is read as `where [[recipientField, '==', me]]` plus
 * `timeRange: [{ field: '$createdAt', selector, grid }]` twice: `newest` (the
 * current 3.5-day window) and `byStart` of the previous one, with no `$createdAt`
 * clause and no orderBy: entries come back in index order, not time order, so
 * the dedupe, the since-filter and the newest-first sort are client-side.
 * `timeRange` is refused in composite queries, so each read is its own query.
 */
export function notificationWindowFor(source: WindowedNotificationSource): NotificationWindow | null {
  if (!isV10()) return null
  notificationWindows ??= deepFreeze({
    reply: notificationWindowOf('reply', 'parentOwnerRecent'),
    quote: notificationWindowOf('post', 'quotedPostOwnerRecent'),
  })
  return notificationWindows[source]
}

/** True when the reply and quote/repost notification sources are rolling windows (v10). */
export function notificationsAreWindowed(): boolean {
  return notificationWindowFor('reply') !== null
}

/**
 * The `beat` companion a like must carry on v9: the tagged-only indexOnly
 * doctype whose `byDayHashtagPost` serves the windowed hashtag rankings.
 * `null` when no companion is written — v2, v10 (the like carries the rolling
 * hashtag window itself, `skipIfAbsent`), reply likes (no
 * hashtag axis), and likes of UNTAGGED posts (`beat.hashtag` is required, so
 * an untagged like writes no beat, which is the skipIfAbsent economy by other
 * means). Consensus checks `beat.hashtag` against the post through the same
 * propertyAgreement `like.hashtag` uses.
 */
export function beatCompanionFor(kind: TargetKind, hashtag: string | null | undefined): { docType: 'beat' } | null {
  if (topologyDescriptor().topology !== 'v9' || kind !== 'post') return null
  if (!hashtag) return null
  return { docType: 'beat' }
}

/**
 * True when a post carries a `language` and the feed reads a per-language
 * timeline (`languageTimeline [language, $createdAt]`, v2 and v9). v10 has
 * neither: one global `timeline [$createdAt]`, queried
 * `$createdAt > 0` ordered `desc`.
 */
export function postsHaveLanguage(): boolean {
  return !isV10()
}

/**
 * The limits `post.content` and `reply.content` declare: `maxLength` counts
 * code points, `maxBytes` (v10 only) UTF-8 bytes; a write over either is
 * refused (JSON schema 10101, 10421 for bytes). `encryptedMaxBytes` is the
 * `encryptedContent` ceiling a private post's ciphertext must fit.
 */
export interface ContentLimits {
  readonly maxLength: number
  readonly maxBytes: number | null
  readonly encryptedMaxBytes: number
}

export function contentLimits(): ContentLimits {
  // v2 declares the same 500 / 1024 as v9, which devnetContract() reads for it.
  const post = devnetSchemas().post.properties ?? {}
  return {
    maxLength: post.content?.maxLength ?? 0,
    maxBytes: post.content?.maxBytes ?? null,
    encryptedMaxBytes: post.encryptedContent?.maxItems ?? 0,
  }
}

/**
 * True when a post or reply naming `mediaUrl` must also carry `mediaHash` (the
 * 32-byte sha256 of the exact uploaded bytes) and `mediaFingerprint` (the
 * 8-byte dHash), and neither may appear without the URL (v10,
 * `dependentRequired`: 10101 otherwise).
 */
export function mediaCarriesHashes(): boolean {
  return isV10()
}

/**
 * The property of `post`/`reply`/`privateFeedGrant`/`privateFeedRekey` holding
 * the private-feed key generation, and of `privateFeedState` holding the
 * latest one. v10 renamed them from `epoch`/`maxEpoch`; the HKDF labels
 * (`epoch-chain`) and the ciphertext layout are unchanged.
 */
export function privateFeedKeyFields(): { readonly generation: 'epoch' | 'keyGeneration'; readonly latest: 'maxEpoch' | 'maxKeyGeneration' } {
  return isV10() ? { generation: 'keyGeneration', latest: 'maxKeyGeneration' } : { generation: 'epoch', latest: 'maxEpoch' }
}

/** The DashPay contract, whose `profile` is v10's base profile (a system contract on every network). */
export const DASHPAY_PROFILE = { contractId: DASHPAY_CONTRACT_ID, documentType: 'profile' } as const

/**
 * Where a user's profile lives (v10): the DashPay `profile` holds the display
 * name (≤25), the public message (≤140, the bio) and a hashed avatar URL; the
 * social `yapprProfile` extension holds everything Yappr adds. The extension
 * requires a DashPay profile owned by its writer (`ownerRefersTo`, 40120), so
 * the DashPay profile is written first. Null on v2 and v9, which use the
 * profile contract (`NEXT_PUBLIC_PROFILE_TOPOLOGY`).
 */
export function dashpayProfileExtension(): { readonly base: typeof DASHPAY_PROFILE; readonly extensionDocType: 'yapprProfile' } | null {
  return isV10() ? { base: DASHPAY_PROFILE, extensionDocType: 'yapprProfile' } : null
}

/**
 * True when this kind can be reposted: through a `repost` document on v2 (both
 * kinds) and v9 (posts only), through a content-less quote post on v10 (posts
 * via `quotedPostId`, replies via `quotedReplyId`).
 */
export function canRepost(kind: TargetKind): boolean {
  return repostsAreQuotes() ? quoteFieldFor(kind) !== null : repostIndexFor(kind) !== null
}

export function canBookmark(kind: TargetKind): boolean {
  return bookmarkIndexFor(kind) !== null
}

/** The fields `targetKindOf` needs off a Post-shaped object. */
interface KindBearing {
  targetKind?: TargetKind
  /** Only reply-backed Post shapes carry a parent id. */
  parentId?: string
}

/** A Post/Reply-shaped object reduced to what thread-root resolution needs. */
export interface ThreadBearing extends KindBearing {
  id: string
  /** Set on v9 reply shapes: the post every reply in the thread hangs off. */
  rootPostId?: string
}

/**
 * The id of the post at the root of this object's thread.
 *
 * A top-level post is its own root. A reply names its root directly on v9; on v2
 * the best available answer is its direct parent, which is what the pre-topology
 * code used everywhere a "root" was wanted, so v2 behaviour is unchanged.
 */
export function threadRootIdOf(target: ThreadBearing): string {
  if (targetKindOf(target) !== 'reply') return target.id
  return target.rootPostId ?? target.parentId ?? target.id
}

/**
 * Where a reply to `target` hangs: its thread root, and the reply it nests under
 * (absent when the target IS the root).
 *
 * This pairing is not optional. On v2 `threadRootIdOf` can only answer with the
 * target's OWN parent — there is no root link — which is the wrong document to
 * name; what saves it is that `replyToReplyId` is then set to the target and wins
 * when `createReply` collapses the two back into v2's single `parentId`. Deriving
 * the two together, here, is what keeps that invariant from living as a
 * convention repeated at every call site.
 */
export function replyLinkageTo(target: ThreadBearing): { rootPostId: string; replyToReplyId?: string } {
  const rootPostId = threadRootIdOf(target)
  return {
    rootPostId,
    replyToReplyId: target.id === rootPostId ? undefined : target.id,
  }
}

/**
 * The kind of a Post-shaped object.
 *
 * Every Reply→Post adapter sets `targetKind` explicitly, and that is the answer
 * when present. Untagged objects fall back to the pre-topology probe — a
 * `parentId` is only ever set on a reply — so a Post shape built somewhere this
 * refactor did not reach still resolves correctly instead of silently being
 * treated as a top-level post (which on v9 would send its like to `like` instead
 * of `likeReply`, and its delete to the post doctype). Literals that can only
 * describe a real `post` document (optimistic composes, mock data, blog-quote
 * adapters) have neither field and resolve to `post`.
 */
export function targetKindOf(target: KindBearing): TargetKind {
  return target.targetKind ?? (target.parentId ? 'reply' : 'post')
}

/**
 * A Post-shaped object reduced to `{ id, kind }` for topology dispatch, plus
 * a reply's thread root when it carries one (what v10's per-reply counts pin).
 */
export function targetOf(post: KindBearing & { id: string; rootPostId?: string }): KindedTarget {
  const kind = targetKindOf(post)
  return kind === 'reply' && post.rootPostId ? { id: post.id, kind, rootPostId: post.rootPostId } : { id: post.id, kind }
}

/** Stable identity of a kind's engagement surface, for cache/dedupe keys. */
function surfaceKey(kind: TargetKind): string {
  const { like, repost, bookmark, quoteField, replyCountField } = interactionsFor(kind)
  return [like.docType, repost?.docType ?? '-', bookmark?.docType ?? '-', quoteField ?? '-', replyCountField].join('|')
}

/**
 * True when both target kinds read and write exactly the same doctypes — the v2
 * case, where the split does not exist yet.
 */
function interactionSurfacesAreIdentical(): boolean {
  return surfaceKey('post') === surfaceKey('reply')
}

/** A batch of targets that share one engagement surface. */
export interface SurfaceGroup {
  /** A kind whose surface applies to every id in the group. */
  kind: TargetKind
  ids: string[]
  /** Namespace for dedupe/cache keys — identifies the doctypes queried. */
  key: string
}

/**
 * Splits targets into batches that each share one engagement surface.
 *
 * When the topology makes both kinds identical (v2) this returns a SINGLE group
 * holding every id, so the caller issues exactly the queries it issued before
 * kinds existed. On v9 it returns up to one group per kind, preserving input
 * order within each.
 */
export function groupByInteractionSurface(targets: readonly KindedTarget[]): SurfaceGroup[] {
  if (targets.length === 0) return []

  if (interactionSurfacesAreIdentical()) {
    return [{ kind: 'post', ids: targets.map((target) => target.id), key: surfaceKey('post') }]
  }

  const byKind = new Map<TargetKind, string[]>()
  for (const target of targets) {
    const ids = byKind.get(target.kind)
    if (ids) ids.push(target.id)
    else byKind.set(target.kind, [target.id])
  }
  return Array.from(byKind, ([kind, ids]) => ({ kind, ids, key: surfaceKey(kind) }))
}

// ---------------------------------------------------------------------------
// Moderation, token costs, action fees and the starter grant, read off the
// committed contract JSON of the configured devnet cut (v9 or v10; v2 reads
// v9's token amounts, which match its own) so that the numbers the client
// shows and agrees to are the numbers consensus enforces.
// `lib/contract-topology.test.ts` pins them.

/** The six document actions a contract may price. */
export type DocumentAction = 'create' | 'replace' | 'delete' | 'transfer' | 'update_price' | 'purchase'

/**
 * Who the contract owner offers to have pay the gas of a TOKEN-PAID action, as
 * the contract declares it: 0 = the document owner (the default: no
 * sponsorship), 1 = the contract owner always, 2 = the contract owner when
 * their balance covers it. Only a create that carries `$tokenPaymentInfo` can
 * be sponsored; one paid in credits never is.
 */
export type GasFeesPaidBy = 0 | 1 | 2

/** What a document type's `tokenCost.create` declares. */
export interface TokenCostDeclaration {
  /** Tokens charged, at token position 0 (YAPP). */
  readonly amount: number
  /**
   * True when a create may leave `$tokenPaymentInfo` out and pay credits
   * instead (no fallback the other way: payment info present + insufficient
   * tokens is a 40700 rejection).
   */
  readonly optional: boolean
  /** The gas offer the payment info may ask for. */
  readonly gasFeesPaidBy: GasFeesPaidBy
}

/** What a document type's `actionFees` declares for one action. */
export interface ActionFeeDeclaration {
  /** Credits into the owner pot, before the multiplier. */
  readonly owner: bigint
  /** Credits into the moderators pot, before the multiplier. */
  readonly moderators: bigint
  /**
   * `feeMultiplier`: scaled by the epoch's fee multiplier, and the agreement
   * must name the multiplier the signer knew plus a tolerance. `fixed`:
   * charged as written, and the agreement must NOT name a multiplier.
   */
  readonly pricing: 'feeMultiplier' | 'fixed'
}

/** `moderatorAbilities` (4.2.0-beta.7, v10): what the moderators may do to a type's documents. */
export interface ModeratorAbilities {
  readonly delete?: boolean
  readonly deleteWithin?: number
  /** Default true: a moderator's deletion leaves a removal record and can be restored. */
  readonly deleteKeepsRecord?: boolean
  readonly deleteRefundsOwner?: boolean
  /** Top-level properties only the moderators write (`moderatorChangeDocumentFields`). */
  readonly changeFields?: readonly string[]
  /** 5.0 (v11): the fields a removal record keeps (`keptFields`), e.g. a post's hashtag and `$createdAt`. */
  readonly deleteKeepsFields?: readonly string[]
  /**
   * 5.0 (v11): who of the seated team must approve deleting a document past
   * {@link deleteWithin}: `approvals` members, the leader among them when
   * `leader`. Absent: nobody deletes a settled document.
   */
  readonly deleteSettled?: { readonly leader?: boolean; readonly approvals?: number }
}

interface SocialDocumentSchema {
  /** v9 (beta.4-beta.6 grammar); v10 declares {@link ModeratorAbilities} instead. */
  canBeDeletedByModerators?: boolean
  moderatorAbilities?: ModeratorAbilities
  required?: string[]
  ownerRefersTo?: unknown
  properties?: Record<string, {
    refersTo?: { type?: string }
    distinctFrom?: string
    items?: { distinctFrom?: string }
    maxLength?: number
    maxBytes?: number
    maxItems?: number
  }>
  tokenCost?: { create?: { amount: number; optional?: boolean; gasFeesPaidBy?: number } }
  actionFees?: { pricing?: string } & Partial<Record<DocumentAction, { owner?: number; moderators?: number }>>
}

type SocialContractJson = typeof socialContractV9 | typeof socialContractV10 | typeof socialContractV11 | typeof socialContractV12

/** The committed JSON of the configured devnet cut; v2 reads v9's (see above). */
function devnetContract(): SocialContractJson {
  if (topologyDescriptor().topology === 'v12') return socialContractV12
  if (isV11()) return socialContractV11
  return isV10() ? socialContractV10 : socialContractV9
}

function devnetSchemas(): Record<string, SocialDocumentSchema> {
  return devnetContract().documentSchemas as unknown as Record<string, SocialDocumentSchema>
}

function starterGrant(): { amount: number } | undefined {
  return (devnetContract().tokens['0'].distributionRules as { oncePerIdentityDistribution?: { amount: number } })
    .oncePerIdentityDistribution
}

/** True when moderators may delete documents of `schema`, in either grammar. */
function moderatorsMayDelete(schema: SocialDocumentSchema | undefined): boolean {
  return schema?.canBeDeletedByModerators === true || schema?.moderatorAbilities?.delete === true
}

/**
 * True when the configured contract declares `moderation` (v9): identities can
 * be banned or suspended from it, posts and replies can be removed by its
 * moderators, and `moderationStatus`/`documentRemovals` are answerable.
 */
export function contractIsModerated(): boolean {
  return isDevnetCut()
}

/**
 * True when a referenced post or reply may no longer exist (v9): every
 * reference at `post`/`reply` is a `deletableDocument` reference, so a
 * quoted post, a thread root or a liked post can be ABSENT after a moderator
 * takedown. Readers match joins by id, never by position, and render the hole
 * as a removed-post stub instead of failing the page.
 */
export function referencesMayDangle(): boolean {
  return isDevnetCut()
}

/**
 * The identifier properties of `docType` a tombstone may DROP when their
 * target has been removed by a moderator (v9 only: `post.quotedPostId`,
 * `post.quotedReplyId`, `reply.replyToReplyId`): the optional
 * `deletableDocument` references. A replace re-validates every such
 * reference, so keeping a dead one is 40120, and clearing it is the one change
 * to an `immutable` property consensus lets through. A REQUIRED deletable
 * reference (`reply.rootPostId`) is not listed: it cannot be cleared, so a
 * reply under a removed root cannot be tombstoned at all. Empty on v2, where
 * nothing a post points at can disappear.
 */
export function clearableReferencesFor(docType: string): readonly string[] {
  if (!deletesAreTombstones()) return []
  const schema = devnetSchemas()[docType]
  if (!schema?.properties) return []
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties)
    .filter(([name, property]) => property.refersTo?.type === 'deletableDocument' && !required.has(name))
    .map(([name]) => name)
}

/** The moderation lists a contract can keep (`config.moderation`, protocol 14). */
export type ModerationList = 'banlist' | 'suspensions' | 'warnings'

/**
 * The lists the configured contract keeps, as its `config.moderation`
 * declares them (v9: banlist, suspensions and warnings). Reading or writing a
 * list the contract does not keep is refused, so every moderation read and
 * write names only these. Empty off a moderated topology.
 */
export function moderationListsKept(): readonly ModerationList[] {
  if (!contractIsModerated()) return []
  const declared = devnetContract().config as { moderation?: Partial<Record<ModerationList, boolean>> }
  const moderation = declared.moderation
  if (!moderation) return []
  return (['banlist', 'suspensions', 'warnings'] as const).filter((list) => moderation[list] === true)
}

/** True when the configured contract keeps a warning list (warn / clear warnings). */
export function contractKeepsWarnings(): boolean {
  return moderationListsKept().includes('warnings')
}

/** The document types the contract's moderators may delete (v9: post, reply, report; v10 adds yapprProfile). */
export function moderatorDeletableTypes(): readonly string[] {
  if (!contractIsModerated()) return []
  return Object.entries(devnetSchemas())
    .filter(([, schema]) => moderatorsMayDelete(schema))
    .map(([name]) => name)
}

/**
 * What the moderators may do to documents of `docType`, as the configured
 * contract declares it, or null off a moderated topology or on a type they
 * cannot touch. v9 declares only a delete that keeps a removal record.
 */
export function moderatorAbilitiesFor(docType: string): ModeratorAbilities | null {
  if (!contractIsModerated()) return null
  const schema = devnetSchemas()[docType]
  if (schema?.moderatorAbilities) return schema.moderatorAbilities
  return schema?.canBeDeletedByModerators === true ? { delete: true } : null
}

/**
 * True when a moderator's deletion of `docType` leaves a removal record (and
 * can be restored within a week). False on v10's `report`, which the
 * moderators purge without a record: `documentRemovals` refuses such a type,
 * and `moderatorDeleteDocument` resolves to nothing for it.
 */
export function moderatorDeletionKeepsRecord(docType: string): boolean {
  const abilities = moderatorAbilitiesFor(docType)
  return abilities?.delete === true && abilities.deleteKeepsRecord !== false
}

/**
 * The fields a moderator's removal record of `docType` keeps (v11: a post's
 * `hashtag` and `$createdAt`, a reply's `rootPostId` and `$createdAt`), read
 * from `documentRemovals` entries' `keptFields`. Empty when the type keeps
 * none (v9, v10) or keeps no record. The records are not indexed by them.
 */
export function removalKeptFieldsFor(docType: string): readonly string[] {
  if (!moderatorDeletionKeepsRecord(docType)) return []
  return moderatorAbilitiesFor(docType)?.deleteKeepsFields ?? []
}

/** How a settled document of one type is deleted (v11's `deleteWithin` + `deleteSettled`). */
export interface SettledDeletionRule {
  /** Seconds after the document's last change during which any one moderator deletes it. */
  readonly windowSeconds: number
  /** Whether the team's leader must be among the approvals. */
  readonly leaderRequired: boolean
  /** Approvals the rule asks for, the leader counted (consensus caps it at the team's seats). */
  readonly approvals: number
}

/**
 * The settled-deletion rule of `docType` (v11 post and reply: a week, then
 * the leader plus two members), or null when moderators may delete it at any
 * age (no `deleteWithin`) or nobody may delete it once settled (no
 * `deleteSettled`). Past the window a single moderator's delete is refused
 * (41116); the team proposes (`moderatorDeleteSettledDocument`, the proposal
 * is the proposer's approval) and approves (`moderatorApproveTeamAction`)
 * until `min(approvals, team seats)` approvals meet the rule. A team
 * deletion can never be restored (41209).
 */
export function settledDeletionFor(docType: string): SettledDeletionRule | null {
  const abilities = moderatorAbilitiesFor(docType)
  if (!abilities?.delete || abilities.deleteWithin === undefined || !abilities.deleteSettled) return null
  return {
    windowSeconds: abilities.deleteWithin,
    leaderRequired: abilities.deleteSettled.leader === true,
    approvals: abilities.deleteSettled.approvals ?? 1,
  }
}

/**
 * The window in seconds after a document's last change in which one
 * moderator may delete it alone, or null when there is no limit (v9, v10).
 */
export function moderatorDeleteWindowSeconds(docType: string): number | null {
  return moderatorAbilitiesFor(docType)?.deleteWithin ?? null
}

/**
 * The YAPP cost a create of `docType` declares on the configured contract, or
 * null when the type is unpriced. On v2 the cost is required and the document
 * owner pays the gas, which is what `optional: false` and `gasFeesPaidBy: 0`
 * say; the amounts are the same on both contracts (pinned by
 * `lib/contract-topology.test.ts`).
 */
export function tokenCostFor(docType: string): TokenCostDeclaration | null {
  const create = devnetSchemas()[docType]?.tokenCost?.create
  if (!create) return null
  if (!isDevnetCut()) return { amount: create.amount, optional: false, gasFeesPaidBy: 0 }
  return {
    amount: create.amount,
    optional: create.optional === true,
    gasFeesPaidBy: (create.gasFeesPaidBy ?? 0) as GasFeesPaidBy,
  }
}

/**
 * The action fee a transition on `docType`/`action` must agree to, or null
 * when the action charges nothing (every action on v2). The write path
 * builds `$actionFeeAgreement` from exactly these numbers: a different owner
 * or moderators amount, or the other pricing, is a 40133 rejection, and no
 * agreement at all is 40132.
 */
export function declaredActionFee(docType: string, action: DocumentAction): ActionFeeDeclaration | null {
  if (!isDevnetCut()) return null
  const fees = devnetSchemas()[docType]?.actionFees
  if (!fees) return null
  const fee = fees[action]
  if (!fee) return null
  return {
    owner: BigInt(fee.owner ?? 0),
    moderators: BigInt(fee.moderators ?? 0),
    pricing: fees.pricing === 'fixed' ? 'fixed' : 'feeMultiplier',
  }
}

/**
 * The YAPP every identity may claim exactly once from the configured contract
 * (v9: 100), or null when the token declares no once-per-identity grant. A
 * second claim is refused with 40722.
 */
export function starterGrantAmount(): bigint | null {
  const grant = starterGrant()
  if (!isDevnetCut() || !grant) return null
  return BigInt(grant.amount)
}

/**
 * True when YAPP can neither be transferred nor bought (v10): the token starts
 * paused and no one can ever unpause it or set a direct-purchase price. Posting
 * and liking still pay YAPP (a token cost is not a transfer), the starter grant
 * still pays out, and the contract owner still mints. Tips must be credit tips.
 */
export function yappIsLocked(): boolean {
  if (!isDevnetCut()) return false
  const token = devnetContract().tokens['0'] as {
    startAsPaused?: boolean
    distributionRules: { changeDirectPurchasePricingRules: { authorizedToMakeChange: { $type: string } } }
  }
  return token.startAsPaused === true
    && token.distributionRules.changeDirectPurchasePricingRules.authorizedToMakeChange.$type === 'noOne'
}

// ---------------------------------------------------------------------------
// Elected moderation, distinctFrom, private-feed gates and typed block
// follows (4.2.0-beta.4), read off the committed contract JSON and pinned by
// `lib/contract-topology.test.ts`.

/** What an elected team may do on one document type (`changeDocumentFields` from v10). */
export type ModerationAbility = 'deleteDocuments' | 'ban' | 'suspend' | 'warn' | 'changeDocumentFields'

/** The contract's elected moderation declaration, fixed at its creation. */
export interface ElectedModerationDeclaration {
  /** Seconds applicants may join once the first charter is filed. */
  readonly joinWindowSeconds: number
  /** Seconds masternodes vote once the join window closed. */
  readonly voteWindowSeconds: number
  /** Whether a seated team can ever be challenged (v9: no). */
  readonly seatContestable: boolean
  /** Seconds after the contract's creation before the first charter; null = at once. */
  readonly electionDelaySeconds: number | null
  /** Members a seated leader may add from the proposal's join requests. */
  readonly maxAddedModerators: number
  /** The abilities the seated team holds, per moderated document type. */
  readonly moderatedDocumentTypes: Readonly<Record<string, readonly ModerationAbility[]>>
  /** Who moderates until a team is seated (v9: the contract owner). */
  readonly interim: 'contractOwner' | 'appointedModerators' | 'notYetUsable' | 'noModeration'
  /** Whether the owner is protected from the seated team. */
  readonly ownerProtected: boolean
}

interface DeclaredElectedModeration {
  moderators: {
    joinWindow: number
    voteWindow: number
    seatContestable: boolean
    electionDelay?: number
    maxAddedModerators?: number
    moderatedDocumentTypes: Record<string, ModerationAbility[]>
    interim: { $type: ElectedModerationDeclaration['interim'] }
    ownerProtected?: boolean
  }
}

/**
 * The elected moderation declaration (v9), or null when the contract's
 * moderators are the owner or an appointed set. Until a charter is seated the
 * contract owner moderates; once one is, only the seated
 * team may moderate (41101 for the owner) and every ban, suspension, warning or
 * deletion must name a `reason` document its proposal lists (41203).
 */
export function electedModeration(): ElectedModerationDeclaration | null {
  if (!isDevnetCut()) return null
  // One frozen object per resolved topology: React effects depend on it, and a
  // fresh object per call would re-run them on every render.
  if (!electedDeclaration) electedDeclaration = deepFreeze(buildElectedDeclaration())
  return electedDeclaration
}

let electedDeclaration: ElectedModerationDeclaration | null = null

function buildElectedDeclaration(): ElectedModerationDeclaration {
  const elected = (devnetContract().config.moderation as DeclaredElectedModeration).moderators
  return {
    joinWindowSeconds: elected.joinWindow,
    voteWindowSeconds: elected.voteWindow,
    seatContestable: elected.seatContestable,
    electionDelaySeconds: elected.electionDelay ?? null,
    maxAddedModerators: elected.maxAddedModerators ?? 0,
    moderatedDocumentTypes: elected.moderatedDocumentTypes,
    interim: elected.interim.$type,
    ownerProtected: elected.ownerProtected === true,
  }
}

/**
 * The identifier properties of `docType` that consensus refuses to equal the
 * writer (`distinctFrom: $ownerId`, 10419): v9's follow/block/followRequest/
 * privateFeedGrant targets and every element of `blockFollow.followedBlockers`.
 * Empty on v2, where only the client stops a self-follow.
 */
export function ownerDistinctProperties(docType: string): readonly string[] {
  if (!isDevnetCut()) return []
  return Object.entries(devnetSchemas()[docType]?.properties ?? {})
    .filter(([, property]) => (property.distinctFrom ?? property.items?.distinctFrom) === '$ownerId')
    .map(([name]) => name)
}

/**
 * True when private-feed writes are gated by consensus (v9): a grant or rekey
 * needs the writer's own `privateFeedState` (40120 on `$ownerId` otherwise),
 * and a grant needs a `followRequest` from its recipient to the writer that
 * exists when the grant is written (40120 on `recipientId`).
 */
export function privateFeedWritesAreGated(): boolean {
  return isDevnetCut() && devnetSchemas().privateFeedGrant?.ownerRefersTo !== undefined
}

/**
 * True when `blockFollow.followedBlockers` is a typed array of identifiers
 * (v9) rather than one byte array of 32-byte ids packed end to end.
 */
export function blockFollowsAreTyped(): boolean {
  return isDevnetCut()
}

/**
 * True when posts and replies can be reported to the moderators (the `report`
 * type): one report per reporter and target, the target's author agreed by
 * consensus (40127) and never the reporter (10419). Its reporter may withdraw
 * it. On v9 the moderators dismiss it by deleting it; on v10 they resolve it
 * ({@link reportsAreResolved}). Off a moderated topology nobody would read a
 * report, so none can be filed.
 */
export function contractTakesReports(): boolean {
  return contractIsModerated() && moderatorsMayDelete(devnetSchemas().report)
}

/**
 * The fields the moderators write on a report (v10): `status` (1 no action,
 * 2 content removed, 3 user actioned) and `resolution` (a note of at most 200
 * characters, never without a status), through
 * `sdk.contracts.moderatorChangeDocumentFields`. The report stays, stamped
 * with `$moderatedBy`/`$moderatedAt`, and still expires with its 90-day ttl.
 * A reporter who sets either is refused 41124. Empty on v9 and v2.
 */
export function reportResolutionFields(): readonly string[] {
  return moderatorAbilitiesFor('report')?.changeFields ?? []
}

/** True when the moderators mark reports handled instead of deleting them (v10). */
export function reportsAreResolved(): boolean {
  return reportResolutionFields().length > 0
}
