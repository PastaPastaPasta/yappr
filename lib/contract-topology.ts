/**
 * Everything that differs between the two social contract interaction
 * topologies that exist on chain, in one frozen descriptor.
 *
 * `v2` is the testnet contract (staging, production, /testing). `v9` is the
 * moutai devnet contract (`contracts/yappr-social-contract-v9.json`,
 * docs/SOCIAL_V9.md), which replaces every polymorphic identifier field with a
 * mono-typed, `refersTo`-checked one. That splits what used to be a single
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

import { getContractTopology, type ContractTopology } from './constants'
import socialContractV9 from '@/contracts/yappr-social-contract-v9.json'

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
  /** Reposts of this kind, or null when the topology forbids reposting it. */
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
  replyLinkage: { root: 'parentId', replyToReply: null },
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
 *   batched `[$ownerId ==, target in [...]]` — lowering onto `byLiker`.
 *   `postAuthor`/`replyAuthor` are bound to the target's `$ownerId` by a
 *   system-field `propertyAgreement`, and `like.hashtag` to `post.hashtag`.
 * - **Tombstones.** `post` and `reply` are permanent and declare `immutable`
 *   lists; the preserve sets below are exactly those lists minus `deleted`,
 *   which the tombstone sets itself under `immutableAllowSetting`.
 */
const V9_POST_INTERACTIONS: InteractionSurface = {
  ...V2_INTERACTIONS,
  like: { docType: 'like', field: 'postId', ownerFirst: true, ownerField: 'postAuthor' },
  indexOnlyLike: { authorField: 'postAuthor', hashtagField: 'hashtag' },
  replyCountField: 'rootPostId',
}

