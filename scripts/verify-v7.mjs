/**
 * Registration-day battery for **contract v7**
 * (`contracts/yappr-social-contract-v7.json`), run against a freshly registered
 * contract on a 4.2.0-beta.2 devnet. All the machinery — devnet SDK with its
 * quorum-rotation reconnect, readback-decided write outcomes, strict
 * wrong-reason-fails rejections, the PASS/FAIL ledger and the CLI — is
 * {@link file://./verify-lib.mjs}.
 *
 * Only the two invariants v7 moved from the client to consensus are proved here
 * (E = system-field `propertyAgreement`, F = `immutable` properties), plus one
 * end-to-end like lifecycle (G) over the surfaces those agreements touch. The
 * query surface is unchanged from the previous cut and was proved live there.
 * The case table and the environment are in docs/PLATFORM_BETA2_UPGRADE.md and
 * docs/SOCIAL_CONTRACT.md; both bots need YAPP or the run aborts early.
 *
 * Platform behaviours this leans on: js `documents.create()` may THROW
 * post-broadcast for indexOnly types even when the write landed (acceptance is
 * always readback); a DAPI 504 on the confirmation wait is not a rejection; and
 * the 40105 duplicate probe fires BEFORE 40120/40127, so every agreement
 * violation targets a post its signer has not yet liked.
 *
 * There is NO default contract id — v7 only exists after registration day.
 *
 *   node scripts/verify-v7.mjs --self-test        # or --dry-run; no network
 *   NETWORK=devnet node scripts/verify-v7.mjs --contract <freshV7Id> \
 *        [--bot 0] [--bot2 1] [--owner <idA>] [--owner2 <idB>] [--only e1,f2]
 */
import bs58 from 'bs58';
import { describeErr } from './owner-keys.mjs';
import {
  DUPLICATE_UNIQUE,
  PROPERTY_MISMATCH,
  TOKEN_COST,
  attemptCreate,
  attemptDeleteByValues,
  asBase58,
  attemptReplace,
  buildDocument,
  check,
  countBy,
  defined,
  entryExists,
  expectAccepted,
  expectRejected,
  fetchDocument,
  followData,
  likeData,
  likeReplyData,
  randomIdBytes,
  readback,
  repostData,
  runBattery,
} from './verify-lib.mjs';

/**
 * A structure-level refusal of an undeclared property (JsonSchemaError, basic
 * code 10101). The wasm document builder may refuse it locally first, which is
 * the same verdict one layer up, so both are matched. Deliberately does NOT
 * match the 401xx state codes: a 40127/40128 here would mean the column still
 * exists and something else refused the write.
 */
const UNKNOWN_PROPERTY =
  /\bcode"?\s*[=:]\s*10101\b|additional properties are not allowed|was unexpected|\bunknown property\b|property .{0,40}not (found|defined) in/i;

/** A frozen property was changed, added or dropped by a replace (40128). */
const IMMUTABLE_CHANGED = /\bcode"?\s*[=:]\s*40128\b|is immutable and cannot be changed/i;

/** Table marker: this row's write must LAND rather than be refused. */
const ACCEPT = Symbol('accept');

/**
 * Runs `[label, () => outcome, ACCEPT | pattern]` rows in order. Rejection rows
 * are order-independent by construction — a refused write leaves the chain
 * untouched — so the table is as strong as the cases written out longhand.
 */
async function runTable(rows) {
  for (const [label, run, expectation] of rows) {
    const outcome = await run();
    if (expectation === ACCEPT) expectAccepted(label, outcome);
    else expectRejected(label, outcome, expectation);
  }
}

// ---- v7 document shapes -----------------------------------------------------
//
// NO `author` (the like agreements bind to `$ownerId`), and every optional
// property is dropped when undefined — untagged means `hashtag` is ABSENT, not
// empty.

const postData = ({ content = 'v7 battery post', ...optional } = {}) =>
  defined({ content, language: 'en', ...optional });

const replyData = ({ content = 'v7 battery reply', ...linkage } = {}) =>
  defined({ content, ...linkage });

// ---- Shared fixtures --------------------------------------------------------

/** One fixture create: a failure is logged and reported as `null`, never thrown. */
async function createFixture(ctx, who, docType, data, label) {
  const created = await attemptCreate(ctx.sdk, who, { contractId: ctx.contractId, docType, data, tokenCost: TOKEN_COST[docType] });
  if (created.ok) return created.id;
  console.log(`     (could not create ${label}: ${(created.error ?? '').slice(0, 200)})`);
  return null;
}

