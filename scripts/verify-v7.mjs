/**
 * Registration-day battery for **contract v7**
 * (`contracts/yappr-social-contract-v7.json`, docs/PLATFORM_BETA2_UPGRADE.md):
 * the beta.2 grammar Yappr actually adopted, exercised against a freshly
 * registered contract on a 4.2.0-beta.2 devnet.
 *
 * All the machinery — the devnet SDK with its quorum-rotation reconnect,
 * readback-decided write outcomes, strict wrong-reason-fails rejections, the
 * PASS/FAIL ledger, the CLI and the dry run — is
 * {@link file://./verify-lib.mjs}, extracted from `verify-v5.mjs`. THIS file
 * is only the v7 cases, because v7's query surface is v6's: every index,
 * terminal, ranked axis and `timeRange` window is unchanged, and the v4/v5/v6
 * batteries already proved those live. What is new is who enforces two
 * invariants the client used to maintain.
 *
 * There is NO default contract id: v7 only exists after registration day.
 * Pass `--contract` or set `V7_CONTRACT_ID`.
 *
 * E-cases — system-field propertyAgreement (#4816):
 *   e1  the attested `author` column is GONE from the schema: a post and a
 *       reply carrying it are refused by structure validation
 *       (`additionalProperties: false`), and the same documents without it
 *       are accepted
 *   e2  `like.postId` agrees `postAuthor` with the post's `$ownerId`: a like
 *       whose postAuthor is the LIKER rather than the post's owner is refused
 *       (40127); the correct owner is accepted; the hashtag pair still holds
 *       in both directions, absence included
 *   e3  `likeReply.replyId` agrees `replyAuthor` with the reply's `$ownerId`
 *       (wrong → 40127, correct accepted)
 *   e4  `repost.postId` agrees `postOwnerId` with the post's `$ownerId` — the
 *       binding v7 adds — so a repost naming a third party's identity in the
 *       notification index is refused (40127)
 *
 * F-cases — immutable properties on mutable document types (#4815):
 *   f1  a tombstone that carries every immutable property verbatim is
 *       accepted; one that DROPS `language`, one that drops the quote
 *       reference, and one that CHANGES `hashtag` are each refused (40128)
 *   f2  `deleted` is immutable-but-settable: the first set is accepted, a
 *       later replace flipping it back to false is refused (40128), one that
 *       drops it is refused, and one that re-states `true` is accepted
 *       (an unchanged value is not a change)
 *   f3  the properties v7 deliberately left MUTABLE still are: a replace may
 *       blank `content` and drop `mediaUrl`/`sensitive` on a live post
 *
 * G-cases — v6 carry-over smoke, on the surfaces v7's agreements touch:
 *   g1  the like lifecycle still works end to end under the `$ownerId`
 *       agreement: create, the preallocated `byAuthorPost` count, the tagged
 *       `beat` companion, and delete-by-values unlike
 *
 * Known platform behaviors this battery leans on (unchanged from v4/v5):
 *   - js documents.create() may THROW post-broadcast for indexOnly types even
 *     when the write landed — acceptance is always decided by readback;
 *   - the 40105 duplicate probe fires BEFORE 40120/40127, so every agreement
 *     violation targets a post its signer has not yet liked;
 *   - DAPI 504 on the confirmation wait is not a rejection (readback decides).
 *
 * ## Environment
 *
 *   V7_CONTRACT_ID        the freshly registered v7 contract id (or --contract)
 *   DEVNET_NAME           devnet name           (default: moutai)
 *   DAPI_ADDRESSES        comma-separated DAPI  (default: https://seed-{1..5}.<devnet>.networks.dash.org:1443)
 *   QUORUM_URL            quorum service for the trusted context
 *   DEVNET_IDENTITY_IDS   comma-separated devnet identity ids for the bot pool
 *                         (falls back to E2E_IDENTITY_IDS / .env.devnet)
 *   E2E_SEED_PHRASE       the BIP39 seed the bot keys derive from
 *
 * Both bots need YAPP on the contract under test; the run aborts early if not.
 *
 * ## Run
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
  attemptCreateIndexOnly,
  attemptDeleteByValues,
  asBase58,
  attemptReplace,
  buildDocument,
  check,
  countBy,
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
 * A structure-level refusal of an undeclared property: v7's `post`/`reply`
 * declare `additionalProperties: false` and no longer declare `author`, so a
 * document carrying it never reaches state validation (JsonSchemaError, basic
 * code 10101, rendering the jsonschema crate's "Additional properties are not
 * allowed ('author' was unexpected)"). The wasm document builder may refuse it
 * locally first, which is the same verdict one layer up — both are matched.
 *
 * Deliberately does NOT match the 401xx state codes: a 40127 or 40128 here
 * would mean the column still exists and something else refused the write,
 * which must fail the check rather than score as enforcement. The numeric
 * alternative is anchored to a `code` label because `describeErr` appends a
 * JSON dump of the error, so a bare "10101" would also match a credit amount
 * or a millisecond timestamp inside an unrelated rejection.
 */
