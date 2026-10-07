/**
 * The social documents the Node scripts write, built for the cut a contract
 * file declares (docs/SOCIAL_V10.md to docs/SOCIAL_V13.md). Every switch reads
 * the schemas, never the file's name, so one builder serves v10 to v13 and a
 * v10–v12 document comes out exactly as the scripts wrote it before v13:
 *
 *   - `live` (v13): every post that is not a tombstone carries `live: true`, a
 *     tombstone leaves it out, and `post.ownerAndTime` is `[live, $ownerId,
 *     $createdAt]` (skipIfAbsent), so its reads pin `live == true` first;
 *   - `reply.rootOwnerId` (v13): the root post's owner, `where`-bound to it;
 *     a top-level reply's `parentOwnerId` must be that owner (`parentIsRoot`);
 *   - `likeReply.replyAuthor` (v10–v12 only): v13 likes a reply by its id;
 *   - media: v10–v12 carry one `mediaUrl` with its `mediaHash` and
 *     `mediaFingerprint`; v13 carries 1–4 items as `mediaUrls`, `mediaDigests`
 *     (sha256 ‖ fingerprint, 40 B each) and `mediaKinds` (1 B each);
 *   - reports (v13): a profile report is `about: 1` with no post or reply,
 *     a post or reply report may carry the moderators' `box`, and every
 *     report pays a moderators action fee on create;
 *   - blocks (v13): `block`, `blockFilter` and `blockFollow` live in the
 *     standalone blocks contract, not in social.
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

/**
 * The builders, query prefixes and checker for one social cut. `contract` is a
 * contract JSON (`{ documentSchemas }`) or its `documentSchemas`.
 */