/**
 * A like by bot A on `postId`, with whatever agreement-bound values the caller
 * wants to probe. Shared by e2 and g1 so the create tuple and the
 * delete-by-values tuple cannot drift apart — which is the very thing g1's
 * unlike asserts.
 */
function likeOn(ctx, postId, data) {
  return attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({ postId: bs58.decode(postId), ...data }),
    tokenCost: TOKEN_COST.like,
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', postId, ctx.botA.ownerId),
  });
}

/** The agreement-bound values a CORRECT like on a tagged fixture post carries. */
const agreedLike = (ctx) => ({ hashtag: ctx.tag, postAuthor: bs58.decode(ctx.botB.ownerId) });

/** The immutable set `ensureOwnMutablePost` writes; every replace must repeat it verbatim. */
const immutablesOf = (ctx, quoted) => ({
  language: 'en',
  hashtag: ctx.tag,
  quotedPostId: bs58.decode(quoted),
  quotedPostOwnerId: bs58.decode(ctx.botB.ownerId),
});

/** A post owned by bot B, so bot A's likes agree against a DIFFERENT identity. */
async function ensurePost(ctx, key, overrides = {}) {
  if (!ctx.posts[key]) {
    const id = await createFixture(ctx, ctx.botB, 'post', postData({ content: `battery ${key}`, ...overrides }), key);
    if (!id) return null;
    ctx.posts[key] = id;
  }
  return ctx.posts[key];
}

/** A reply by bot B on the anchor post, for the likeReply agreement. */
async function ensureReply(ctx) {
  if (ctx.replyId) return ctx.replyId;
  const rootPostId = await ensurePost(ctx, 'anchor');
  if (!rootPostId) return null;
  const data = replyData({
    content: 'battery anchor reply',
    rootPostId: bs58.decode(rootPostId),
    parentOwnerId: bs58.decode(ctx.botB.ownerId),
  });
  ctx.replyId = await createFixture(ctx, ctx.botB, 'reply', data, 'the anchor reply');
  return ctx.replyId;
}

/**
 * A post owned by bot A that only the immutability cases touch, carrying every
 * immutable property a real post can hold at once, so a rejected replace never
 * disturbs a document another case asserts against.
 */
async function ensureOwnMutablePost(ctx, key, overrides = {}) {
  if (!ctx.own[key]) {
    const quoted = await ensurePost(ctx, 'anchor');
    if (!quoted) return null;
    const data = postData({ content: `immutability fixture ${key}`, ...immutablesOf(ctx, quoted), ...overrides });
    const id = await createFixture(ctx, ctx.botA, 'post', data, key);
    if (!id) return null;
    ctx.own[key] = { id, quoted };
  }
  return ctx.own[key];
}

/**
 * `attemptCreate`, but a failure to even BUILD the document scores as the
 * rejection instead of aborting the case: wasm's `Document.fromObject` refuses
 * some malformed shapes locally, which for e1 is the same verdict one layer up.
 */
async function attemptCreateAllowingBuildFailure(sdk, who, spec) {
  try {
    return await attemptCreate(sdk, who, spec);
  } catch (e) {
    return { ok: false, error: describeErr(e) };
  }
}

/**
 * A copy of `fields` with `dropped` genuinely ABSENT — `{...f, k: undefined}`
 * still carries the key, which is a present-but-empty value rather than the
 * removal these cases assert against.
 */
function without(fields, ...dropped) {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !dropped.includes(key)));
}

/** The document's current revision, which a replace must build on top of. */
async function revisionOf(ctx, docType, id) {
  const document = await fetchDocument(ctx.sdk, ctx.contractId, docType, id);
  return document?.revision ?? 1n;
}

// ---- E-cases: system-field propertyAgreement --------------------------------