const UNKNOWN_PROPERTY =
  /\bcode"?\s*[=:]\s*10101\b|additional properties are not allowed|was unexpected|\bunknown property\b|property .{0,40}not (found|defined) in/i;

/**
 * A frozen property was changed, added or dropped by a replace
 * (DocumentImmutablePropertyChangedError, 40128). Live message: "property
 * '<p>' of document <id> (type '<t>') is immutable and cannot be changed by a
 * replace". The numeric alternative is `code`-anchored for the same reason as
 * UNKNOWN_PROPERTY above.
 */
const IMMUTABLE_CHANGED = /\bcode"?\s*[=:]\s*40128\b|is immutable and cannot be changed/i;

// ---- v7 document shapes -----------------------------------------------------
//
// v7's post/reply: NO `author` (the like agreements bind to `$ownerId`), and
// `hashtag` still optional — untagged means the property is ABSENT.

const postData = ({
  content = 'v7 battery post',
  hashtag,
  mediaUrl,
  sensitive,
  quotedPostId,
  quotedPostOwnerId,
  deleted,
} = {}) => ({
  content,
  language: 'en',
  ...(hashtag === undefined ? {} : { hashtag }),
  ...(mediaUrl === undefined ? {} : { mediaUrl }),
  ...(sensitive === undefined ? {} : { sensitive }),
  ...(quotedPostId ? { quotedPostId } : {}),
  ...(quotedPostOwnerId ? { quotedPostOwnerId } : {}),
  ...(deleted === undefined ? {} : { deleted }),
});

const replyData = ({ content = 'v7 battery reply', rootPostId, replyToReplyId, parentOwnerId, deleted } = {}) => ({
  content,
  rootPostId,
  parentOwnerId,
  ...(replyToReplyId ? { replyToReplyId } : {}),
  ...(deleted === undefined ? {} : { deleted }),
});

// ---- Shared fixtures --------------------------------------------------------

