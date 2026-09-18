/**
 * Everything that differs between the two contract interaction topologies that
 * exist on chain — `v2` (testnet/production) and `v7` (devnet) — in one frozen
 * descriptor. See `docs/SOCIAL_CONTRACT.md`.
 *
 * v7 replaces every polymorphic identifier field with a mono-typed,
 * `refersTo`-checked one. That splits what used to be a single query surface in
 * two: a like of a post lands in `like`, a like of a reply in `likeReply`; a
 * reply names its thread root and its presentational parent separately; reposts
 * and bookmarks stop accepting reply ids at all. Which surface a lookup uses
 * therefore depends on whether the thing being looked at is a `post` document
 * or a `reply` document — its {@link TargetKind}.
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
  /** Property naming the target's author — agreement-bound to `<target>.author`. */
  authorField: string
  /**
   * Property carrying the post's hashtag (agreement-bound to `post.hashtag`),
   * or null on a doctype without one (`likeReply`). The property is OPTIONAL:
   * an untagged like OMITS it — absence-aware propertyAgreement treats
   * both-absent as agreement, and sending `''` against an absent
   * `post.hashtag` would be a 40127 mismatch. See {@link hashtagIsOptional}.
   */
  hashtagField: string | null
}

/** The doctypes and fields one target kind's engagements live in. */
export interface InteractionSurface {
  /** Likes of this kind. */
  like: OwnedTargetIndex
  /**
   * Set when this kind's like doctype is `indexOnly`: creates must carry the
   * agreement-bound denormalizations, unlike is a delete-by-values needing the
   * full tuple (including the consensus `$createdAt`), and nothing may key
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
   * On v7 a post's reply count is its whole thread (`rootPostId`) while a
   * reply's is its direct children (`replyToReplyId`).
   */
  replyCountField: string
}