async function caseE1AuthorColumnGone(ctx) {
  console.log('\n--- e1. the attested `author` column is gone from post and reply ---');
  const author = { author: bs58.decode(ctx.botA.ownerId) };
  const post = (extra = {}) => ({ ...postData({ content: 'e1 post' }), ...extra });
  const create = (docType, data, allowBuildFailure = false) => () =>
    (allowBuildFailure ? attemptCreateAllowingBuildFailure : attemptCreate)(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId, docType, data, tokenCost: TOKEN_COST[docType],
    });

  // The accepted rows are the control: without them, the refusals would prove
  // the write path is broken rather than that the column is gone. The post rows
  // run FIRST and need no fixture, so an anchor that could not be created costs
  // the reply half of the case, not all of it.
  await runTable([
    ['e1a a post carrying the removed `author` property is refused', create('post', post(author), true), UNKNOWN_PROPERTY],
    ['e1c the same post WITHOUT `author` is accepted', create('post', post()), ACCEPT],
  ]);

  const rootPostId = await ensurePost(ctx, 'anchor');
  if (!rootPostId) {
    check('e1 reply rows', false, 'no anchor post available');
    return;
  }
  const reply = (extra = {}) => ({
    ...replyData({
      content: 'e1 reply', rootPostId: bs58.decode(rootPostId), parentOwnerId: bs58.decode(ctx.botB.ownerId),
    }),
    ...extra,
  });
  await runTable([
    ['e1b a reply carrying the removed `author` property is refused', create('reply', reply(author), true), UNKNOWN_PROPERTY],
    ['e1d the same reply WITHOUT `author` is accepted', create('reply', reply()), ACCEPT],
  ]);
}

async function caseE2LikeOwnerAgreement(ctx) {
  console.log('\n--- e2. like.postAuthor agrees with the post\'s $ownerId (40127) ---');
  const tagged = await ensurePost(ctx, 'tagged', { hashtag: ctx.tag });
  const untagged = await ensurePost(ctx, 'untagged');
  const spare = await ensurePost(ctx, 'spare', { hashtag: ctx.tag });
  if (!tagged || !untagged || !spare) {
    check('e2 like agreement', false, 'fixture posts unavailable');
    return;
  }
  const owner = bs58.decode(ctx.botB.ownerId);

  // Every violation targets a post bot A has NOT yet liked: the 40105
  // structural-uniqueness probe fires before the agreement check and would mask
  // the 40127. The liker's own id is the interesting wrong answer — before v7
  // `postAuthor` was compared against a column the POSTER wrote, so a client bug
  // could make it anything.
  await runTable([
    ['e2a a like whose postAuthor is the LIKER, not the post owner, is refused',
      () => likeOn(ctx, tagged, { hashtag: ctx.tag, postAuthor: bs58.decode(ctx.botA.ownerId) }), PROPERTY_MISMATCH],
    ['e2b a like whose postAuthor is an unrelated identity is refused',
      () => likeOn(ctx, tagged, { hashtag: ctx.tag, postAuthor: randomIdBytes() }), PROPERTY_MISMATCH],
    ['e2c the hashtag pair still holds: a wrong tag is refused',
      () => likeOn(ctx, tagged, { hashtag: `${ctx.tag}x`, postAuthor: owner }), PROPERTY_MISMATCH],
    ['e2d absence is strict: a tagged like on an UNTAGGED post is refused',
      () => likeOn(ctx, untagged, { hashtag: ctx.tag, postAuthor: owner }), PROPERTY_MISMATCH],
    ['e2e and the other direction: a hashtag-ABSENT like on a TAGGED post is refused',
      () => likeOn(ctx, spare, { postAuthor: owner }), PROPERTY_MISMATCH],
    ['e2f a like naming the post owner\'s $ownerId (and its tag) is accepted',
      () => likeOn(ctx, tagged, agreedLike(ctx)), ACCEPT],
    ['e2g the both-absent direction agrees: a hashtag-less like on an untagged post',
      () => likeOn(ctx, untagged, { postAuthor: owner }), ACCEPT],
  ]);
  if ((await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', tagged)) > 0) ctx.likedTagged = true;
}

async function caseE3LikeReplyOwnerAgreement(ctx) {
  console.log('\n--- e3. likeReply.replyAuthor agrees with the reply\'s $ownerId (40127) ---');
  const replyId = await ensureReply(ctx);
  if (!replyId) {
    check('e3 likeReply agreement', false, 'no anchor reply available');
    return;
  }
  // The duplicate probe (e3c) cannot use entry-existence: e3b's accepted like
  // already satisfies it, so a refused duplicate would score as ACCEPTED. It
  // asks the countable `byReply` axis whether a SECOND row appeared instead.
  const likeReplyOn = (replyAuthor, accepted) => () =>
    attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'likeReply',
      data: likeReplyData({ replyId: bs58.decode(replyId), replyAuthor }),
      tokenCost: TOKEN_COST.likeReply,
      accepted: accepted ?? (() => entryExists(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId, ctx.botA.ownerId)),
    });
  const secondRowAppeared = async () =>
    (await countBy(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId)) > 1;

  // e3c must follow e3b: it asserts the duplicate refusal of the like e3b made.
  await runTable([
    ['e3a a reply like whose replyAuthor is the LIKER is refused',
      likeReplyOn(bs58.decode(ctx.botA.ownerId)), PROPERTY_MISMATCH],
    ['e3b a reply like naming the reply owner\'s $ownerId is accepted',
      likeReplyOn(bs58.decode(ctx.botB.ownerId)), ACCEPT],
    ['e3c re-liking the same reply is still the structural duplicate (40105)',
      likeReplyOn(bs58.decode(ctx.botB.ownerId), secondRowAppeared), DUPLICATE_UNIQUE],
  ]);
}