/** One fixture create: a failure is logged and reported as `null`, never thrown. */
async function createFixture(ctx, who, docType, data, label) {
  const created = await attemptCreate(ctx.sdk, who, {
    contractId: ctx.contractId,
    docType,
    data,
    tokenCost: TOKEN_COST[docType],
  });
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
  return attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
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
function immutablesOf(ctx, quoted) {
  return {
    language: 'en',
    hashtag: ctx.tag,
    quotedPostId: bs58.decode(quoted),
    quotedPostOwnerId: bs58.decode(ctx.botB.ownerId),
  };
}

/** A post owned by bot B, so bot A's likes agree against a DIFFERENT identity. */
async function ensurePost(ctx, key, overrides = {}) {
  if (ctx.posts[key]) return ctx.posts[key];
  const id = await createFixture(ctx, ctx.botB, 'post', postData({ content: `battery ${key}`, ...overrides }), key);
  if (id) ctx.posts[key] = id;
  return id;
}

/** A reply by bot B on the anchor post, for the likeReply agreement. */
async function ensureReply(ctx) {
  if (ctx.replyId) return ctx.replyId;
  const rootPostId = await ensurePost(ctx, 'anchor');
  if (!rootPostId) return null;
  ctx.replyId = await createFixture(ctx, ctx.botB, 'reply', replyData({
    rootPostId: bs58.decode(rootPostId),
    parentOwnerId: bs58.decode(ctx.botB.ownerId),
    content: 'battery anchor reply',
  }), 'the anchor reply');
  return ctx.replyId;
}

/**
 * A post owned by bot A that only the immutability cases touch, so a rejected
 * replace never disturbs a document another case is asserting against.
 * Carries every immutable property v7 freezes that a real post can hold at
 * once: `language`, `hashtag`, a quote reference and its owner denormalization.
 */
async function ensureOwnMutablePost(ctx, key, overrides = {}) {
  if (ctx.own[key]) return ctx.own[key];
  const quoted = await ensurePost(ctx, 'anchor');
  if (!quoted) return null;
  const id = await createFixture(ctx, ctx.botA, 'post', postData({
    content: `immutability fixture ${key}`,
    ...immutablesOf(ctx, quoted),
    ...overrides,
  }), key);
  if (!id) return null;
  ctx.own[key] = { id, quoted };
  return ctx.own[key];
}

/**
 * `attemptCreate`, but a failure to even BUILD the document scores as the
 * rejection instead of aborting the case: wasm's `Document.fromObject` refuses
 * some malformed shapes locally, and for e1 that is the same verdict as
 * consensus refusing them, one layer up.
 */
async function attemptCreateAllowingBuildFailure(sdk, who, spec) {
  try {
    return await attemptCreate(sdk, who, spec);
  } catch (e) {
    return { ok: false, error: describeErr(e) };
  }
}

/** A copy of `fields` with `dropped` genuinely ABSENT — `{...f, k: undefined}`
 * still carries the key, which is a present-but-empty value rather than the
 * removal these cases are asserting against. */
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
  const a = bs58.decode(ctx.botA.ownerId);

  expectRejected(
    'e1a a post carrying the removed `author` property is refused',
    await attemptCreateAllowingBuildFailure(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'post',
      data: { ...postData({ content: 'post with a v6 author column' }), author: a },
      tokenCost: TOKEN_COST.post,
    }),
    UNKNOWN_PROPERTY
  );

  const rootPostId = await ensurePost(ctx, 'anchor');
  if (!rootPostId) {
    check('e1 author column', false, 'no anchor post available');
    return;
  }
  expectRejected(
    'e1b a reply carrying the removed `author` property is refused',
    await attemptCreateAllowingBuildFailure(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'reply',
      data: {
        ...replyData({
          rootPostId: bs58.decode(rootPostId),
          parentOwnerId: bs58.decode(ctx.botB.ownerId),
          content: 'reply with a v6 author column',
        }),
        author: a,
      },
      tokenCost: TOKEN_COST.reply,
    }),
    UNKNOWN_PROPERTY
  );

  // The control: the SAME writes without the column must land, so e1a/e1b
  // prove the column is gone rather than that the write path is broken.
  expectAccepted(
    'e1c the same post WITHOUT `author` is accepted',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'post',
      data: postData({ content: 'post with no author column' }),
      tokenCost: TOKEN_COST.post,
    })
  );
  expectAccepted(
    'e1d the same reply WITHOUT `author` is accepted',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'reply',
      data: replyData({
        rootPostId: bs58.decode(rootPostId),
        parentOwnerId: bs58.decode(ctx.botB.ownerId),
        content: 'reply with no author column',
      }),
      tokenCost: TOKEN_COST.reply,
    })
  );
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

  // Every violation targets a post bot A has NOT yet liked: the 40105
  // structural-uniqueness probe fires before the agreement check and would
  // mask the 40127 we are asserting.
  // The liker's own id is the interesting wrong answer: on v6 `postAuthor`
  // was compared against a column the POSTER wrote, so a client bug could
  // make it anything; v7 compares it against the post's real owner.
  expectRejected(
    'e2a a like whose postAuthor is the LIKER, not the post owner, is refused',
    await likeOn(ctx, tagged, { hashtag: ctx.tag, postAuthor: bs58.decode(ctx.botA.ownerId) }),
    PROPERTY_MISMATCH
  );
  expectRejected(
    'e2b a like whose postAuthor is an unrelated identity is refused',
    await likeOn(ctx, tagged, { hashtag: ctx.tag, postAuthor: randomIdBytes() }),
    PROPERTY_MISMATCH
  );
  expectRejected(
    'e2c the hashtag pair still holds: a wrong tag is refused',
    await likeOn(ctx, tagged, { hashtag: `${ctx.tag}x`, postAuthor: bs58.decode(ctx.botB.ownerId) }),
    PROPERTY_MISMATCH
  );
  expectRejected(
    'e2d absence is strict: a tagged like on an UNTAGGED post is refused',
    await likeOn(ctx, untagged, { hashtag: ctx.tag, postAuthor: bs58.decode(ctx.botB.ownerId) }),
    PROPERTY_MISMATCH
  );
  expectRejected(
    'e2e and the other direction: a hashtag-ABSENT like on a TAGGED post is refused',
    await likeOn(ctx, spare, { postAuthor: bs58.decode(ctx.botB.ownerId) }),
    PROPERTY_MISMATCH
  );

  expectAccepted(
    'e2f a like naming the post owner\'s $ownerId (and its tag) is accepted',
    await likeOn(ctx, tagged, agreedLike(ctx))
  );
  if ((await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', tagged)) > 0) ctx.likedTagged = true;
  expectAccepted(
    'e2g the both-absent direction agrees: a hashtag-less like on an untagged post',
    await likeOn(ctx, untagged, { postAuthor: bs58.decode(ctx.botB.ownerId) })
  );
}

async function caseE3LikeReplyOwnerAgreement(ctx) {
  console.log('\n--- e3. likeReply.replyAuthor agrees with the reply\'s $ownerId (40127) ---');
  const replyId = await ensureReply(ctx);
  if (!replyId) {
    check('e3 likeReply agreement', false, 'no anchor reply available');
    return;
  }
  const likeReplyOn = (replyAuthor) =>
    attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'likeReply',
      data: likeReplyData({ replyId: bs58.decode(replyId), replyAuthor }),
      tokenCost: TOKEN_COST.likeReply,
      accepted: () => entryExists(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId, ctx.botA.ownerId),
    });

  expectRejected(
    'e3a a reply like whose replyAuthor is the LIKER is refused',
    await likeReplyOn(bs58.decode(ctx.botA.ownerId)),
    PROPERTY_MISMATCH
  );
  expectAccepted(
    'e3b a reply like naming the reply owner\'s $ownerId is accepted',
    await likeReplyOn(bs58.decode(ctx.botB.ownerId))
  );
  expectRejected(
    'e3c re-liking the same reply is still the structural duplicate (40105)',
    await likeReplyOn(bs58.decode(ctx.botB.ownerId)),
    DUPLICATE_UNIQUE
  );
}

