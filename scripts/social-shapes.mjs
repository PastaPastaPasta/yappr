/**
 * The social documents the Node scripts write, built for the cut a contract
 * file declares (docs/archive/SOCIAL_V10.md to docs/SOCIAL_V17.md). Every switch reads
 * the schemas, never the file's name, so one builder serves v10 to v17 and a
 * v10–v12 document comes out exactly as the scripts wrote it before v13:
 *
 *   - `live` (v13): every post that is not a tombstone carries `live: true`, a
 *     tombstone leaves it out, and `post.ownerAndTime` is `[live, $ownerId,
 *     $createdAt]` (skipIfAbsent), so its reads pin `live == true` first;
 *   - `reply.rootOwnerId` (v13): the root post's owner, `where`-bound to it;
 *     a top-level reply's `parentOwnerId` must be that owner (`parentIsRoot`);
 *   - no stored reply owners (v14): a reply names only `rootPostId` and
 *     `replyToReplyId`; its notification windows read the owners off the
 *     referenced documents (`rootPostId.$ownerId`, `replyToReplyId.$ownerId`),
 *     so `parentOwnerId` and `rootOwnerId` are dropped whatever the caller passes;
 *   - `likeReply.replyAuthor` (v10–v12 only): v13 likes a reply by its id;
 *   - media: v10–v12 carry one `mediaUrl` with its `mediaHash` and
 *     `mediaFingerprint`; v13 carries 1–4 items as `mediaUrls`, `mediaDigests`
 *     (sha256 ‖ fingerprint, 40 B each) and `mediaKinds` (1 B each);
 *   - reports (v13): a profile report is `about: 1` with no post or reply,
 *     a post or reply report may carry the moderators' `box`, and every
 *     report pays a moderators action fee on create;
 *   - blocks (v13): `block`, `blockFilter` and `blockFollow` live in the
 *     standalone blocks contract, not in social;
 *   - mentions (v15): a post or reply names 1–8 distinct identities in the
 *     typed array `mentionedUserIds` (one `mentionedUserId` up to v14), and
 *     `mentionedUserAndTime` enters it once per element, read with the
 *     5.0.0-beta.5 `contains` operator;
 *   - tags (v16): a post is indexed under 1–4 distinct tags in the typed array
 *     `tags` (one `hashtag` up to v15), and a like repeats the post's list
 *     exactly (`where { "tags": "tags" }`, same elements in the same order,
 *     5.0.0-beta.6). `tagAndTime` and the like tag indexes enter a document
 *     once per tag, so a read pins one tag with `contains`, never `==`.
 *   - the live listings (v17): `post.timeline` and `post.tagAndTime` are keyed on
 *     `live` first (skipIfAbsent), so a tombstone leaves the global timeline and
 *     the tag pages, and their reads pin `live == true` first like
 *     `ownerAndTime`; a reply carries `live: true` too (`reply.ownerAndTime` is
 *     `[live, $ownerId, $createdAt]`);
 *   - private feeds (v17): a private post or reply names the `feed` it was sealed
 *     to beside its ciphertext, key generation and nonce (the `private` rule is
 *     all four or none); `privateFeedState` is replaced by `privateFeed`.
 *
 * Pure: no network, no SDK. `node scripts/social-shapes.mjs --self-test`
 * builds every write against each social cut and judges it with the pure
 * checker below and with rs-dpp's own rule evaluation (the wasm-sdk's
 * `checkDocumentPropertyConstraints`) and serializer, offline.
 */
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandSchemas } from './schema-shorthands.mjs';

/** `mediaKinds` bytes (v13); a reader ignores any other value, which consensus cannot refuse. */
export const MEDIA_KIND = { image: 0, video: 1, gif: 2 };
const SHA256_BYTES = 32;
const FINGERPRINT_BYTES = 8;
/** One `mediaDigests` item: the sha256 of the bytes at the URL, then the 64-bit dHash. */
export const MEDIA_DIGEST_BYTES = SHA256_BYTES + FINGERPRINT_BYTES;
const IDENTIFIER_MEDIA_TYPE = 'application/x.dash.dpp.identifier';

/** Drops undefined and null values, so an optional field the caller left out stays ABSENT on chain. */
const defined = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
const sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((byte, i) => byte === b[i]);

/** The suffix a cashtag is stored with (`$DASH` is `dash_cashtag`), as lib/post-helpers.ts writes it. */
const CASHTAG_SUFFIX = '_cashtag';