async function caseE4RepostOwnerAgreement(ctx) {
  console.log('\n--- e4. repost.postOwnerId agrees with the post\'s $ownerId (NEW in v7) ---');
  const postId = await ensurePost(ctx, 'reposted');
  if (!postId) {
    check('e4 repost agreement', false, 'no post to repost');
    return;
  }
  const repostWith = (postOwnerId) => () =>
    attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'repost',
      data: repostData({ postId: bs58.decode(postId), postOwnerId }),
      tokenCost: TOKEN_COST.repost,
    });

  // Before v7 these were accepted, and they poisoned `postOwnerAndTime`: the
  // named identity saw "X reposted your post" for a post that is not theirs.
  await runTable([
    ['e4a a repost naming a third party in postOwnerId is refused', repostWith(randomIdBytes()), PROPERTY_MISMATCH],
    ['e4b a repost naming the REPOSTER in postOwnerId is refused',
      repostWith(bs58.decode(ctx.botA.ownerId)), PROPERTY_MISMATCH],
    ['e4c a repost naming the post owner\'s $ownerId is accepted',
      repostWith(bs58.decode(ctx.botB.ownerId)), ACCEPT],
  ]);
}

// ---- F-cases: immutable properties on mutable document types ----------------

async function caseF1TombstoneImmutability(ctx) {
  console.log('\n--- f1. a tombstone must carry every immutable property verbatim (40128) ---');
  ctx.f1Ran = true;
  const fixture = await ensureOwnMutablePost(ctx, 'tombstone');
  if (!fixture) {
    check('f1 tombstone immutability', false, 'no fixture post available');
    return;
  }
  const { id, quoted } = fixture;
  const revision = await revisionOf(ctx, 'post', id);
  const full = immutablesOf(ctx, quoted);
  const tombstone = (data) => () =>
    attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId, docType: 'post', id, revision, data: { content: '', deleted: true, ...data },
    });

  // Every rejection runs against the SAME stored revision. `language` is
  // REQUIRED, so DROPPING it would be refused by schema validation (10101)
  // before state validation reached 40128 — which expectRejected would score as
  // the wrong reason. Changing it is how a required frozen property reaches the
  // immutability check; the drop direction rides the optional ones (f1b/f1d).
  await runTable([
    ['f1a a tombstone that CHANGES the immutable, REQUIRED `language` is refused',
      tombstone({ ...full, language: 'fr' }), IMMUTABLE_CHANGED],
    ['f1b a tombstone that DROPS the quote reference is refused',
      tombstone(without(full, 'quotedPostId')), IMMUTABLE_CHANGED],
    ['f1c a tombstone that CHANGES the immutable `hashtag` is refused',
      tombstone({ ...full, hashtag: `${ctx.tag}x` }), IMMUTABLE_CHANGED],
    ['f1d a tombstone that DROPS the optional `hashtag` is refused too',
      tombstone(without(full, 'hashtag')), IMMUTABLE_CHANGED],
    ['f1e a tombstone carrying every immutable property verbatim is accepted', tombstone(full), ACCEPT],
  ]);
  ctx.tombstonedId = id;
  ctx.tombstonedFull = full;
}