/** How a reply document names the thing(s) it hangs off. */
export interface ReplyLinkage {
  /**
   * The field a whole-thread fetch and the thread-size count tree key on. On v2
   * this is the polymorphic `parentId` (the *direct* parent, so a thread must be
   * walked); on v7 it is `rootPostId`, which every reply in a thread shares.
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
 * On v7 this is exactly the doctype's `immutable` list minus `deleted` (which
 * the tombstone sets itself, under `immutableAllowSetting`): consensus rejects
 * a replace that changes, adds OR DROPS a frozen property with 40128, so an
 * incomplete preserve set is not a silent data loss but a hard rejection.
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
 * The engagement surface of a v2 `post`, encoded exactly as the chain declares
 * it.
 *
 * The index orders matter and are NOT uniform: `like.postAndOwner` is
 * `[postId, $ownerId]` while `repost.ownerAndPost` and `bookmark.ownerAndPost`
 * are `[$ownerId, postId]`.
 *
 * On v2 a *reply* resolves to this surface too — every v2 identifier field is
 * polymorphic over post|reply — so both kinds share it.
 */
const V2_POST_INTERACTIONS: InteractionSurface = {
  like: { docType: 'like', field: 'postId', ownerFirst: false, ownerField: 'postOwnerId' },
  indexOnlyLike: null,
  repost: { docType: 'repost', field: 'postId', ownerFirst: true, ownerField: 'postOwnerId' },
  bookmark: { docType: 'bookmark', field: 'postId', ownerFirst: true, ownerField: null },
  quoteField: 'quotedPostId',
  replyCountField: 'parentId',
}

/** v2 — testnet/production. Both kinds share every surface. */
const V2_DESCRIPTOR: ContractTopologyDescriptor = {
  topology: 'v2',
  replyLinkage: { root: 'parentId', replyToReply: null },
  interactions: { post: V2_POST_INTERACTIONS, reply: V2_POST_INTERACTIONS },
  // v2 posts and replies are ordinary deletable documents, so a delete is a
  // delete and no tombstone is ever built ({@link deletesAreTombstones}).
  tombstonePreserves: { post: NOTHING_PRESERVED, reply: NOTHING_PRESERVED },
}

/**
 * v7 — `contracts/yappr-social-contract-v7.json` (docs/SOCIAL_CONTRACT.md,
 * docs/PLATFORM_BETA2_UPGRADE.md).
 *
 * The post surface keeps v2's engagement doctypes but gains a thread-wide reply
 * count and an OWNER-FIRST like index: `like.ownerAndPost` is `[$ownerId,
 * postId]` (v2's `postAndOwner` was `[postId, $ownerId]`), which is what lets
 * `queryOwnedPostIds` batch the whole "did I like these?" page into one `in`
 * query instead of a per-target fan-out. Uniqueness is order-independent and
 * likers listings ride `byPost`.
 *
 * `like` is indexOnly and carries two agreement-bound denormalizations:
 * `postAuthor`, which consensus checks against the post's `$ownerId`, and the
 * optional `hashtag`, checked against `post.hashtag` (absence included).
 */
const V7_POST_INTERACTIONS: InteractionSurface = {
  ...V2_POST_INTERACTIONS,
  like: { docType: 'like', field: 'postId', ownerFirst: true, ownerField: 'postAuthor' },
  indexOnlyLike: { authorField: 'postAuthor', hashtagField: 'hashtag' },
  replyCountField: 'rootPostId',
}

/**
 * v7's reply surface. Reply likes move to the indexOnly `likeReply.replyId`
 * (no hashtag axis); repost and bookmark keep only their post surfaces, because
 * consensus rejects a reply id outright now — the nulls mirror a chain-level
 * rule rather than a client convention; quotes of replies use the second
 * `post.quotedReplyId` field.
 */
const V7_REPLY_INTERACTIONS: InteractionSurface = {
  like: { docType: 'likeReply', field: 'replyId', ownerFirst: true, ownerField: 'replyAuthor' },
  indexOnlyLike: { authorField: 'replyAuthor', hashtagField: null },
  repost: null,
  bookmark: null,
  quoteField: 'quotedReplyId',
  replyCountField: 'replyToReplyId',
}

const V7_DESCRIPTOR: ContractTopologyDescriptor = {
  topology: 'v7',
  replyLinkage: { root: 'rootPostId', replyToReply: 'replyToReplyId' },
  interactions: { post: V7_POST_INTERACTIONS, reply: V7_REPLY_INTERACTIONS },
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
    // reply.immutable: the parent linkage. `replyToReplyId` is optional and
    // `tombstoneDocument` skips absent fields, so a direct reply reproduces its
    // absence; losing it would move the tombstone — and every live reply nested
    // under it — to the top of the thread.
    reply: { identifiers: ['rootPostId', 'replyToReplyId', 'parentOwnerId'], scalars: [] },
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
  v7: V7_DESCRIPTOR,
}

let resolved: ContractTopologyDescriptor | null = null

/** The descriptor for the configured topology, resolved once and frozen. */
export function topologyDescriptor(): ContractTopologyDescriptor {
  if (!resolved) resolved = deepFreeze(DESCRIPTORS[getContractTopology()])
  return resolved
}

/**
 * True on the devnet cut, false on the testnet/production one.
 *
 * Every capability predicate below is this test; they stay named apart because
 * each documents a DIFFERENT reason a call site branches, and a future third
 * cut will not gain them all at once.
 */
function isV7(): boolean {
  return topologyDescriptor().topology === 'v7'
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
 * $ownerId]`. v7 replaces it with chronological `quotesOfPost`/`quotesOfReply
 * [<field>, $createdAt]` indexes, because uniqueness was dropped (quotes are
 * content, not toggles) and a newest-first listing is what the UI wants.
 */
export function quoteListingOrderProperty(): '$ownerId' | '$createdAt' {
  return isV7() ? '$createdAt' : '$ownerId'
}

/** The `reply` property whose count tree holds this kind's reply count. */
export function replyCountFieldFor(kind: TargetKind): string {
  return interactionsFor(kind).replyCountField
}

/**
 * True when replies name their thread root directly (v7's `rootPostId`) rather
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
  return isV7()
}

/**
 * True when post and reply documents are permanent (`canBeDeleted: false`) and a
 * "delete" is therefore an edit that blanks the content and sets `deleted: true`
 * rather than a document removal.
 */
export function deletesAreTombstones(): boolean {
  return isV7()
}

/**
 * The properties a tombstone of this kind must reproduce verbatim.
 *
 * On v7 these are exactly the doctype's consensus-`immutable` properties
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

/** True when the configured topology's like doctypes are indexOnly. */
export function likesAreIndexOnly(): boolean {
  return indexOnlyLikeShapeFor('post') !== null
}

/**
 * True when a post carries its (single) hashtag inline in `post.hashtag` and
 * the `postHashtag` doctype does not exist. Tag listings then query
 * `post.tagAndTime` directly, the compose flow writes no secondary hashtag
 * documents, and there is nothing to "recover" when one is missing.
 */
export function hashtagsAreInline(): boolean {
  return isV7()
}

/**
 * True when `post.hashtag`/`like.hashtag` are OPTIONAL properties: an untagged
 * post omits the property entirely, and a like must mirror the post's absence —
 * absence-aware propertyAgreement treats both-absent as agreement, while
 * writing `''` against an absent `post.hashtag` is a 40127 mismatch.
 * `like.byHashtagPost` is `skipIfAbsent`, so untagged likes write no per-tag
 * index entries at all and reads of that index only ever see tagged likes.
 *
 * The CLIENT-side convention does not change: `Post.hashtag === ''` means
 * "known untagged" everywhere in memory (and `undefined` means "unknown —
 * fetch the post"), so caches, `LikeTargetInfo` and the tuple plumbing
 * round-trip absence without a third state. The `''` ↔ absent translation
 * happens exactly once, at the chain boundary (post create, like create,
 * unlike delete-by-values, post transform).
 */
export function hashtagIsOptional(): boolean {
  return isV7()
}

/**
 * The longest hashtag the contract's `post.hashtag`/`like.hashtag` pattern
 * accepts. An at-level ranked string key must fit the 247-byte encoded
 * ceiling, and 63 was rejected at contract validation.
 */
export const HASHTAG_MAX_LENGTH = 61

/**
 * True when the like doctype's at-form `rankedCountable` chains can answer
 * proved PREFIX-level ranked groupBy queries: trending hashtags off
 * `byHashtagPost {at: hashtag}` and the creator leaderboard off
 * `byAuthorPost {at: [postAuthor, postId]}`.
 */
export function prefixRankingsAvailable(): boolean {
  return isV7()
}

/**
 * True when `follow.followerCount [followingId]` carries the full ranked
 * chain, making "most followed" a proved ranked groupBy on `followingId`. The
 * O(1) follower COUNT (countable chain) exists on every topology and is not
 * gated here.
 */
export function followRankingsAvailable(): boolean {
  return isV7()
}

/**
 * True when the like axes have DAILY-WINDOWED ranked twins: `like.byDayPost`
 * (today's top posts), `like.byDayAuthorPost` (today's top creators /
 * per-author top) and `beat.byDayHashtagPost` (today's trending tags /
 * per-tag top). A `timeRange: [{ field: '$createdAt', selector }]` entry on
 * `documents.ranked()` pins the bucket; `newest` is today (UTC day,
 * `range == step == 86400`).
 */
export function windowedRankingsAvailable(): boolean {
  return isV7()
}

/** The daily grid every windowed index shares (seconds, as the contract declares them). */
export const WINDOWED_DAY_GRID = { range: 86400, step: 86400 } as const

/**
 * The `beat` companion a like must carry: the tagged-only indexOnly doctype
 * whose `byDayHashtagPost` serves the windowed hashtag rankings. `null` when
 * no companion is written — topologies without windowed rankings, reply likes
 * (no hashtag axis), and likes of UNTAGGED posts (`beat.hashtag` is required, so
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
  /** Set on v7 reply shapes: the post every reply in the thread hangs off. */
  rootPostId?: string
}

/**
 * The id of the post at the root of this object's thread.
 *
 * A top-level post is its own root. A reply names its root directly on v7; on v2
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
 * treated as a top-level post (which on v7 would send its like to `like` instead
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
 * kinds existed. On v7 it returns up to one group per kind, preserving input
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