async function caseE4RepostOwnerAgreement(ctx) {
  console.log('\n--- e4. repost.postOwnerId agrees with the post\'s $ownerId (NEW in v7) ---');
  const postId = await ensurePost(ctx, 'reposted');
  if (!postId) {
    check('e4 repost agreement', false, 'no post to repost');
    return;
  }
  const repostWith = (postOwnerId) =>
    attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'repost',
      data: repostData({ postId: bs58.decode(postId), postOwnerId }),
      tokenCost: TOKEN_COST.repost,
    });

  // On v6 this was accepted, and it poisoned `postOwnerAndTime`: the named
  // identity saw a "X reposted your post" notification for a post that is not
  // theirs.
  expectRejected(
    'e4a a repost naming a third party in postOwnerId is refused',
    await repostWith(randomIdBytes()),
    PROPERTY_MISMATCH
  );
  expectRejected(
    'e4b a repost naming the REPOSTER in postOwnerId is refused',
    await repostWith(bs58.decode(ctx.botA.ownerId)),
    PROPERTY_MISMATCH
  );
  expectAccepted(
    'e4c a repost naming the post owner\'s $ownerId is accepted',
    await repostWith(bs58.decode(ctx.botB.ownerId))
  );
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
  const replaceWith = (data) =>
    attemptReplace(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'post', id, data, revision });

  // Each rejection runs against the SAME stored revision: a refused replace
  // leaves the document untouched, so they do not have to be ordered.
  // `language` is REQUIRED, so a replace that dropped it would be refused by
  // schema validation (10101) before state validation ever reached 40128 —
  // which `expectRejected` would correctly score as the wrong reason. CHANGING
  // it is how a required frozen property reaches the immutability check. The
  // DROP direction is covered by f1b/f1d, whose properties are optional.
  expectRejected(
    'f1a a tombstone that CHANGES the immutable, REQUIRED `language` is refused',
    await replaceWith({ content: '', deleted: true, ...full, language: 'fr' }),
    IMMUTABLE_CHANGED
  );
  expectRejected(
    'f1b a tombstone that DROPS the quote reference is refused',
    await replaceWith({ content: '', deleted: true, ...without(full, 'quotedPostId') }),
    IMMUTABLE_CHANGED
  );
  expectRejected(
    'f1c a tombstone that CHANGES the immutable `hashtag` is refused',
    await replaceWith({ content: '', deleted: true, ...full, hashtag: `${ctx.tag}x` }),
    IMMUTABLE_CHANGED
  );
  expectRejected(
    'f1d a tombstone that DROPS the optional `hashtag` is refused too',
    await replaceWith({ content: '', deleted: true, ...without(full, 'hashtag') }),
    IMMUTABLE_CHANGED
  );
  expectAccepted(
    'f1e a tombstone carrying every immutable property verbatim is accepted',
    await replaceWith({ content: '', deleted: true, ...full })
  );
  ctx.tombstonedId = id;
  ctx.tombstonedFull = full;
}