async function caseF2DeletedIsSettableOnce(ctx) {
  console.log('\n--- f2. `deleted` is immutable-but-settable: one set, never a revert ---');
  // Lazy fixture so `--only f2` works; never re-runs a case that already ran
  // and failed, which would double-count its checks.
  if (!ctx.tombstonedId && !ctx.f1Ran) await caseF1TombstoneImmutability(ctx);
  const id = ctx.tombstonedId;
  if (!id) {
    check('f2 deleted allowance', false, 'no tombstoned post available');
    return;
  }
  const full = ctx.tombstonedFull;
  // f1e already performed the one allowed set (absent → true), which is what
  // `immutableAllowSetting: ["deleted"]` exists for. From here it is frozen.
  const replaceWith = (data) => async () =>
    attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId, docType: 'post', id, data, revision: await revisionOf(ctx, 'post', id),
    });

  await runTable([
    ['f2a flipping `deleted` back to false is refused',
      replaceWith({ content: '', deleted: false, ...full }), IMMUTABLE_CHANGED],
    ['f2b DROPPING `deleted` from a tombstoned post is refused',
      replaceWith({ content: '', ...full }), IMMUTABLE_CHANGED],
    ['f2c re-stating `deleted: true` is accepted (an unchanged value is not a change)',
      replaceWith({ content: '', deleted: true, ...full }), ACCEPT],
  ]);
}

async function caseF3MutableFieldsStayMutable(ctx) {
  console.log('\n--- f3. the properties v7 left mutable still are ---');
  const fixture = await ensureOwnMutablePost(ctx, 'editable', {
    mediaUrl: 'ipfs://bafybatteryfixture', sensitive: true,
  });
  if (!fixture) {
    check('f3 mutable fields', false, 'no fixture post available');
    return;
  }
  const { id, quoted } = fixture;
  // Keeps every FROZEN property and rewrites the content ones: blanks the body,
  // drops the media and the sensitivity flag. The tombstone's content half,
  // without setting `deleted`.
  expectAccepted(
    'f3a a replace may blank `content` and drop `mediaUrl`/`sensitive`',
    await attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'post',
      id,
      revision: await revisionOf(ctx, 'post', id),
      data: { content: '', ...immutablesOf(ctx, quoted) },
    })
  );
}

// ---- G-case: the like lifecycle under the new agreement ----------------------

/** The `$createdAt` of bot A's like of `postId`, recovered off byAuthorTimePost. */
async function likeCreatedAt(ctx, postId) {
  const page = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'like',
      where: [['postAuthor', '==', ctx.botB.ownerId]],
      orderBy: [['$createdAt', 'desc']],
      limit: 100,
    })
  );
  for (const doc of page.values()) {
    const obj = doc.toObject();
    if (asBase58(obj?.postId) === postId && asBase58(obj?.$ownerId) === ctx.botA.ownerId) return obj?.$createdAt;
  }
  return null;
}