const V9_DESCRIPTOR: ContractTopologyDescriptor = {
  topology: 'v9',
  replyLinkage: { root: 'rootPostId', replyToReply: 'replyToReplyId' },
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
  interactions: {
    post: V9_POST_INTERACTIONS,
    reply: {
      like: { docType: 'likeReply', field: 'replyId', ownerFirst: true, ownerField: 'replyAuthor' },
      indexOnlyLike: { authorField: 'replyAuthor', hashtagField: null },
      repost: null,
      bookmark: null,
      quoteField: 'quotedReplyId',
      replyCountField: 'replyToReplyId',
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
}

let resolved: ContractTopologyDescriptor | null = null

/** The descriptor for the configured topology, resolved once and frozen. */
export function topologyDescriptor(): ContractTopologyDescriptor {
  if (!resolved) resolved = deepFreeze(DESCRIPTORS[getContractTopology()])
  return resolved
}

/**
 * True on the devnet contract. Every capability below exists on v9 and not on
 * v2; the helpers keep their own names because each call site is asking about
 * one capability, not about which network it runs on.
 */
function isV9(): boolean {
  return topologyDescriptor().topology === 'v9'
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

/** Where this kind's reposts live, or null when the kind cannot be reposted. */
export function repostIndexFor(kind: TargetKind): OwnedTargetIndex | null {
  return interactionsFor(kind).repost
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
  return isV9() ? '$createdAt' : '$ownerId'
}

/** The `reply` property whose count tree holds this kind's reply count. */
export function replyCountFieldFor(kind: TargetKind): string {
  return interactionsFor(kind).replyCountField
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
  return isV9()
}

/**
 * True when post and reply documents are permanent (`canBeDeleted: false`) and a
 * "delete" is therefore an edit that blanks the content and sets `deleted: true`
 * rather than a document removal.
 */
export function deletesAreTombstones(): boolean {
  return isV9()
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
  return isV9()
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
 * `byAuthorPost {at: [postAuthor, postId]}`.
 */
export function prefixRankingsAvailable(): boolean {
  return isV9()
}

/**
 * True when `follow.followerCount [followingId]` carries the full ranked
 * chain (v9), making "most followed" a proved ranked groupBy on `followingId`.
 * The O(1) follower COUNT (countable chain) exists on both topologies and is
 * not gated here.
 */
export function followRankingsAvailable(): boolean {
  return isV9()
}

/**
 * True when the like axes have DAILY-WINDOWED ranked twins (v9):
 * `like.byDayPost` (today's top posts), `like.byDayAuthorPost` (today's top
 * creators / per-author top) and `beat.byDayHashtagPost` (today's trending
 * tags / per-tag top). A `timeRange: [{ field: '$createdAt', selector }]`
 * entry on `documents.ranked()` pins the bucket; `newest` is today (UTC day,
 * `range == step == 86400`).
 */
export function windowedRankingsAvailable(): boolean {
  return isV9()
}

/** The daily grid every windowed index shares (seconds, as the contract declares them). */
export const WINDOWED_DAY_GRID = { range: 86400, step: 86400 } as const

/**
 * The `beat` companion a like must carry on v9: the tagged-only indexOnly
 * doctype whose `byDayHashtagPost` serves the windowed hashtag rankings.
 * `null` when no companion is written — v2, reply likes (no
 * hashtag axis), and likes of UNTAGGED posts (`beat.hashtag` is required, so
 * an untagged like writes no beat, which is the skipIfAbsent economy by other
 * means). Consensus checks `beat.hashtag` against the post through the same
 * propertyAgreement `like.hashtag` uses.
 */
export function beatCompanionFor(kind: TargetKind, hashtag: string | null | undefined): { docType: 'beat' } | null {
  if (!windowedRankingsAvailable() || kind !== 'post') return null
  if (!hashtag) return null
  return { docType: 'beat' }
}

export function canRepost(kind: TargetKind): boolean {
  return repostIndexFor(kind) !== null
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

/** A Post-shaped object reduced to `{ id, kind }` for topology dispatch. */
export function targetOf(post: KindBearing & { id: string }): KindedTarget {
  return { id: post.id, kind: targetKindOf(post) }
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
// committed v9 contract JSON so that the numbers the client shows and agrees to
// are the numbers consensus enforces. `lib/contract-topology.test.ts` pins them.

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

interface SocialDocumentSchema {
  canBeDeletedByModerators?: boolean
  required?: string[]
  properties?: Record<string, { refersTo?: { type?: string } }>
  tokenCost?: { create?: { amount: number; optional?: boolean; gasFeesPaidBy?: number } }
  actionFees?: { pricing?: string } & Partial<Record<DocumentAction, { owner?: number; moderators?: number }>>
}

const V9_SCHEMAS = socialContractV9.documentSchemas as unknown as Record<string, SocialDocumentSchema>
const V9_GRANT = (socialContractV9.tokens['0'].distributionRules as { oncePerIdentityDistribution?: { amount: number } })
  .oncePerIdentityDistribution

/**
 * True when the configured contract declares `moderation` (v9): identities can
 * be banned or suspended from it, posts and replies can be removed by its
 * moderators, and `moderationStatus`/`documentRemovals` are answerable.
 */
export function contractIsModerated(): boolean {
  return isV9()
}

/**
 * True when a referenced post or reply may no longer exist (v9): every
 * reference at `post`/`reply` is a `deletableDocument` reference, so a
 * quoted post, a thread root or a liked post can be ABSENT after a moderator
 * takedown. Readers match joins by id, never by position, and render the hole
 * as a removed-post stub instead of failing the page.
 */
export function referencesMayDangle(): boolean {
  return isV9()
}

/**
 * The identifier properties of `docType` a tombstone may DROP when their
 * target has been removed by a moderator (v9: `post.quotedPostId`,
 * `post.quotedReplyId`, `reply.replyToReplyId`): the optional
 * `deletableDocument` references. A replace re-validates every such
 * reference, so keeping a dead one is 40120, and clearing it is the one change
 * to an `immutable` property consensus lets through. A REQUIRED deletable
 * reference (`reply.rootPostId`) is not listed: it cannot be cleared, so a
 * reply under a removed root cannot be tombstoned at all. Empty on v2, where
 * nothing a post points at can disappear.
 */
export function clearableReferencesFor(docType: string): readonly string[] {
  if (!referencesMayDangle()) return []
  const schema = V9_SCHEMAS[docType]
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
  const declared = socialContractV9.config as { moderation?: Partial<Record<ModerationList, boolean>> }
  const moderation = declared.moderation
  if (!moderation) return []
  return (['banlist', 'suspensions', 'warnings'] as const).filter((list) => moderation[list] === true)
}

/** True when the configured contract keeps a warning list (warn / clear warnings). */
export function contractKeepsWarnings(): boolean {
  return moderationListsKept().includes('warnings')
}

/** The document types the contract's moderators may delete (v9: post, reply). */
export function moderatorDeletableTypes(): readonly string[] {
  if (!contractIsModerated()) return []
  return Object.entries(V9_SCHEMAS)
    .filter(([, schema]) => schema.canBeDeletedByModerators === true)
    .map(([name]) => name)
}

/**
 * The YAPP cost a create of `docType` declares on the configured contract, or
 * null when the type is unpriced. On v2 the cost is required and the document
 * owner pays the gas, which is what `optional: false` and `gasFeesPaidBy: 0`
 * say; the amounts are the same on both contracts (pinned by
 * `lib/contract-topology.test.ts`).
 */
export function tokenCostFor(docType: string): TokenCostDeclaration | null {
  const create = V9_SCHEMAS[docType]?.tokenCost?.create
  if (!create) return null
  if (!isV9()) return { amount: create.amount, optional: false, gasFeesPaidBy: 0 }
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
  if (!isV9()) return null
  const fees = V9_SCHEMAS[docType]?.actionFees
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
  if (!isV9() || !V9_GRANT) return null
  return BigInt(V9_GRANT.amount)
}

// ---------------------------------------------------------------------------
// Elected moderation, distinctFrom, private-feed gates and typed block
// follows (4.2.0-beta.4), read off the committed contract JSON and pinned by
// `lib/contract-topology.test.ts`.

/** What an elected team may do on one document type. */
export type ModerationAbility = 'deleteDocuments' | 'ban' | 'suspend' | 'warn'

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

interface GrammarDocumentSchema {
  ownerRefersTo?: unknown
  properties: Record<string, { distinctFrom?: string; items?: { distinctFrom?: string } }>
}

const V9_GRAMMAR_SCHEMAS = socialContractV9.documentSchemas as unknown as Record<string, GrammarDocumentSchema>
const V9_MODERATION = socialContractV9.config.moderation as {
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
  if (!isV9()) return null
  // One frozen object per resolved topology: React effects depend on it, and a
  // fresh object per call would re-run them on every render.
  if (!electedDeclaration) electedDeclaration = deepFreeze(buildElectedDeclaration())
  return electedDeclaration
}

let electedDeclaration: ElectedModerationDeclaration | null = null

function buildElectedDeclaration(): ElectedModerationDeclaration {
  const elected = V9_MODERATION.moderators
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
  if (!isV9()) return []
  return Object.entries(V9_GRAMMAR_SCHEMAS[docType]?.properties ?? {})
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
  return isV9() && V9_GRAMMAR_SCHEMAS.privateFeedGrant?.ownerRefersTo !== undefined
}

/**
 * True when `blockFollow.followedBlockers` is a typed array of identifiers
 * (v9) rather than one byte array of 32-byte ids packed end to end.
 */
export function blockFollowsAreTyped(): boolean {
  return isV9()
}