async function caseF2DeletedIsSettableOnce(ctx) {
  console.log('\n--- f2. `deleted` is immutable-but-settable: one set, never a revert ---');
  // Lazy fixture so `--only f2` works; never re-runs a case that already
  // ran and failed, which would double-count its checks.
  if (!ctx.tombstonedId && !ctx.f1Ran) await caseF1TombstoneImmutability(ctx);
  const id = ctx.tombstonedId;
  if (!id) {
    check('f2 deleted allowance', false, 'no tombstoned post available');
    return;
  }
  const full = ctx.tombstonedFull;
  const replaceWith = async (data) =>
    attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'post',
      id,
      data,
      revision: await revisionOf(ctx, 'post', id),
    });

  // f1e already performed the one allowed set (absent → true), which is what
  // `immutableAllowSetting: ["deleted"]` exists for. From here it is frozen.
  expectRejected(
    'f2a flipping `deleted` back to false is refused',
    await replaceWith({ content: '', deleted: false, ...full }),
    IMMUTABLE_CHANGED
  );
  expectRejected(
    'f2b DROPPING `deleted` from a tombstoned post is refused',
    await replaceWith({ content: '', ...full }),
    IMMUTABLE_CHANGED
  );
  expectAccepted(
    'f2c re-stating `deleted: true` is accepted (an unchanged value is not a change)',
    await replaceWith({ content: '', deleted: true, ...full })
  );
}