export function socialShapes(contract) {
  const schemas = contract.documentSchemas ?? contract;
  const declares = (type, property) => schemas[type]?.properties?.[property] !== undefined;
  const cut = Object.freeze({
    liveMarker: declares('post', 'live'),
    rootOwner: declares('reply', 'rootOwnerId'),
    replyAuthor: declares('likeReply', 'replyAuthor'),
    mediaArrays: declares('post', 'mediaUrls'),
    profileReports: declares('report', 'about'),
    blocksInSocial: schemas.block !== undefined,
  });

  /** A post create or replace: `live: true` unless it is a tombstone (`deleted` present). */
  const post = (data) => (cut.liveMarker && data.deleted === undefined && data.live === undefined ? { ...data, live: true } : data);

  /**
   * A reply's linkage. A top-level reply answers its root post, so its
   * `parentOwnerId` and (v13) `rootOwnerId` are the same identity and either
   * names both. A nested reply names its parent reply's owner in
   * `parentOwnerId` and, on v13, the root post's owner in `rootOwnerId`. A
   * forged pair (a refusal probe) is passed through as given.
   */
  const reply = ({ rootPostId, rootOwnerId, replyToReplyId, parentOwnerId, ...rest }) => {
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
    }
    if (docType === 'post' && cut.liveMarker) {
      if (data.deleted !== undefined && data.live !== undefined) problems.push('a post tombstone carries live');
      if (data.deleted === undefined && data.live !== true) problems.push('a post that is not a tombstone lacks live: true');
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

  return Object.freeze({
    schemas, cut, post, reply, likeReply, media, report, fit,
    ownerPostsWhere, ownerPostsOrderBy, ownerPosts, contractFor, check,
    actionFee: (docType) => actionFeeOf(schemas, docType),
  });
}

/** The types the blocks contract holds from v13 on. */
export const BLOCK_TYPES = ['block', 'blockFilter', 'blockFollow'];

// ---- Self-test ------------------------------------------------------------------

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SOCIAL_CUTS = ['v10', 'v11', 'v12', 'v13'];
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
    ['post (tagged, mention)', 'post', shapes.post({ content: 'tagged', hashtag: 'selftest', mentionedUserId: replier }), null],
    ['post (one media item)', 'post', shapes.post({ content: 'media', ...shapes.media([item(1)]) }), null],
    ['post (media only)', 'post', shapes.post(shapes.media([item(2)])), null],
    ['quote', 'post', shapes.post({ content: 'quote', quotedPostId: root, quotedPostOwnerId: author }), null],
    ['bare repost', 'post', shapes.post({ quotedPostId: root, quotedPostOwnerId: author }), null],
    ['reply (top-level)', 'reply', shapes.reply({ content: 'reply', rootPostId: root, parentOwnerId: author }), null],
    ['reply (top-level, named by its root owner)', 'reply', shapes.reply({ content: 'reply', rootPostId: root, rootOwnerId: author }), null],
    ['reply (nested)', 'reply', shapes.reply({ content: 'nested', rootPostId: root, rootOwnerId: author, replyToReplyId: parentReply, parentOwnerId: replier }), null],
    ['reply (one media item)', 'reply', shapes.reply({ content: 'reply media', rootPostId: root, parentOwnerId: author, ...shapes.media([item(3)]) }), null],
    ['like', 'like', { postId: root, postAuthor: author }, null],
    ['likeReply', 'likeReply', shapes.likeReply({ replyId: parentReply, replyAuthor: replier }), null],
    ['report (post)', 'report', shapes.report({ postId: root, targetOwnerId: author }), null],
    ['report (reply, something else + note)', 'report', shapes.report({ replyId: parentReply, targetOwnerId: replier, reason: 8, note: 'why' }), null],
    ['fit: a v12-shaped post', 'post', shapes.fit('post', { content: 'fitted' }), null],
    ['fit: a v12-shaped top-level reply', 'reply', shapes.fit('reply', { content: 'fitted', rootPostId: root, parentOwnerId: author }), null],
    ['fit: a v12-shaped reply like', 'likeReply', shapes.fit('likeReply', { replyId: parentReply, replyAuthor: replier }), null],
  ];
  if (shapes.schemas.post.properties.deleted) {
    writes.push(
      ['post tombstone (hashtag kept)', 'post', shapes.post({ deleted: true, hashtag: 'selftest' }), null],
      ['reply tombstone (linkage kept)', 'reply', shapes.reply({ deleted: true, rootPostId: root, parentOwnerId: author }), null],
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
  const v13 = version === 'v13';
  const item = { url: 'ipfs://bafy', sha256: new Uint8Array(32), fingerprint: new Uint8Array(8) };
  return [
    ['the cut flags are all v13 or all earlier', Object.entries(cut).every(([flag, on]) => (['blocksInSocial', 'replyAuthor'].includes(flag) ? on !== v13 : on === v13))],
    ['a nested reply without its root owner throws on v13 only', throws(() => shapes.reply({ rootPostId: id, replyToReplyId: id, parentOwnerId: id })) === v13],
    ['a reply like without its author throws up to v12 only', throws(() => shapes.likeReply({ replyId: id })) === !v13],
    ['two media items throw up to v12 only', throws(() => shapes.media([item, item])) === !v13],
    ['five media items always throw', throws(() => shapes.media([item, item, item, item, item]))],
    ['a profile report throws up to v12 only', throws(() => shapes.report({ about: 1, targetOwnerId: id })) === !v13],
    ['a tombstone stays without live', shapes.post({ deleted: true }).live === undefined],
    ['the author timeline pins live first on v13 only',
      JSON.stringify(shapes.ownerPosts({ where: [['$ownerId', '==', 'A']], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']] }))
        === JSON.stringify(v13
          ? { where: [['live', '==', true], ['$ownerId', '==', 'A']], orderBy: [['live', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']] }
          : { where: [['$ownerId', '==', 'A']], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']] })],
    ['an order on $createdAt alone is left as it is', JSON.stringify(shapes.ownerPostsOrderBy([['$createdAt', 'asc']])) === '[["$createdAt","asc"]]'],
    ['blocks resolve to the social contract up to v12, to the blocks contract on v13',
      shapes.contractFor('block', { social: 'S', blocks: 'B' }) === (v13 ? 'B' : 'S') && shapes.contractFor('follow', { social: 'S', blocks: 'B' }) === 'S'],
    ['v13 blocks without a blocks contract throw', throws(() => shapes.contractFor('blockFollow', { social: 'S' })) === v13],
    ['a report pays an action fee on v13 only (50M credits to the moderators)', v13 ? shapes.actionFee('report')?.moderators === 50_000_000n : shapes.actionFee('report') === null],
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
    const contract = DataContract.fromJSON({ $formatVersion: '1', id: placeholder, ownerId: placeholder, version: 1, documentSchemas: source.documentSchemas, config: source.config, tokens: source.tokens }, true, platformVersion);
    console.log(`\n${file}: ${JSON.stringify(shapes.cut)}`);
    for (const [label, ok] of builderExpectations(shapes, version)) report(ok, `${version} ${label}`);
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