async function caseG1LikeLifecycle(ctx) {
  console.log('\n--- g1. the like lifecycle under the $ownerId agreement ---');
  const tagged = ctx.posts.tagged ?? (await ensurePost(ctx, 'tagged', { hashtag: ctx.tag }));
  if (!tagged) {
    check('g1 like lifecycle', false, 'no tagged post available');
    return;
  }
  const agreed = agreedLike(ctx);
  if (!ctx.likedTagged) {
    if (!expectAccepted('g1a the like is accepted', await likeOn(ctx, tagged, agreed)).ok) return;
    ctx.likedTagged = true;
  }

  check('g1b the preallocated byPost count sees it',
    (await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', tagged)) >= 1);
  check('g1c the byAuthorPost count, whose authorId now agrees with post.$ownerId, sees it',
    (await countBy(ctx.sdk, ctx.contractId, 'like', 'postAuthor', ctx.botB.ownerId)) >= 1);

  // The tagged `beat` companion carries the windowed hashtag axis; its
  // `{hashtag: hashtag}` agreement is untouched by v7.
  expectAccepted(
    'g1d the tagged `beat` companion is accepted',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'beat',
      data: { postId: bs58.decode(tagged), hashtag: ctx.tag },
      accepted: () => entryExists(ctx.sdk, ctx.contractId, 'beat', 'postId', tagged, ctx.botA.ownerId),
    })
  );

  // Unlike is a delete-by-values: the tuple must reproduce the create's values
  // exactly, `$createdAt` included, recovered from the stored entry not guessed.
  const createdAt = await likeCreatedAt(ctx, tagged);
  if (createdAt === undefined || createdAt === null) {
    check('g1e the like\'s $createdAt is recoverable for the delete tuple', false, 'byAuthorTimePost returned nothing');
    return;
  }
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'like',
    ownerId: ctx.botA.ownerId,
    // The SAME tuple the create used: one byte of difference finds no entry.
    data: likeData({ postId: bs58.decode(tagged), ...agreed }),
    createdAt: BigInt(createdAt),
    id: randomIdBytes(),
  });
  expectAccepted(
    'g1e delete-by-values unlike is accepted and the entry goes away',
    await attemptDeleteByValues(ctx.sdk, ctx.botA, {
      document,
      accepted: async () => !(await entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', tagged, ctx.botA.ownerId)),
    })
  );
  if (!(await entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', tagged, ctx.botA.ownerId))) {
    ctx.likedTagged = false;
  }
}

// ---- Registry ---------------------------------------------------------------

const someId = randomIdBytes;

await runBattery({
  name: 'v7',
  contractEnvVar: 'V7_CONTRACT_ID',
  usage:
    'Usage: node scripts/verify-v7.mjs --contract <id> [--bot <n>] [--bot2 <n>]\n' +
    '       [--owner <id>] [--owner2 <id>] [--only e1,f2] [--dry-run|--self-test]',
  cases: new Map(Object.entries({
    e1: caseE1AuthorColumnGone, e2: caseE2LikeOwnerAgreement, e3: caseE3LikeReplyOwnerAgreement,
    e4: caseE4RepostOwnerAgreement, f1: caseF1TombstoneImmutability, f2: caseF2DeletedIsSettableOnce,
    f3: caseF3MutableFieldsStayMutable, g1: caseG1LikeLifecycle,
  })),
  // Every shape the live battery writes, so `--self-test` proves they build.
  shapes: [
    ['post (untagged, no author)', 'post', postData(), undefined],
    ['post (tagged)', 'post', postData({ hashtag: 'v7tag' })],
    ['post (quote + owner denorm)', 'post', postData({ quotedPostId: someId(), quotedPostOwnerId: someId() })],
    ['post (media + sensitive)', 'post', postData({ mediaUrl: 'ipfs://bafy', sensitive: true })],
    ['reply (flat, no author)', 'reply', replyData({ rootPostId: someId(), parentOwnerId: someId() })],
    ['reply (nested)', 'reply', replyData({ rootPostId: someId(), replyToReplyId: someId(), parentOwnerId: someId() })],
    ['like (tagged)', 'like', likeData({ postId: someId(), hashtag: 'v7tag', postAuthor: someId() })],
    ['like (hashtag absent)', 'like', likeData({ postId: someId(), postAuthor: someId() })],
    ['like (delete tuple)', 'like', likeData({ postId: someId(), hashtag: 'v7tag', postAuthor: someId() }), BigInt(Date.now())],
    ['likeReply', 'likeReply', likeReplyData({ replyId: someId(), replyAuthor: someId() })],
    ['beat', 'beat', { postId: someId(), hashtag: 'v7tag' }],
    ['repost', 'repost', repostData({ postId: someId(), postOwnerId: someId() })],
    ['follow', 'follow', followData({ followingId: someId() })],
  ],
  replaceShapes: [
    ['post (tombstone, immutables kept)', 'post', postData({ content: '', hashtag: 'v7tag', quotedPostId: someId(), quotedPostOwnerId: someId(), deleted: true })],
    ['reply (tombstone, linkage kept)', 'reply', replyData({ content: '', rootPostId: someId(), parentOwnerId: someId(), deleted: true })],
  ],
  makeContext: ({ sdk, contractId, botA, botB }) => ({
    sdk, contractId, botA, botB,
    /** Run-unique lowercase hashtag, so per-tag assertions stay exact across re-runs. */
    tag: `v7b${Date.now().toString(36)}`,
    /** `posts` are owned by bot B; `own` by bot A, and only the F-cases replace those. */
    posts: {}, own: {},
    replyId: null, likedTagged: false, tombstonedId: null, tombstonedFull: null, f1Ran: false,
  }),
  summarize: (ctx) => {
    console.log(`run tag: #${ctx.tag}`);
    console.log(`fixture posts: ${JSON.stringify(ctx.posts)}`);
  },
});