/** A link in post text, as lib/post-helpers.ts `URL_PATTERN` (the renderer's): a tag inside one is none. */
const URL_PATTERN = /(https?:\/\/[^\s<>"']+|ipfs:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g;

/** What may not follow a tag, as lib/post-helpers.ts `TAG_END`: a letter, digit or mark in any script, or `_`. A tag is a whole ASCII word, so `#café` is none (never `#caf`). */
const TAG_END = String.raw`(?![\p{L}\p{N}\p{M}_])`;
/** A hashtag and a cashtag in post text, as lib/post-helpers.ts `HASHTAG_PATTERN` / `CASHTAG_PATTERN`: any length; the ceiling applies after. */
const HASHTAG_PATTERN = new RegExp(String.raw`#([a-zA-Z0-9_]+)` + TAG_END, 'gu');
const CASHTAG_PATTERN = new RegExp(String.raw`\$([a-zA-Z][a-zA-Z0-9_]*)` + TAG_END, 'gu');

/**
 * The tags `content` is indexed under, in storage form, by the web client's
 * rule (`indexedTags` in lib/post-helpers.ts): the hashtags in content order,
 * then the cashtags, lowercase, distinct, at most `max` of them, none whose
 * storage form is longer than `maxLength` (a cashtag's suffix included; a
 * longer tag is plain text, never cut), none inside a link (a match
 * overlapping a link that starts earlier is dropped, as the renderer drops
 * it). With `max` 1 that is the one-tag cuts' rule: the first hashtag, else
 * the first cashtag. `[]` when the content names no tag.
 */
export function indexedTags(content, max, maxLength) {
  const found = [];
  for (const [kind, regex] of [['url', URL_PATTERN], ['hashtag', HASHTAG_PATTERN], ['cashtag', CASHTAG_PATTERN]]) {
    for (const match of content.matchAll(new RegExp(regex.source, regex.flags))) found.push({ kind, start: match.index, end: match.index + match[0].length, tag: match[1] });
  }
  found.sort((a, b) => a.start - b.start);
  const rendered = [];
  let lastEnd = 0;
  for (const match of found) {
    if (match.start < lastEnd) continue;
    lastEnd = match.end;
    if (match.kind !== 'url') rendered.push(match);
  }
  const tags = [];
  const add = (tag) => {
    if (tag.length <= maxLength && tags.length < max && !tags.includes(tag)) tags.push(tag);
  };
  for (const { tag } of rendered.filter(({ kind }) => kind === 'hashtag')) add(tag.toLowerCase());
  for (const { tag } of rendered.filter(({ kind }) => kind === 'cashtag')) add(tag.toLowerCase() + CASHTAG_SUFFIX);
  return tags;
}

/**
 * The action fee `docType`'s create charges under `schemas`, or null when it
 * charges none: `{ owner, moderators, pricing }` in credits, off the file so no
 * amount is ever transcribed (a mismatch is a paid 40133).
 */
export function actionFeeOf(schemas, docType) {
  const fees = schemas[docType]?.actionFees;
  const create = fees?.create;
  if (!create) return null;
  return {
    owner: BigInt(create.owner ?? 0),
    moderators: BigInt(create.moderators ?? 0),
    pricing: fees.pricing === 'fixed' ? 'fixed' : 'feeMultiplier',
  };
}

/**
 * The `where` that finds `ownerId`'s report of the target `data` names, on its
 * unique target-first index (v13 `byPost [postId, $ownerId]`, `byReply
 * [replyId, $ownerId]`, `byTarget [targetOwnerId, about, $ownerId]`): no v13
 * report index serves `$ownerId` alone, so a report whose confirmation timed
 * out is recovered by its target. Identifiers are base58.
 */
export function reportRecoveryWhere(data, ownerId) {
  const encode = (value) => (typeof value === 'string' ? value : bs58.encode(value));
  const owner = ['$ownerId', '==', ownerId];
  if (data.postId) return [['postId', '==', encode(data.postId)], owner];
  if (data.replyId) return [['replyId', '==', encode(data.replyId)], owner];
  if (data.about !== undefined && data.targetOwnerId) return [['targetOwnerId', '==', encode(data.targetOwnerId)], ['about', '==', data.about], owner];
  throw new Error('A report names a post, a reply or a profile');
}

/** Whether `type`'s index `name` is keyed on `live` first (v17's timeline and tag listing). */
function indexStartsWithLive(schemas, type, name) {
  const index = schemas[type]?.indices?.find((i) => i.name === name);
  return index !== undefined && Object.keys(index.properties[0])[0] === 'live';
}

/**
 * The builders, query prefixes and checker for one social cut. `contract` is a
 * contract JSON (`{ documentSchemas }`) or its `documentSchemas`.
 */
export function socialShapes(contract) {
  // In long form (v15 writes its byte arrays as shorthands), so the checker reads one shape.
  const schemas = expandSchemas(contract.documentSchemas ?? contract);
  const declares = (type, property) => schemas[type]?.properties?.[property] !== undefined;
  const cut = Object.freeze({
    liveMarker: declares('post', 'live'),
    rootOwner: declares('reply', 'rootOwnerId'),
    storedReplyOwners: declares('reply', 'parentOwnerId'),
    replyAuthor: declares('likeReply', 'replyAuthor'),
    mediaArrays: declares('post', 'mediaUrls'),
    profileReports: declares('report', 'about'),
    blocksInSocial: schemas.block !== undefined,
    mentionArray: declares('post', 'mentionedUserIds'),
    tagArray: declares('post', 'tags'),
    replyLiveMarker: declares('reply', 'live'),
    privateFeeds: declares('post', 'feed'),
    liveTimeline: indexStartsWithLive(schemas, 'post', 'timeline'),
    liveTagIndex: indexStartsWithLive(schemas, 'post', 'tagAndTime'),
    liveThread: indexStartsWithLive(schemas, 'reply', 'repliesOf'),
  });

  /** The post and like property naming a post's tags: `hashtag` up to v15, the typed array `tags` on v16. */
  const tagField = cut.tagArray ? 'tags' : 'hashtag';
  /** How many tags one post is indexed under: 1, or `post.tags.maxItems` (4) on v16. */
  const tagMax = cut.tagArray ? schemas.post.properties.tags.maxItems : 1;
  /** The longest tag the pattern accepts (61, the ranked key-size ceiling): an element's on v16. */
  const tagMaxLength = (cut.tagArray ? schemas.post.properties.tags.items : schemas.post.properties.hashtag).maxLength;

  /** A post create or replace: `live: true` unless it is a tombstone (`deleted` present). */
  const post = (data) => (cut.liveMarker && data.deleted === undefined && data.live === undefined ? { ...data, live: true } : data);
  /** A reply create or replace on v17: `live: true` unless it is a tombstone, as a post's. */
  const liveReply = (data) => (cut.replyLiveMarker && data.deleted === undefined && data.live === undefined ? { ...data, live: true } : data);

  /**
   * A reply's linkage. A top-level reply answers its root post, so its
   * `parentOwnerId` and (v13) `rootOwnerId` are the same identity and either
   * names both. A nested reply names its parent reply's owner in
   * `parentOwnerId` and, on v13, the root post's owner in `rootOwnerId`. A
   * forged pair (a refusal probe) is passed through as given. On v14 a reply
   * stores no owner: both are dropped, so a caller written for any cut works.
   * From v17 a reply that is not a tombstone carries `live: true`.
   */
  const reply = (fields) => liveReply(replyLinkage(fields));
  const replyLinkage = ({ rootPostId, rootOwnerId, replyToReplyId, parentOwnerId, ...rest }) => {
    if (!cut.storedReplyOwners) return { ...rest, ...defined({ rootPostId, replyToReplyId }) };
    const topLevel = replyToReplyId === undefined || replyToReplyId === null;
    const parent = parentOwnerId ?? (topLevel ? rootOwnerId : undefined);
    if (parent === undefined) {
      throw new Error(topLevel ? 'a top-level reply names its root post\'s owner (parentOwnerId or rootOwnerId)' : 'a nested reply names its parent reply\'s owner (parentOwnerId)');
    }
    const linkage = { rootPostId, replyToReplyId, parentOwnerId: parent };
    if (cut.rootOwner) {
      const rootOwner = rootOwnerId ?? (topLevel ? parent : undefined);
      if (rootOwner === undefined) throw new Error('a nested reply names its root post\'s owner (rootOwnerId) on this cut');
      linkage.rootOwnerId = rootOwner;
    }
    return { ...rest, ...defined(linkage) };
  };

  /** A reply like and its delete-by-values tuple: `{ replyId, replyAuthor }` up to v12, `{ replyId }` on v13. */
  const likeReply = ({ replyId, replyAuthor }) => {
    if (!cut.replyAuthor) return { replyId };
    if (replyAuthor === undefined) throw new Error('a reply like names the reply\'s author (replyAuthor) on this cut');
    return { replyId, replyAuthor };
  };

  /**
   * The media fields of a post or reply: `items` is `[{ url, sha256, fingerprint,
   * kind }]` (kind defaults to an image). v10–v12 hold exactly one item.
   */
  const media = (items) => {
    for (const item of items) {
      if (item.sha256?.length !== SHA256_BYTES || item.fingerprint?.length !== FINGERPRINT_BYTES) {
        throw new Error(`a media item is a ${SHA256_BYTES}-byte sha256 and an ${FINGERPRINT_BYTES}-byte fingerprint`);
      }
    }
    if (!cut.mediaArrays) {
      if (items.length !== 1) throw new Error(`this cut carries one media item (mediaUrl), not ${items.length}`);
      const [{ url, sha256, fingerprint }] = items;
      return { mediaUrl: url, mediaHash: sha256, mediaFingerprint: fingerprint };
    }
    const { minItems, maxItems } = schemas.post.properties.mediaUrls;
    if (items.length < minItems || items.length > maxItems) throw new Error(`a post carries ${minItems}–${maxItems} media items, not ${items.length}`);
    const digests = new Uint8Array(MEDIA_DIGEST_BYTES * items.length);
    items.forEach(({ sha256, fingerprint }, i) => {
      digests.set(sha256, i * MEDIA_DIGEST_BYTES);
      digests.set(fingerprint, i * MEDIA_DIGEST_BYTES + SHA256_BYTES);
    });
    return {
      mediaUrls: items.map((item) => item.url),
      mediaDigests: digests,
      mediaKinds: Uint8Array.from(items.map((item) => item.kind ?? MEDIA_KIND.image)),
    };
  };

  /**
   * The mention fields of a post or reply naming `ids` (32-byte identifiers):
   * nothing for none, `mentionedUserId` for one up to v14, `mentionedUserIds`
   * (at most `maxItems`, 8) on v15. Throws past the cut's limit; a refusal
   * probe writes the property itself.
   */
  const mentions = (ids = []) => {
    if (ids.length === 0) return {};
    if (!cut.mentionArray) {
      if (ids.length !== 1) throw new Error(`this cut names one mention (mentionedUserId), not ${ids.length}`);
      return { mentionedUserId: ids[0] };
    }
    const { maxItems } = schemas.post.properties.mentionedUserIds;
    if (ids.length > maxItems) throw new Error(`a post names at most ${maxItems} mentions, not ${ids.length}`);
    return { mentionedUserIds: ids };
  };

  /**
   * The `where` and `orderBy` reading a post's or reply's `mentionedUserAndTime`
   * for the documents mentioning `mentioned` (base58) after `since`, in
   * `direction`: `mentionedUserId ==` up to v14; on v15 one element of
   * `mentionedUserIds` with `contains` (5.0.0-beta.5), ordered by `$createdAt`
   * alone, since a typed array is ordered by only under `containsAny`.
   */
  const mentionsOf = (mentioned, since = 0, direction = 'desc') => (cut.mentionArray
    ? { where: [['mentionedUserIds', 'contains', mentioned], ['$createdAt', '>', since]], orderBy: [['$createdAt', direction]] }
    : { where: [['mentionedUserId', '==', mentioned], ['$createdAt', '>', since]], orderBy: [['mentionedUserId', 'asc'], ['$createdAt', direction]] });

  /**
   * The tag fields of a post indexed under `list` (storage form, in order), or
   * of a like repeating its post's: nothing for an untagged post, `hashtag`
   * for one tag up to v15, the whole list as `tags` (at most `maxItems`, 4) on
   * v16. A like passes its post's list unchanged, so the `where` agreement
   * holds element for element. Throws past the cut's limit; a refusal probe
   * writes the property itself.
   */
  const tags = (list = []) => {
    if (list.length === 0) return {};
    if (!cut.tagArray) {
      if (list.length !== 1) throw new Error(`this cut indexes one tag (hashtag), not ${list.length}`);
      return { hashtag: list[0] };
    }
    if (list.length > tagMax) throw new Error(`a post is indexed under at most ${tagMax} tags, not ${list.length}`);
    return { tags: [...list] };
  };

  /**
   * A stored post's (or like's, or removal record's) tags read back off either
   * spelling: `[hashtag]` or `tags`, `[]` when the document carries none.
   */
  const storedTags = (data) => {
    const value = data?.[tagField];
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? [...value] : [value];
  };

  /**
   * The tags `content` is indexed under on this cut ({@link indexedTags}): the
   * first one up to v15, which leaves the rest plain text; on v16 every tag it
   * names, and a content naming more than `maxItems` (4) distinct tags throws,
   * as the web client refuses such a post (`tagLimitProblem` in
   * lib/compose/limits.ts) rather than index part of it.
   */
  const contentTags = (content) => {
    if (!cut.tagArray) return indexedTags(content ?? '', 1, tagMaxLength);
    const named = indexedTags(content ?? '', Number.MAX_SAFE_INTEGER, tagMaxLength);
    if (named.length > tagMax) throw new Error(`a post can have at most ${tagMax} tags; the content names ${named.length}`);
    return named;
  };

  /**
   * The fields of a private post or reply: `encryptedContent`, `keyGeneration`
   * and `nonce`, plus (v17) the `feed` it was sealed to, all four or none
   * (`private`). Up to v16 there is no feed and the one passed is dropped, so
   * a caller written for any cut works; on v17 it must name one (1-65535).
   */
  const privateFields = ({ encryptedContent, keyGeneration, nonce, feed }) => {
    if (!cut.privateFeeds) return { encryptedContent, keyGeneration, nonce };
    if (feed === undefined || feed === null) throw new Error('a private write names its feed (feed) on this cut');
    return { encryptedContent, keyGeneration, nonce, feed };
  };

  /**
   * The `where` of a read on `post.tagAndTime` or `post.timeline` when the
   * index is keyed on `live` first (v17): `live == true` ahead of the caller's
   * conditions, so a tombstone is not listed. Otherwise the conditions as given.
   */
  const livePinned = (keyedOnLive, where) => (keyedOnLive ? [['live', '==', true], ...where] : where);
  /** A whole `{ where, orderBy, … }` query on the global `post.timeline` (`[live, $createdAt]` from v17, `[$createdAt]` before). */
  const timelinePosts = (query) => ({ ...query, where: livePinned(cut.liveTimeline, query.where ?? []) });
  /**
   * The `where` of a read on `reply.repliesOf` (thread pages, children, counts,
   * composite slots, the ranked roots): `live == true` first on v17, whose
   * index is `[live, rootPostId, replyToReplyId, $createdAt]` with
   * `skipIfAbsent: ["live"]`, so a tombstone leaves the thread and its counts.
   */
  const threadWhere = (where = []) => livePinned(cut.liveThread, where);

  /**
   * The `where` clause pinning one tag on `post.tagAndTime` or the like tag
   * indexes (`byHashtagPost`, `byTrendHashtagPost`): `hashtag ==` up to v15;
   * on v16 `tags contains`, which the node keys as an equality on one element
   * of the list (5.0.0-beta.5). `==` on the array is refused.
   */
  const tagPin = (tag) => (cut.tagArray ? ['tags', 'contains', tag] : ['hashtag', '==', tag]);

  /**
   * The `where` and `orderBy` walking the posts tagged `tag` after `since` on
   * `post.tagAndTime`, in `direction`: `hashtag ==` up to v15; on v16 one
   * element of `tags` with `contains`, ordered by `$createdAt` alone, since a
   * typed array is ordered by only under `containsAny`; on v17 `live == true`
   * first (the index is `[live, tags, $createdAt]`), which leaves the
   * tombstones out.
   */
  const taggedPosts = (tag, since = 0, direction = 'desc') => (cut.tagArray
    ? { where: livePinned(cut.liveTagIndex, [tagPin(tag), ['$createdAt', '>', since]]), orderBy: [['$createdAt', direction]] }
    : { where: [tagPin(tag), ['$createdAt', '>', since]], orderBy: [['hashtag', 'asc'], ['$createdAt', direction]] });

  /**
   * The `groupBy` and `where` of a like ranking (`documents.ranked`) on the tag
   * indexes: with a tag, its posts by likes (`groupBy: 'postId'` under the
   * pin); without one, the tags by likes (`groupBy` the tag property, no
   * `where`). On v16 a like of a post tagged [a, b] counts under each tag,
   * and `containsAny` is refused in a ranked read.
   */
  const tagRanking = (tag) => (tag === undefined ? { groupBy: tagField } : { groupBy: 'postId', where: [tagPin(tag)] });

  /** The `where` of a like count under one tag: every like under it, or with `postId` (base58) one post's. */
  const tagLikesWhere = (tag, postId) => (postId === undefined ? [tagPin(tag)] : [tagPin(tag), ['postId', '==', postId]]);

  /**
   * A report: exactly one of `postId`, `replyId` or (v13) `about: 1` for the
   * profile of `targetOwnerId`. `box` (v13) is the moderators' key box of a
   * private post or reply. reason 8 needs a `note`.
   */
  const report = ({ postId, replyId, about, box, targetOwnerId, reason = 0, note, status, resolution }) => {
    if ((about !== undefined || box !== undefined) && !cut.profileReports) throw new Error('this cut has no profile reports and no report box');
    return defined({ postId, replyId, about, box, targetOwnerId, reason, note, status, resolution });
  };

  /**
   * Adapts a document written in the v10–v12 shape to this cut (posts gain
   * `live`, a reply's root owner follows from its top-level parent, a reply like
   * drops `replyAuthor`), for scripts whose fixtures are mostly v12-shaped.
   */
  const fit = (docType, data) => {
    if (docType === 'post') return post(data);
    if (docType === 'reply') return reply(data);
    if (docType === 'likeReply') return likeReply(data);
    return data;
  };

  /** The `where` of a read on `post.ownerAndTime`: `live == true` first on v13. */
  const ownerPostsWhere = (where = []) => (cut.liveMarker ? [['live', '==', true], ...where] : where);
  /**
   * Its `orderBy`: an order that spells the index from `$ownerId` gains `live`
   * in front; one that names only `$createdAt` leaves both pinned levels out,
   * as before.
   */
  const ownerPostsOrderBy = (orderBy) => (cut.liveMarker && orderBy?.[0]?.[0] === '$ownerId' ? [['live', 'asc'], ...orderBy] : orderBy);
  /** A whole `{ where, orderBy, … }` query on `post.ownerAndTime`. */
  const ownerPosts = (query) => ({ ...query, where: ownerPostsWhere(query.where), ...(query.orderBy ? { orderBy: ownerPostsOrderBy(query.orderBy) } : {}) });

  /** A whole `{ where, orderBy, … }` query on `reply.ownerAndTime`: `live == true` first from v17, where a tombstone is no longer indexed. */
  const ownerReplies = (query) => ({
    ...query,
    where: livePinned(cut.replyLiveMarker, query.where ?? []),
    ...(query.orderBy ? { orderBy: cut.replyLiveMarker && query.orderBy[0]?.[0] === '$ownerId' ? [['live', 'asc'], ...query.orderBy] : query.orderBy } : {}),
  });

  /** The contract `docType` lives in: the blocks types moved out of social on v13. */
  const contractFor = (docType, { social, blocks }) => {
    if (cut.blocksInSocial || !BLOCK_TYPES.includes(docType)) return social;
    if (!blocks) throw new Error(`${docType} lives in the blocks contract on this cut: name it (--blocks-contract or NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID)`);
    return blocks;
  };

  /**
   * What is wrong with `data` as a `docType` create on this cut, as a list of
   * problems (empty when it is right): undeclared or missing properties,
   * identifier lengths, and the rules the scripts rely on (live, media,
   * parentIsRoot, the report target, the v10–v12 media triple).
   */
  const check = (docType, data) => {
    const schema = schemas[docType];
    if (!schema) return [`${docType} is not a type of this contract`];
    const problems = [];
    for (const key of Object.keys(data)) if (!key.startsWith('$') && !schema.properties[key]) problems.push(`${docType}.${key} is not declared`);
    for (const key of schema.required ?? []) if (!key.startsWith('$') && data[key] === undefined) problems.push(`${docType}.${key} is required`);
    for (const [key, property] of Object.entries(schema.properties)) {
      if (data[key] !== undefined && property.contentMediaType === IDENTIFIER_MEDIA_TYPE && data[key]?.length !== 32) problems.push(`${docType}.${key} is not a 32-byte identifier`);
      if (data[key] !== undefined && property.items?.contentMediaType === IDENTIFIER_MEDIA_TYPE) {
        const list = data[key];
        if (!Array.isArray(list) || list.some((element) => element?.length !== 32)) {
          problems.push(`${docType}.${key} is not a list of 32-byte identifiers`);
        } else {
          if (list.length < (property.minItems ?? 0) || list.length > (property.maxItems ?? Infinity)) problems.push(`${docType}.${key} holds ${list.length} identifiers, outside ${property.minItems ?? 0}–${property.maxItems}`);
          if (property.uniqueItems && new Set(list.map((element) => bs58.encode(element))).size !== list.length) problems.push(`${docType}.${key} repeats an identifier`);
        }
      }
      // A typed array of strings with a pattern (v16's `tags`): the list, its bounds and every element.
      if (data[key] !== undefined && property.type === 'array' && property.items?.type === 'string' && property.items.pattern) {
        const list = data[key];
        const pattern = new RegExp(property.items.pattern);
        if (!Array.isArray(list) || list.some((element) => typeof element !== 'string')) {
          problems.push(`${docType}.${key} is not a list of strings`);
        } else {
          if (list.length < (property.minItems ?? 0) || list.length > (property.maxItems ?? Infinity)) problems.push(`${docType}.${key} holds ${list.length} items, outside ${property.minItems ?? 0}–${property.maxItems}`);
          if (property.uniqueItems && new Set(list).size !== list.length) problems.push(`${docType}.${key} repeats an item`);
          const bad = list.filter((element) => !pattern.test(element) || element.length > (property.items.maxLength ?? Infinity));
          if (bad.length > 0) problems.push(`${docType}.${key} holds ${JSON.stringify(bad)}, outside ${property.items.pattern}`);
        }
      }
    }
    if (docType === 'post' && cut.liveMarker) {
      if (data.deleted !== undefined && data.live !== undefined) problems.push('a post tombstone carries live');
      if (data.deleted === undefined && data.live !== true) problems.push('a post that is not a tombstone lacks live: true');
    }
    if (docType === 'reply' && cut.replyLiveMarker) {
      if (data.deleted !== undefined && data.live !== undefined) problems.push('a reply tombstone carries live (live)');
      if (data.deleted === undefined && data.live !== true) problems.push('a reply that is not a tombstone lacks live: true (live)');
    }
    if (docType === 'reply' && schema.propertyConstraints?.notEmpty) {
      // v17: a reply says something (notEmpty): text, ciphertext, media or a tombstone.
      if (!(data.content?.length > 0) && data.encryptedContent === undefined && data.mediaUrls === undefined && data.deleted === undefined) problems.push('a reply carries no text, ciphertext or media (notEmpty)');
    }
    if ((docType === 'post' || docType === 'reply') && cut.privateFeeds) {
      const sealed = ['encryptedContent', 'keyGeneration', 'nonce', 'feed'].filter((key) => data[key] !== undefined).length;
      if (sealed !== 0 && sealed !== 4) problems.push(`${docType} carries ${sealed} of the 4 private fields: ciphertext, key generation, nonce and feed (private)`);
    }
    if (docType === 'post' || docType === 'reply') {
      if (cut.mediaArrays) {
        const urls = data.mediaUrls?.length ?? 0;
        if (urls * MEDIA_DIGEST_BYTES !== (data.mediaDigests?.length ?? 0) || urls !== (data.mediaKinds?.length ?? 0)) problems.push(`${docType} media lengths disagree (media)`);
        if (data.mediaUrls !== undefined && (urls < 1 || urls > 4)) problems.push(`${docType} carries ${urls} media URLs`);
      } else if ((data.mediaUrl === undefined) !== (data.mediaHash === undefined) || (data.mediaUrl === undefined) !== (data.mediaFingerprint === undefined)) {
        problems.push(`${docType} media triple incomplete (dependentRequired)`);
      }
    }
    if (docType === 'reply' && cut.rootOwner && data.replyToReplyId === undefined && !sameBytes(data.parentOwnerId, data.rootOwnerId)) {
      problems.push('a top-level reply names a parentOwnerId other than its rootOwnerId (parentIsRoot)');
    }
    if (docType === 'report') {
      const targets = ['postId', 'replyId', 'about'].filter((key) => data[key] !== undefined);
      if (targets.length !== 1) problems.push(`a report names ${targets.length} targets (oneTarget)`);
      if (data.box !== undefined && data.about !== undefined) problems.push('a profile report carries a box (boxOnContent)');
      if (data.reason === 8 && data.note === undefined) problems.push('reason 8 needs a note');
      if (data.reason > schema.properties.reason.maximum) problems.push(`reason ${data.reason} is over ${schema.properties.reason.maximum}`);
    }
    return problems;
  };

  /**
   * An author's tombstone of the stored `docType` (post or reply) `stored`:
   * `deleted: true` plus every property the type freezes unconditionally (the
   * plain-string entries of its `immutable`: a post's `hashtag` or `tags`, a
   * reply's `rootPostId`, `replyToReplyId` and, up to v13, its stored owners),
   * copied off `stored` when present. Dropping one of them is 40128; every
   * other field is left out (`blankTombstone`), `live` included. `stored` is a
   * document's data as `toJSON()` (base58 identifiers) or `toObject()` (bytes)
   * gives it; identifiers come out as bytes. Throws on a cut whose authors
   * delete for real (v10) instead of tombstoning.
   */
  const tombstone = (docType, stored) => {
    const schema = schemas[docType];
    if (schema?.canBeDeleted !== false || !declares(docType, 'deleted')) throw new Error(`${docType} has no author tombstone on this cut`);
    const kept = {};
    for (const field of (schema.immutable ?? []).filter((entry) => typeof entry === 'string')) {
      const value = stored?.[field];
      if (value === undefined || value === null) continue;
      if (schema.properties[field]?.contentMediaType === IDENTIFIER_MEDIA_TYPE) kept[field] = typeof value === 'string' ? bs58.decode(value) : Uint8Array.from(value);
      else kept[field] = Array.isArray(value) ? [...value] : value;
    }
    return { deleted: true, ...kept };
  };

  return Object.freeze({
    schemas, cut, post, reply, likeReply, media, mentions, mentionsOf, report, fit, tombstone, privateFields,
    tagField, tagMax, tags, storedTags, contentTags, tagPin, taggedPosts, tagRanking, tagLikesWhere, timelinePosts, threadWhere,
    ownerPostsWhere, ownerPostsOrderBy, ownerPosts, ownerReplies, contractFor, check,
    actionFee: (docType) => actionFeeOf(schemas, docType),
  });
}

/** The types the blocks contract holds from v13 on. */
export const BLOCK_TYPES = ['block', 'blockFilter', 'blockFollow'];

// ---- Self-test ------------------------------------------------------------------

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SOCIAL_CUTS = ['v10', 'v11', 'v12', 'v13', 'v14', 'v15', 'v16', 'v17'];

/** The cut flags each social cut declares. */
function expectedCut(version) {
  const from = (first) => SOCIAL_CUTS.indexOf(version) >= SOCIAL_CUTS.indexOf(first);
  return {
    liveMarker: from('v13'),
    rootOwner: version === 'v13',
    storedReplyOwners: !from('v14'),
    replyAuthor: !from('v13'),
    mediaArrays: from('v13'),
    profileReports: from('v13'),
    blocksInSocial: !from('v13'),
    mentionArray: from('v15'),
    tagArray: from('v16'),
    replyLiveMarker: from('v17'),
    privateFeeds: from('v17'),
    liveTimeline: from('v17'),
    liveTagIndex: from('v17'),
    liveThread: from('v17'),
  };
}
const readContract = (file) => JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', file), 'utf8'));

/**
 * Every write the scripts make, built for one cut: `[label, docType, data,
 * expected]`, where `expected` is null (a valid create) or the rule (or
 * `check` problem) a deliberately broken one must break.
 */
function writesFor(shapes) {
  const bytes = (n, fill) => new Uint8Array(n).fill(fill);
  const id = (fill) => bytes(32, fill);
  const [author, replier, root, parentReply, liker] = [1, 2, 3, 4, 5].map(id);
  const item = (n) => ({ url: `ipfs://bafyselftest${n}`, sha256: bytes(32, 10 + n), fingerprint: bytes(8, 20 + n), kind: n % 3 });
  const { cut } = shapes;
  const writes = [
    ['post', 'post', shapes.post({ content: 'self-test post' }), null],
    ['post (tagged, mention)', 'post', shapes.post({ content: 'tagged', ...shapes.tags(['selftest']), ...shapes.mentions([replier]) }), null],
    ['reply (mention)', 'reply', shapes.reply({ content: 'hi', rootPostId: root, parentOwnerId: author, ...shapes.mentions([liker]) }), null],
    ['post (one media item)', 'post', shapes.post({ content: 'media', ...shapes.media([item(1)]) }), null],
    ['post (media only)', 'post', shapes.post(shapes.media([item(2)])), null],
    ['quote', 'post', shapes.post({ content: 'quote', quotedPostId: root, quotedPostOwnerId: author }), null],
    ['bare repost', 'post', shapes.post({ quotedPostId: root, quotedPostOwnerId: author }), null],
    ['reply (top-level)', 'reply', shapes.reply({ content: 'reply', rootPostId: root, parentOwnerId: author }), null],
    ['reply (top-level, named by its root owner)', 'reply', shapes.reply({ content: 'reply', rootPostId: root, rootOwnerId: author }), null],
    ['reply (nested)', 'reply', shapes.reply({ content: 'nested', rootPostId: root, rootOwnerId: author, replyToReplyId: parentReply, parentOwnerId: replier }), null],
    ['reply (one media item)', 'reply', shapes.reply({ content: 'reply media', rootPostId: root, parentOwnerId: author, ...shapes.media([item(3)]) }), null],
    ['like', 'like', { postId: root, postAuthor: author }, null],
    ['like (a tagged post\'s tag)', 'like', { postId: root, ...shapes.tags(['selftest']), postAuthor: author }, null],
    ['likeReply', 'likeReply', shapes.likeReply({ replyId: parentReply, replyAuthor: replier }), null],
    ['report (post)', 'report', shapes.report({ postId: root, targetOwnerId: author }), null],
    ['report (reply, something else + note)', 'report', shapes.report({ replyId: parentReply, targetOwnerId: replier, reason: 8, note: 'why' }), null],
    ['fit: a v12-shaped post', 'post', shapes.fit('post', { content: 'fitted' }), null],
    ['fit: a v12-shaped top-level reply', 'reply', shapes.fit('reply', { content: 'fitted', rootPostId: root, parentOwnerId: author }), null],
    ['fit: a v12-shaped reply like', 'likeReply', shapes.fit('likeReply', { replyId: parentReply, replyAuthor: replier }), null],
  ];
  if (shapes.schemas.post.properties.deleted) {
    writes.push(
      ['post tombstone (tags kept)', 'post', shapes.post({ deleted: true, ...shapes.tags(['selftest']) }), null],
      ['reply tombstone (linkage kept)', 'reply', shapes.reply({ deleted: true, rootPostId: root, parentOwnerId: author }), null],
    );
  }
  if (shapes.schemas.post.canBeDeleted === false) {
    // The cleanup's tombstones (scripts/test-content-cleanup.mjs), built off stored documents as toJSON() reads them back.
    const b58 = (bytes) => bs58.encode(bytes);
    const storedPost = { ...shapes.post({ content: 'stored', ...shapes.tags(['selftest']), ...shapes.mentions([replier]) }), quotedPostId: b58(root), quotedPostOwnerId: b58(author) };
    if (storedPost.mentionedUserIds) storedPost.mentionedUserIds = storedPost.mentionedUserIds.map(b58);
    else if (storedPost.mentionedUserId) storedPost.mentionedUserId = b58(storedPost.mentionedUserId);
    const storedReply = Object.fromEntries(Object.entries(shapes.reply({ content: 'stored', rootPostId: root, rootOwnerId: author, replyToReplyId: parentReply, parentOwnerId: replier }))
      .map(([key, value]) => [key, value instanceof Uint8Array ? b58(value) : value]));
    writes.push(
      ['cleanup tombstone of a stored tagged quote', 'post', shapes.tombstone('post', storedPost), null],
      ['cleanup tombstone of a stored nested reply', 'reply', shapes.tombstone('reply', storedReply), null],
    );
  }
  if (cut.mediaArrays) {
    writes.push(
      ['post (four media items)', 'post', shapes.post({ content: 'four', ...shapes.media([1, 2, 3, 4].map(item)) }), null],
      ['post (two URLs, one digest)', 'post', shapes.post({ content: 'broken', ...shapes.media([item(1), item(2)]), mediaDigests: bytes(40, 9) }), 'media'],
    );
  }
  if (cut.liveMarker) {
    writes.push(
      ['post tombstone still live', 'post', { deleted: true, live: true }, 'live'],
      ['post without live', 'post', { content: 'no live' }, 'live'],
    );
  }
  if (!cut.storedReplyOwners) {
    writes.push(['reply (nested, its owners left to the windows)', 'reply', shapes.reply({ content: 'nested', rootPostId: root, replyToReplyId: parentReply }), null]);
  }
  if (cut.mentionArray) {
    writes.push(
      ['post (three mentions)', 'post', shapes.post({ content: 'hi all', ...shapes.mentions([author, replier, liker]) }), null],
      ['post (eight mentions)', 'post', shapes.post({ content: 'hi all', ...shapes.mentions([1, 2, 3, 4, 5, 6, 7, 8].map((n) => id(30 + n))) }), null],
      ['reply (two mentions)', 'reply', shapes.reply({ content: 'hi both', rootPostId: root, replyToReplyId: parentReply, ...shapes.mentions([author, liker]) }), null],
    );
  }
  if (cut.tagArray) {
    const content = 'gm #dash $DASH #news #gm';
    const four = shapes.contentTags(content);
    writes.push(
      ['post (four tags, from its content)', 'post', shapes.post({ content, ...shapes.tags(four) }), null],
      ['like (the four-tag post\'s list)', 'like', { postId: root, ...shapes.tags(four), postAuthor: author }, null],
      ['post tombstone (four tags kept)', 'post', shapes.post({ deleted: true, ...shapes.tags(four) }), null],
    );
  }
  {
    // A private write names the feed it was sealed to from v17 (privateFields drops it before).
    const sealed = shapes.privateFields({ encryptedContent: bytes(48, 5), keyGeneration: 1, nonce: bytes(24, 6), feed: 3 });
    writes.push(
      ['private post (teaser, sealed fields)', 'post', shapes.post({ content: '🔒', ...sealed }), null],
      ['private post (no teaser)', 'post', shapes.post({ ...sealed }), null],
      ['private reply (teaser, sealed fields)', 'reply', shapes.reply({ content: '🔒', rootPostId: root, parentOwnerId: author, ...sealed }), null],
    );
  }
  if (cut.privateFeeds) {
    const { feed, ...triple } = shapes.privateFields({ encryptedContent: bytes(48, 5), keyGeneration: 1, nonce: bytes(24, 6), feed: 3 });
    writes.push(
      ['private post without its feed', 'post', shapes.post({ content: '🔒', ...triple }), 'private'],
      ['private reply without its feed', 'reply', shapes.reply({ content: '🔒', rootPostId: root, parentOwnerId: author, ...triple }), 'private'],
      ['a feed alone on a post', 'post', shapes.post({ content: 'x', feed }), 'private'],
    );
  }
  if (cut.replyLiveMarker) {
    writes.push(
      ['reply without live', 'reply', { content: 'no live', rootPostId: root }, 'live'],
      ['reply tombstone still live', 'reply', { deleted: true, live: true, rootPostId: root }, 'live'],
      ['reply with nothing to say', 'reply', shapes.reply({ rootPostId: root }), 'notEmpty'],
    );
  }
  if (cut.rootOwner) {
    writes.push(['reply (forged: top-level parent other than the root owner)', 'reply', shapes.reply({ content: 'forged', rootPostId: root, rootOwnerId: author, parentOwnerId: liker }), 'parentIsRoot']);
  }
  if (cut.profileReports) {
    writes.push(
      ['report (profile, about 1)', 'report', shapes.report({ about: 1, targetOwnerId: author }), null],
      ['report (private post, box)', 'report', shapes.report({ postId: root, targetOwnerId: author, box: bytes(400, 7) }), null],
      ['report (reason 9, no note)', 'report', shapes.report({ postId: root, targetOwnerId: author, reason: 9 }), null],
      ['report (profile with a box)', 'report', shapes.report({ about: 1, targetOwnerId: author, box: bytes(400, 7) }), 'boxOnContent'],
    );
  }
  return writes;
}

/** Pure expectations about the builders themselves (throws, query prefixes, cut flags). */
function builderExpectations(shapes, version) {
  const { cut } = shapes;
  const id = new Uint8Array(32).fill(6);
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  // v14 keeps every v13 shape but its replies; v15 keeps every v14 shape, v16 every v15 one but the tags, v17 every v16 one.
  const v14 = ['v14', 'v15', 'v16', 'v17'].includes(version);
  const fromV13 = version === 'v13' || v14;
  const item = { url: 'ipfs://bafy', sha256: new Uint8Array(32), fingerprint: new Uint8Array(8) };
  return [
    ['the cut flags are the ones this cut declares', JSON.stringify(cut) === JSON.stringify(expectedCut(version))],
    ['a nested reply without its root owner throws on v13 only', throws(() => shapes.reply({ rootPostId: id, replyToReplyId: id, parentOwnerId: id })) === (version === 'v13')],
    ['a reply stores no owner from v14', (shapes.reply({ rootPostId: id, parentOwnerId: id }).parentOwnerId === undefined) === v14],
    ['a reply like without its author throws up to v12 only', throws(() => shapes.likeReply({ replyId: id })) === !fromV13],
    ['two media items throw up to v12 only', throws(() => shapes.media([item, item])) === !fromV13],
    ['five media items always throw', throws(() => shapes.media([item, item, item, item, item]))],
    ['a profile report throws up to v12 only', throws(() => shapes.report({ about: 1, targetOwnerId: id })) === !fromV13],
    ['a tombstone stays without live', shapes.post({ deleted: true }).live === undefined],
    ['an author tombstone of a stored post throws on v10 only (real deletes), keeps no live or content after',
      version === 'v10' ? throws(() => shapes.tombstone('post', {}))
        : JSON.stringify(shapes.tombstone('post', shapes.post({ content: 'x', ...shapes.tags(['t']) }))) === JSON.stringify({ deleted: true, ...shapes.tags(['t']) })],
    ['the author timeline pins live first from v13',
      JSON.stringify(shapes.ownerPosts({ where: [['$ownerId', '==', 'A']], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']] }))
        === JSON.stringify(fromV13
          ? { where: [['live', '==', true], ['$ownerId', '==', 'A']], orderBy: [['live', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']] }
          : { where: [['$ownerId', '==', 'A']], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']] })],
    ['the author reply read pins live == true first from v17, as it is before',
      JSON.stringify(shapes.ownerReplies({ where: [['$ownerId', '==', 'A']], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']] }))
        === JSON.stringify(cut.replyLiveMarker
          ? { where: [['live', '==', true], ['$ownerId', '==', 'A']], orderBy: [['live', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']] }
          : { where: [['$ownerId', '==', 'A']], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']] })],
    ['an order on $createdAt alone is left as it is', JSON.stringify(shapes.ownerPostsOrderBy([['$createdAt', 'asc']])) === '[["$createdAt","asc"]]'],
    ['blocks resolve to the social contract up to v12, to the blocks contract from v13',
      shapes.contractFor('block', { social: 'S', blocks: 'B' }) === (fromV13 ? 'B' : 'S') && shapes.contractFor('follow', { social: 'S', blocks: 'B' }) === 'S'],
    ['blocks without a blocks contract throw from v13', throws(() => shapes.contractFor('blockFollow', { social: 'S' })) === fromV13],
    // v17 lowers it to 20M (D41).
    ['a report pays an action fee from v13 (50M credits to the moderators; 20M on v17)', fromV13 ? shapes.actionFee('report')?.moderators === (cut.privateFeeds ? 20_000_000n : 50_000_000n) : shapes.actionFee('report') === null],
    ['no mention writes nothing', JSON.stringify(shapes.mentions([])) === '{}'],
    ['one mention is mentionedUserId up to v14, a one-element mentionedUserIds on v15',
      cut.mentionArray ? shapes.mentions([id]).mentionedUserIds?.[0] === id : shapes.mentions([id]).mentionedUserId === id],
    ['two mentions throw up to v14 only', throws(() => shapes.mentions([id, id])) === !cut.mentionArray],
    ['nine mentions always throw', throws(() => shapes.mentions(Array.from({ length: 9 }, () => id)))],
    ['the checker calls a repeated, empty or ninth mention wrong on v15',
      !cut.mentionArray || [[id, id], [], Array.from({ length: 9 }, (_, n) => new Uint8Array(32).fill(n + 1))]
        .every((list) => shapes.check('post', shapes.post({ content: 'x', mentionedUserIds: list })).some((problem) => problem.startsWith('post.mentionedUserIds')))],
    ['the mention read pins one element with contains on v15, the identifier with == before',
      JSON.stringify(shapes.mentionsOf('B', 5))
        === JSON.stringify(cut.mentionArray
          ? { where: [['mentionedUserIds', 'contains', 'B'], ['$createdAt', '>', 5]], orderBy: [['$createdAt', 'desc']] }
          : { where: [['mentionedUserId', '==', 'B'], ['$createdAt', '>', 5]], orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'desc']] })],
    ['no tag writes nothing', JSON.stringify(shapes.tags([])) === '{}'],
    ['one tag is hashtag up to v15, a one-element tags list on v16',
      JSON.stringify(shapes.tags(['a'])) === (cut.tagArray ? '{"tags":["a"]}' : '{"hashtag":"a"}')],
    ['two tags throw up to v15 only', throws(() => shapes.tags(['a', 'b'])) === !cut.tagArray],
    ['five tags always throw', throws(() => shapes.tags(['a', 'b', 'c', 'd', 'e']))],
    ['the tag property and limit are hashtag and 1 up to v15, tags and 4 on v16',
      shapes.tagField === (cut.tagArray ? 'tags' : 'hashtag') && shapes.tagMax === (cut.tagArray ? 4 : 1)],
    ['a stored post\'s tags read back off either spelling, [] when untagged',
      JSON.stringify(shapes.storedTags(shapes.tags(['a']))) === '["a"]' && JSON.stringify(shapes.storedTags({})) === '[]'
        && JSON.stringify(shapes.storedTags({ [shapes.tagField]: cut.tagArray ? ['a', 'b'] : 'a' })) === (cut.tagArray ? '["a","b"]' : '["a"]')],
    ['the content rule takes the hashtags in order, then the cashtags, distinct: the first up to v15, all four on v16',
      JSON.stringify(shapes.contentTags('gm #B $dash #a #b #c')) === (cut.tagArray ? '["b","a","c","dash_cashtag"]' : '["b"]')
        && JSON.stringify(shapes.contentTags('just $DASH and $btc')) === (cut.tagArray ? '["dash_cashtag","btc_cashtag"]' : '["dash_cashtag"]')
        && JSON.stringify(shapes.contentTags('no tags here')) === '[]'],
    ['the content rule names no tag in a non-ASCII word nor one past the ceiling, never a prefix of either',
      JSON.stringify(shapes.contentTags(`#café #naïve #日本 $DASHé #${'a'.repeat(62)} #ok`)) === '["ok"]'],
    ['a content naming five tags throws on v16 (the client refuses it), indexes its first tag before',
      cut.tagArray ? throws(() => shapes.contentTags('#a #b #c #d $e')) : JSON.stringify(shapes.contentTags('#a #b #c #d $e')) === '["a"]'],
    ['the checker calls a repeated, empty, fifth or malformed tag wrong on v16',
      !cut.tagArray || [['a', 'a'], [], ['a', 'b', 'c', 'd', 'e'], ['UPPER'], ['x'.repeat(62)]]
        .every((list) => shapes.check('post', shapes.post({ content: 'x', tags: list })).some((problem) => problem.startsWith('post.tags')))],
    ['the tag pin is contains on v16, == before', JSON.stringify(shapes.tagPin('t')) === (cut.tagArray ? '["tags","contains","t"]' : '["hashtag","==","t"]')],
    ['the tagged-post read orders by $createdAt alone on v16 (live == true first on v17), by the tag first before',
      JSON.stringify(shapes.taggedPosts('t', 5))
        === JSON.stringify(cut.tagArray
          ? { where: [...(cut.liveTagIndex ? [['live', '==', true]] : []), ['tags', 'contains', 't'], ['$createdAt', '>', 5]], orderBy: [['$createdAt', 'desc']] }
          : { where: [['hashtag', '==', 't'], ['$createdAt', '>', 5]], orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']] })],
    ['the global timeline read pins live == true first from v17, and is as given before',
      JSON.stringify(shapes.timelinePosts({ where: [['$createdAt', '>', 5]], orderBy: [['$createdAt', 'desc']], limit: 20 }))
        === JSON.stringify({ where: [...(cut.liveTimeline ? [['live', '==', true]] : []), ['$createdAt', '>', 5]], orderBy: [['$createdAt', 'desc']], limit: 20 })
        && JSON.stringify(shapes.timelinePosts({ orderBy: [['$createdAt', 'desc']] }).where) === JSON.stringify(cut.liveTimeline ? [['live', '==', true]] : [])],
    ['a thread read (repliesOf) pins live == true first from v17, and is as given before',
      JSON.stringify(shapes.threadWhere([['rootPostId', '==', 'R']])) === JSON.stringify([...(cut.liveThread ? [['live', '==', true]] : []), ['rootPostId', '==', 'R']])],
    ['a reply carries live: true from v17 and a tombstone never does',
      (shapes.reply({ rootPostId: id, parentOwnerId: id, content: 'x' }).live === true) === cut.replyLiveMarker
        && shapes.reply({ deleted: true, rootPostId: id, parentOwnerId: id }).live === undefined
        && shapes.reply({ rootPostId: id, parentOwnerId: id, live: true }).live === true],
    ['a private write names its feed from v17 (a missing one throws) and drops it before',
      throws(() => shapes.privateFields({ encryptedContent: id, keyGeneration: 1, nonce: id })) === cut.privateFeeds
        && JSON.stringify(Object.keys(shapes.privateFields({ encryptedContent: id, keyGeneration: 1, nonce: id, feed: 2 }))) === (cut.privateFeeds ? '["encryptedContent","keyGeneration","nonce","feed"]' : '["encryptedContent","keyGeneration","nonce"]')],
    ['the checker calls a private write with three of the four fields wrong from v17',
      !cut.privateFeeds || shapes.check('post', shapes.post({ content: 'x', encryptedContent: id, keyGeneration: 1, nonce: id })).some((problem) => problem.includes('(private)'))],
    ['a tag ranking groups its posts under the pin, the trending tags by the tag property with no where',
      JSON.stringify(shapes.tagRanking('t')) === JSON.stringify({ groupBy: 'postId', where: [shapes.tagPin('t')] })
        && JSON.stringify(shapes.tagRanking()) === JSON.stringify({ groupBy: shapes.tagField })],
    ['a tag count pins the tag, and the post with postId ==',
      JSON.stringify(shapes.tagLikesWhere('t', 'P')) === JSON.stringify([shapes.tagPin('t'), ['postId', '==', 'P']])
        && JSON.stringify(shapes.tagLikesWhere('t')) === JSON.stringify([shapes.tagPin('t')])],
  ];
}

async function selfTest() {
  const { DataContract, Document, PlatformVersion, ensureInitialized } = await import('@dashevo/evo-sdk');
  await ensureInitialized();
  const platformVersion = PlatformVersion.latest();
  const placeholder = '11111111111111111111111111111111';
  const blocks = DataContract.fromJSON({ $formatVersion: '1', id: placeholder, ownerId: placeholder, version: 1, documentSchemas: readContract('yappr-blocks-contract.json') }, true, platformVersion);
  let failures = 0;
  const report = (ok, label, detail = '') => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };
  {
    // Recovery reads must follow each v13 report index's own property order.
    const v13Indices = Object.fromEntries(readContract('yappr-social-contract-v13.json').documentSchemas.report.indices
      .map((index) => [index.name, index.properties.map((entry) => Object.keys(entry)[0])]));
    const [target, reporter] = [new Uint8Array(32).fill(4), bs58.encode(new Uint8Array(32).fill(5))];
    for (const [index, data] of [['byPost', { postId: target }], ['byReply', { replyId: target }], ['byTarget', { about: 1, targetOwnerId: target }]]) {
      const where = reportRecoveryWhere({ ...data, reason: 1 }, reporter);
      const ok = JSON.stringify(where.map(([field]) => field)) === JSON.stringify(v13Indices[index]) && where.every(([, op]) => op === '==');
      report(ok, `v13 a timed-out report is recovered on ${index}`, ok ? '' : JSON.stringify(where));
    }
  }
  for (const version of SOCIAL_CUTS) {
    const file = `yappr-social-contract-${version}.json`;
    const source = readContract(file);
    const shapes = socialShapes(source);
    console.log(`\n${file}: ${JSON.stringify(shapes.cut)}`);
    for (const [label, ok] of builderExpectations(shapes, version)) report(ok, `${version} ${label}`);
    let contract;
    try {
      contract = DataContract.fromJSON({ $formatVersion: '1', id: placeholder, ownerId: placeholder, version: 1, documentSchemas: source.documentSchemas, config: source.config, tokens: source.tokens }, true, platformVersion);
    } catch (e) {
      // v14 needs the 5.0.0-beta.3 SDK (countPresent, deleteConstraints, a derived skip property),
      // v15 the 5.0.0-beta.4 one (shorthands, a non-transferable token).
      report(false, `${version} parses with the installed SDK`, String(e?.message ?? e).slice(0, 160));
      // The writes are still judged by the shape checker alone (the 10422 rules need the parsed contract).
      for (const [label, docType, data, expected] of writesFor(shapes)) {
        if (expected !== null) continue;
        const problems = shapes.check(docType, data);
        report(problems.length === 0, `${version} ${label} (shape checker only)`, problems.join('; '));
      }
      continue;
    }
    for (const [label, docType, data, expected] of writesFor(shapes)) {
      const problems = shapes.check(docType, data);
      let violation = null;
      let serializes = true;
      try {
        const document = Document.fromObject({
          $formatVersion: '0', $id: new Uint8Array(32).fill(9), $ownerId: new Uint8Array(32).fill(8), $dataContractId: contract.id.toBytes(), $type: docType,
          $revision: 1n, $createdAt: Date.now(), $updatedAt: Date.now(), ...data,
        }, platformVersion);
        violation = contract.checkDocumentPropertyConstraints(document)?.rule ?? null;
        if (expected === null) document.toBytes(contract, platformVersion);
      } catch (e) {
        serializes = false;
        violation = `threw: ${String(e?.message ?? e).slice(0, 120)}`;
      }
      const ok = expected === null
        ? problems.length === 0 && violation === null && serializes
        : violation === expected && problems.some((problem) => problem.includes(expected));
      report(ok, `${version} ${label}`, ok ? (expected ? `10422 ${violation}` : '') : `checker ${JSON.stringify(problems)}, rules ${violation}`);
    }
    if (!shapes.cut.blocksInSocial) {
      for (const [docType, data] of [['block', { blockedId: new Uint8Array(32).fill(3) }], ['blockFollow', { followedBlockers: [new Uint8Array(32).fill(3)] }]]) {
        let serializes = true;
        try {
          Document.fromObject({ $formatVersion: '0', $id: new Uint8Array(32).fill(9), $ownerId: new Uint8Array(32).fill(8), $dataContractId: blocks.id.toBytes(), $type: docType, $revision: 1n, $createdAt: Date.now(), $updatedAt: Date.now(), ...data }, platformVersion)
            .toBytes(blocks, platformVersion);
        } catch (e) {
          serializes = String(e?.message ?? e).slice(0, 160);
        }
        report(serializes === true, `${version} ${docType} serializes under the blocks contract`, serializes === true ? '' : serializes);
      }
    }
  }
  console.log(failures === 0 ? '\nsocial-shapes self-test: ALL PASSED' : `\nsocial-shapes self-test: ${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--self-test')) {
    console.error('Usage: node scripts/social-shapes.mjs --self-test');
    process.exit(1);
  }
  selfTest().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