async function caseF3MutableFieldsStayMutable(ctx) {
  console.log('\n--- f3. the properties v7 left mutable still are ---');
  const fixture = await ensureOwnMutablePost(ctx, 'editable', {
    mediaUrl: 'ipfs://bafybatteryfixture',
    sensitive: true,
  });
  if (!fixture) {
    check('f3 mutable fields', false, 'no fixture post available');
    return;
  }
  const { id, quoted } = fixture;
  // A replace that keeps every FROZEN property and rewrites the content ones:
  // blanks the body, drops the media and drops the sensitivity flag. This is
  // exactly the tombstone's content half, without setting `deleted`.
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

// ---- G-cases: v6 carry-over smoke -------------------------------------------

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

  check(
    'g1b the preallocated byPost count sees it',
    (await countBy(ctx.sdk, ctx.contractId, 'like', 'postId', tagged)) >= 1
  );
  check(
    'g1c the byAuthorPost count, whose authorId now agrees with post.$ownerId, sees it',
    (await countBy(ctx.sdk, ctx.contractId, 'like', 'postAuthor', ctx.botB.ownerId)) >= 1
  );

  // The tagged `beat` companion: the windowed hashtag axis is v6's, carried
  // into v7 with its `{hashtag: hashtag}` agreement untouched.
  expectAccepted(
    'g1d the tagged `beat` companion is accepted',
    await attemptCreateIndexOnly(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'beat',
      data: { postId: bs58.decode(tagged), hashtag: ctx.tag },
      accepted: () => entryExists(ctx.sdk, ctx.contractId, 'beat', 'postId', tagged, ctx.botA.ownerId),
    })
  );

  // Unlike is a delete-by-values: the tuple must reproduce the create's
  // values exactly, `$createdAt` included, which is recovered from the stored
  // entry rather than guessed.
  const page = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'like',
      where: [['postAuthor', '==', ctx.botB.ownerId]],
      orderBy: [['$createdAt', 'desc']],
      limit: 100,
    })
  );
  let createdAt;
  for (const doc of page.values()) {
    const obj = doc.toObject();
    if (asBase58(obj?.postId) === tagged && asBase58(obj?.$ownerId) === ctx.botA.ownerId) {
      createdAt = obj?.$createdAt;
      break;
    }
  }
  if (createdAt === undefined || createdAt === null) {
    check('g1e the like\'s $createdAt is recoverable for the delete tuple', false, 'byAuthorTimePost returned nothing');
    return;
  }
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'like',
    ownerId: ctx.botA.ownerId,
    // The SAME tuple the create used: a delete-by-values that differs by one
    // byte finds no entry.
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

const CASES = new Map([
  ['e1', caseE1AuthorColumnGone],
  ['e2', caseE2LikeOwnerAgreement],
  ['e3', caseE3LikeReplyOwnerAgreement],
  ['e4', caseE4RepostOwnerAgreement],
  ['f1', caseF1TombstoneImmutability],
  ['f2', caseF2DeletedIsSettableOnce],
  ['f3', caseF3MutableFieldsStayMutable],
  ['g1', caseG1LikeLifecycle],
]);

const someId = randomIdBytes;

await runBattery({
  name: 'v7',
  contractEnvVar: 'V7_CONTRACT_ID',
  usage:
    'Usage: node scripts/verify-v7.mjs --contract <id> [--bot <n>] [--bot2 <n>]\n' +
    '       [--owner <id>] [--owner2 <id>] [--only e1,f2] [--dry-run|--self-test]',
  cases: CASES,
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
    sdk,
    contractId,
    botA,
    botB,
    /** Run-unique lowercase hashtag, so per-tag assertions stay exact across re-runs. */
    tag: `v7b${Date.now().toString(36)}`,
    /** Fixture posts owned by bot B, keyed by role. */
    posts: {},
    /** Fixture posts owned by bot A, which only the immutability cases replace. */
    own: {},
    replyId: null,
    likedTagged: false,
    tombstonedId: null,
    tombstonedFull: null,
    f1Ran: false,
  }),
  summarize: (ctx) => {
    console.log(`run tag: #${ctx.tag}`);
    console.log(`fixture posts: ${JSON.stringify(ctx.posts)}`);
  },
});
