/**
 * Registration-day battery for **contract v10**
 * (`contracts/yappr-social-contract-v10.json`, docs/SOCIAL_V10.md): the
 * 4.2.0-beta.7 cut, exercised against a freshly registered contract on a
 * beta.7 devnet (bonsia). The machinery is verify-lib; the moderated write path
 * (manual batches carrying `$actionFeeAgreement`) is social-battery-lib. It
 * started as verify-v9 and keeps every v9 case that still applies; the
 * tombstone cases (t1, f1–f3) are gone with the tombstones.
 *
 * There is NO default contract id. Pass `--contract` or set `V10_CONTRACT_ID`.
 *
 * ## Who moderates
 *
 * v10 declares ELECTED moderation with the contract owner as the interim, as v9
 * did. Until a charter is seated the owner (`--moderator maker`, the default)
 * is the only moderator; once masternodes seat a team, the owner is refused
 * 41101 and every moderator case here SKIPS (e0 reads the seat first).
 *
 * ## Cases carried from v9
 *
 *   e0  the parsed contract declares elected moderation with the owner as the
 *       interim, all three lists, report changeDocumentFields, no seat yet
 *   d1  distinctFrom $ownerId: self-follow, self-block, self-request 10419
 *   p1  private-feed gates (keyGeneration): no privateFeedState → 40120 on
 *       $ownerId; no followRequest → 40120 on recipientId; self-grant 10419
 *   b1  typed block follows (identifier list, ghost 40120, self 10419, dup)
 *   w1  warnings accumulate and clear (41117 on a second clear)
 *   m1  interim moderator delete + restore of a post (a record is kept)
 *   m2  interim ban/unban (41107 while banned)
 *   o1  like.postAuthor and hashtag agree with the post (40127, absence too)
 *   o2  likeReply.replyAuthor agrees with the reply (40127; re-like 40105)
 *   o3  a bare repost (a post quoting its target, no content) names the
 *       target's real owner in quotedPostOwnerId (40127); v10 has no repost type
 *   o4  quotedPostOwnerId and parentOwnerId agree with the target (40127)
 *
 * ## v10 cases
 *
 *   x1  real deletes: B deletes its own post; it no longer fetches; the
 *       quote and reply counts on it fall to 0 exactly; a replace of a post is
 *       refused (posts are immutable); a reply, quote, bare repost, like,
 *       bookmark and report aimed at the deleted post are each refused 40120; an
 *       author's delete leaves no removal record, so a moderator restore is
 *       41119
 *   x2  media and limits: a post with mediaUrl but no hashes, or a hash with
 *       no mediaUrl, is 10101 (dependentRequired); all three land; content of
 *       1000 ASCII characters lands, 1001 is 10101; 667 three-byte characters
 *       (2001 bytes, under 1000 characters) is 10421 (maxBytes); a post with a
 *       `language` is 10101 (the property is gone); the global timeline
 *       lists a fresh post
 *   x3  the yapprProfile extension: A with no DashPay profile is refused 40120
 *       on $ownerId; A writes a DashPay profile, then the extension lands; a
 *       second extension is 40105; the moderator deletes it (a record kept)
 *   c1  every refused post/reply create in property-constraint-cases.mjs is
 *       10422 naming its rule
 *   r1  reports: one per reporter and target (40105), author-agreed (40127),
 *       never the reporter (10419), a ghost 40120, the refused constraint
 *       cases 10422; A withdraws its reply report; a reporter setting
 *       `status` is 41124; the interim owner RESOLVES the post report
 *       (changeDocumentFields: status 2 + resolution): it stays, carries both
 *       fields, is stamped `$moderatedBy`/`$moderatedAt`, and `byModerator`
 *       and `byStatus` list it; a no-op change is 10905; a field outside
 *       changeFields is 41123; a resolve after the post is deleted still
 *       lands; the owner purges a report (r1r–r1t on a deleted post; r1v–r1y
 *       on the resolved one): it is gone, `documentRemovals` refuses the type
 *       (no records), a restore is 41119, and A may report the post again
 *   r2  (post-seat) a seated member resolves a report: without a listed reason
 *       41203, with one it lands; a protected reporter's report still resolves
 *       (changes are not deletions) but cannot be deleted (41102). Needs
 *       --team-member bot:<n> --reason-doc <id>
 *   t2  trending without `beat`: a tagged like lands in `like.byTrendHashtagPost`
 *       (24h windows every 6h, read through the oldest open window) and the
 *       post in `like.byTrendPost` (72h every 24h): the tag window groups the
 *       run's tag with the right count and ranks the post within it, an
 *       untagged like leaves it alone, the 3-day window counts both; unliking
 *       (the delete tuple read off `byAuthorPostTime` with the post pinned,
 *       keyset on `$createdAt <=`) drops the counts again
 *   n1  one mention per post or reply: a post naming `mentionedUserId` lands
 *       and reads back with it; the permanent `post.mentionedUserAndTime` lists
 *       it for the mentioned identity (`$createdAt >`, newest first); a mention
 *       of an identity that does not exist is refused 40120 (refersTo
 *       identity). The same for a reply (n1e–n1g) on
 *       `reply.mentionedUserAndTime`. There is no postMention.
 *   n2  the reply notification windows (plain queries, no composite: the
 *       current window and the previous one (`byStart`) of the non-overlapping 3.5-day
 *       grid, deduped): `reply.parentOwnerRecent` lists A's reply for B. Likes stay permanent: the per-target read on
 *       `byAuthorPostTime`/`byAuthorReplyTime` (`author ==`, `target ==`,
 *       `$createdAt >`) lists A's likes of B's post and reply; `byPost` /
 *       `byReply` (`target in`, `$ownerId ==`) answer "did A like X"; the
 *       unlike tuple is recovered off the same author index (`$createdAt <=`
 *       keyset + dedupe, never an id cursor) and an unlike by values lands for
 *       both types
 *   q1  a repost is a post: a bare repost without the post agreement is 40132;
 *       with it and a YAPP payment it lands, costing exactly the post's token
 *       cost and growing the moderators pot by the post fee; it reads back with
 *       no content; a second repost, or a quote, of the same post by the same
 *       author is 40105 (ownerAndQuotedPost); another author's repost lands and
 *       the quote count is exactly the two reposts; quotedPostOwnerRecent's
 *       two open windows list it for the post's author; the same for a reply
 *       target (quotedReplyId, ownerAndQuotedReply 40105, its quote count 1);
 *       a post with only a
 *       hashtag and `sensitive` is 10422 notEmpty, a media-only post lands
 *   q2  merged counts on the list indexes, exact on fresh targets: quotes
 *       (`==`, batched `in` + groupBy), replies per thread (`==`, batched),
 *       per reply (`==`, batched under a root pin), direct replies (the null
 *       pin); posts per author (`==`, batched) and following / followers
 *       (`==`, batched) by their deltas; ranked top authors, most followed and
 *       most replied agree with those counts
 *   y1  YAPP is locked: a transfer is refused (40711, paused); a direct
 *       purchase is refused (no price: 40721); a post paying 10 YAPP still
 *       lands; the starter grant is claimed once (a second claim 40722)
 *
 * ## Carried from verify-v8 (the v8 grammar v10 keeps; verify-v8 needs a v9 chain)
 *
 *   a1  a post without `$actionFeeAgreement` is 40132
 *   a2  an agreement paying moderators LESS than declared is judged as a charter
 *       discount (40139: unseated, nothing is discounted; seated, only the
 *       charter's exact share is); any other mismatch (fixed pricing, a larger
 *       moderators part) is 40133. Never 40134.
 *   a3  the agreed fee lands, the locally derived nonce-committed id is the one
 *       Platform stored, and the moderators pot grows by the post and reply fees
 *   a4  the interim owner claims the moderators pot; a second claim is 41111
 *   s1  a suspension refuses priced and unpriced creates (41108) until it lapses
 *   k1  optional token cost: a like without payment info pays credits, one with
 *       it pays 1 YAPP on the paused token and the contract owner pays the gas
 *   k2  payment info with no YAPP is 40700, never a credits fallback
 *       (`--poor <n>`, default 2; skipped when that bot holds YAPP)
 *
 * ## Run
 *
 *   node scripts/verify-v10.mjs --self-test          # offline: contract + shapes
 *   NETWORK=devnet node scripts/verify-v10.mjs --contract <freshV10Id> \
 *        [--bot 0] [--bot2 1] [--fresh-bot 2] [--only e0,x1]
 *
 * `--fresh-bot <n>` names an identity with no DashPay profile and no starter
 * claim yet (x3a, y1d); without it those probes SKIP. Both bots need credits
 * and YAPP on the contract under test (the register script mints it).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import bs58 from 'bs58';
import { DataContract, Document, DocumentActionFeeAgreement, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import {
  ALREADY_CLAIMED, DASHPAY_CONTRACT_ID, DASHPAY_PROFILE_LIMITS, FEE_MULTIPLIER_NOT_TOLERATED, PREFER_CONTRACT_OWNER, REPO_ROOT,
  STARTER_GRANT, TOKEN_COST, YAPP_TOKEN_POSITION, actionFeeAgreementOptions, actionFeeFor, paymentInfo, tokenBalance, tokenCostFor,
} from './seed/seed-lib.mjs';
import { loadIdentityIds } from './derive-identities.mjs';
import {
  DUPLICATE_UNIQUE,
  PROPERTY_MISMATCH,
  attemptCreate,
  attemptCreateIndexOnly,
  attemptDeleteByValues,
  attemptReplace,
  buildDocument,
  check,
  countBy,
  countWhere,
  entryExists,
  expectAccepted,
  expectRejected,
  fetchDocument,
  followData,
  groupKeyOf,
  groupedCountBy,
  likeData,
  likeReplyData,
  randomIdBytes,
  readback,
  runBattery,
} from './verify-lib.mjs';
import {
  asOutcome,
  describeValue,
  errorOf,
  feeAgreement,
  idOf,
  manualCreate,
  resolveModerator,
  settle,
  takeFlag,
  wifForBot,
} from './social-battery-lib.mjs';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import { DECLARED_RULES, constraintViolation, refusedCreates } from './property-constraint-cases.mjs';

const CONTRACT_FILE = 'contracts/yappr-social-contract-v10.json';
const V10 = JSON.parse(readFileSync(join(REPO_ROOT, CONTRACT_FILE), 'utf8'));
const POST_ACTION_FEE = actionFeeFor('post');
const REPLY_ACTION_FEE = actionFeeFor('reply');
const MODERATOR_SPEC = takeFlag('--moderator', 'maker');
// r2 (post-seat): a member of the SEATED team, and a `reason` document its proposal lists (41203).
const TEAM_MEMBER_SPEC = takeFlag('--team-member', null);
const REASON_DOCUMENT_ID = takeFlag('--reason-doc', null);
// x3a/y1d need an identity that has neither a DashPay profile nor a starter claim.
const FRESH_BOT = takeFlag('--fresh-bot', null);
const FRESH_OWNER = takeFlag('--fresh-owner', null);
// k2 needs an identity holding NO YAPP (40700); verify-v8's `--poor`.
const POOR_BOT_INDEX = Number(takeFlag('--poor', '2'));
/** Long enough for the refused write to run, short enough to wait out. */
const SUSPENSION_MS = 25_000;
if (MODERATOR_SPEC !== 'maker') {
  console.error(`--moderator ${MODERATOR_SPEC}: v10's interim moderator is the contract owner alone (interim: contractOwner appoints nobody); run with --moderator maker (the default)`);
  process.exit(1);
}

// ---- Expected rejections (code-anchored, see verify-lib) ---------------------

const NOT_DISTINCT = /\bcode"?\s*[=:]\s*10419\b|must differ from "?\$ownerId"?, but the two values are equal/i;
const REFERENCE_NOT_FOUND = /\bcode"?\s*[=:]\s*40120\b|referenced .{0,80}not found|referencedentitynotfound/i;
const NOT_FOUND_ON_OWNER = /\$ownerId/;
const NOT_FOUND_ON_RECIPIENT = /recipientId/;
const DUPLICATE_ITEMS = /\bcode"?\s*[=:]\s*10101\b|jsonschemaerror.{0,2000}?(uniqueitems|duplicate items|has non-unique elements|must not have duplicate)/i;
const NOT_WARNED = /\bcode"?\s*[=:]\s*41117\b|carries no warning|contractusernotwarned/i;
const SUSPENDED = /\bcode"?\s*[=:]\s*41108\b|contractusersuspended|is suspended/i;
const INSUFFICIENT_TOKENS = /\bcode"?\s*[=:]\s*40700\b|not have enough token|insufficient token|identitydoesnothaveenoughtokenbalance/i;
// 40132/40133 may arrive as prose (verify-v8's matchers, measured live on beta.3).
const AGREEMENT_NOT_SET = /\bcode"?\s*[=:]\s*40132\b|fee agreement.{0,40}not set|actionfeeagreementnotset|carries no action fee agreement/i;
/**
 * 40139: a moderators part below the declared one on an elected contract's
 * moderated type is a discount claim, checked against the seated charter's
 * share before (instead of) the 40133 amount match.
 */
const MODERATORS_SHARE_MISMATCH = /\bcode"?\s*[=:]\s*40139\b|actionfeemoderatorssharemismatch|declares a moderators fee of [\d,]+ credits; the transition agreed to/i;
const NO_SEATED_CHARTER = /discounted: the contract has no seated moderation charter/i;
const AGREEMENT_MISMATCH = /\bcode"?\s*[=:]\s*40133\b|fee agreement.{0,40}mismatch|actionfeeagreementmismatch|but the transition agreed to [\d,]+ and [\d,]+ credits/i;
const ALREADY_CLAIMED_EPOCH = /\bcode"?\s*[=:]\s*41111\b|already.{0,30}claimed.{0,30}epoch|alreadyclaimedthisepoch/i;
const ALREADY_RESTORED = /\bcode"?\s*[=:]\s*41122\b|already restored|contractdocumentalreadyrestored/i;
const BANNED = /\bcode"?\s*[=:]\s*41107\b|contractuserbanned|is banned/i;
/** JSON schema (10101): dependentRequired, maxLength, an undeclared property. */
const SCHEMA_REFUSED = /\bcode"?\s*[=:]\s*10101\b|jsonschemaerror:/i;
/** DocumentPropertyMaxBytesExceededError: "Property content is N bytes in UTF-8, over its maxBytes of 2000". */
const MAX_BYTES = /\bcode"?\s*[=:]\s*10421\b|bytes in utf-8, over its maxbytes/i;
/** A replace of a type with documentsMutable false (drive-abci advanced structure). */
/** A replace of a documentsMutable:false type (the advanced-structure refusal), or its revision check (40106) if that runs first. */
const NOT_MUTABLE = /is not mutable and can not be replaced|\bcode"?\s*[=:]\s*(1040[0-9]|40106)\b|invaliddocumentrevision/i;
/** A restore with no removal record: an author's delete leaves none (41119). */
const NO_REMOVAL_RECORD = /\bcode"?\s*[=:]\s*41119\b|keeps no record of a moderator's deletion|contractdocumentremovalnotfound/i;
/** A reporter writing a moderator-only field (41124). */
const MODERATOR_FIELD = /\bcode"?\s*[=:]\s*41124\b|only the moderators of contract .{0,80} write field/i;
/** A field the type does not keep for its moderators (41123). */
const FIELD_NOT_CHANGEABLE = /\bcode"?\s*[=:]\s*41123\b|can not be changed by moderators/i;
/** A change that changes nothing, or names no field (10905). */
const FIELDS_INVALID = /\bcode"?\s*[=:]\s*10905\b|the fields a moderator's document change sets are invalid/i;
const TARGET_NOT_ALLOWED = /\bcode"?\s*[=:]\s*41102\b|contractmoderationtargetnotallowed/i;
const REASON_NOT_LISTED = /\bcode"?\s*[=:]\s*41203\b|reason.{0,80}not listed|moderationreasonnotlisted/i;
const TOKEN_PAUSED = /\bcode"?\s*[=:]\s*40711\b|token .{0,60} is paused/i;
const NOT_FOR_SALE = /\bcode"?\s*[=:]\s*40721\b|not available for direct sale|no direct-purchase price/i;

// ---- v10 document shapes -----------------------------------------------------

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
/** A media triple: the URL with the sha256 of some bytes and an 8-byte fingerprint. */
async function mediaFields(url = 'ipfs://bafyv10batterymedia') {
  return { mediaUrl: url, mediaHash: await sha256(new TextEncoder().encode(url)), mediaFingerprint: crypto.getRandomValues(new Uint8Array(8)) };
}

/**
 * Untagged means `hashtag` is ABSENT; every optional property is omitted unless
 * given. There is no `language`. A post names at most one `mentionedUserId`.
 */
const postData = ({ content = 'v10 battery post', hashtag, sensitive, quotedPostId, quotedPostOwnerId, mentionedUserId, media } = {}) => ({
  content,
  ...(hashtag === undefined ? {} : { hashtag }),
  ...(mentionedUserId ? { mentionedUserId } : {}),
  ...(sensitive === undefined ? {} : { sensitive }),
  ...(quotedPostId ? { quotedPostId } : {}),
  ...(quotedPostOwnerId ? { quotedPostOwnerId } : {}),
  ...(media ?? {}),
});
/** A repost: a post quoting its target (a post or a reply) with no content; the quote satisfies notEmpty. */
const repostOf = ({ postId, replyId, ownerId }) => ({ ...(postId ? { quotedPostId: postId } : { quotedReplyId: replyId }), quotedPostOwnerId: ownerId });
const replyData = ({ content = 'v10 battery reply', rootPostId, parentOwnerId, mentionedUserId } = {}) => ({
  content, rootPostId, parentOwnerId, ...(mentionedUserId ? { mentionedUserId } : {}),
});
const blockData = ({ blockedId }) => ({ blockedId });
const followRequestData = ({ targetId }) => ({ targetId });
const feedStateData = () => ({ treeCapacity: 1024, maxKeyGeneration: 2000, encryptedSeed: randomIdBytes() });
const grantData = ({ recipientId, leafIndex = 0, keyGeneration = 1 }) => ({ recipientId, leafIndex, keyGeneration, encryptedPayload: crypto.getRandomValues(new Uint8Array(96)) });
const rekeyData = ({ keyGeneration = 2, revokedLeaf = 0 } = {}) => ({ keyGeneration, revokedLeaf, packets: crypto.getRandomValues(new Uint8Array(64)), encryptedCEK: crypto.getRandomValues(new Uint8Array(48)) });
/** A report names exactly one of `postId` / `replyId`; reason 8 ("something else") must carry a note. */
const reportData = ({ postId, replyId, targetOwnerId, reason = 0, note, status } = {}) => ({
  ...(postId ? { postId } : {}),
  ...(replyId ? { replyId } : {}),
  targetOwnerId,
  reason,
  ...(note === undefined ? {} : { note }),
  ...(status === undefined ? {} : { status }),
});
/** A typed identifier array is a list of 32-byte ids — never one packed byte array. */
const blockFollowData = (ids) => ({ followedBlockers: ids.map((id) => (typeof id === 'string' ? bs58.decode(id) : id)) });
/** The DashPay profile v10 builds on (displayName ≤25, publicMessage ≤140). */
const dashpayProfileData = (name) => ({ displayName: name.slice(0, DASHPAY_PROFILE_LIMITS.displayName), publicMessage: 'v10 battery DashPay profile' });
const yapprProfileData = () => ({ location: 'Battery', pronouns: 'it/its', socialLinks: ['github:yappr'] });

// ---- Reads ---------------------------------------------------------------------

async function standingOf(ctx, identityId, lists = ['banlist', 'suspensions', 'warnings']) {
  return readback(() => ctx.sdk.contracts.moderationStatus({ contractId: ctx.contractId, identityId, lists }));
}

async function queryOne(ctx, docType, where, contractId = ctx.contractId) {
  const result = await readback(() => ctx.sdk.documents.query({ dataContractId: contractId, documentTypeName: docType, where, limit: 1 }));
  for (const document of result.values()) if (document) return document;
  return null;
}

/** Deletes `who`'s document `id` of `docType`; answers the error or null. */
const deleteOwn = (ctx, who, docType, id, contractId = ctx.contractId) => errorOf(() => ctx.sdk.documents.delete({
  document: { id, ownerId: who.ownerId, dataContractId: contractId, documentTypeName: docType },
  identityKey: who.identityKey, signer: who.signer, settings: { identityNonceStaleTimeS: 0 },
}));

/** A create that must be refused, scored by `expectRejected`; a create that lands is deleted again. */
async function expectCreateRefused(ctx, label, who, docType, data, pattern, detailPattern) {
  const outcome = await attemptCreate(ctx.sdk, who, { contractId: ctx.contractId, docType, data });
  if (outcome.ok && outcome.id) await deleteOwn(ctx, who, docType, outcome.id);
  expectRejected(label, outcome, pattern);
  if (!outcome.ok && detailPattern) {
    check(`${label} — names the gated path`, detailPattern.test(outcome.error ?? ''), (outcome.error ?? '').slice(0, 160));
  }
  return outcome;
}

/** A post or reply create carrying the declared action fee (a create without it is a paid 40132). */
async function createFeedOutcome(ctx, who, docType, data) {
  const { agreement } = await feeAgreement(ctx, docType === 'post' ? POST_ACTION_FEE : REPLY_ACTION_FEE);
  return manualCreate(ctx, who, { docType, data, agreement });
}

async function createFeed(ctx, who, docType, data, label) {
  const created = await createFeedOutcome(ctx, who, docType, data);
  if (!created.ok) console.log(`     (could not create ${label}: ${(created.error ?? '').slice(0, 200)})`);
  return created.ok ? created.id : null;
}

/** A post or reply create that must be refused; one that lands is deleted again (v10 posts are deletable). */
async function expectFeedRefused(ctx, label, who, docType, data, pattern) {
  const outcome = await createFeedOutcome(ctx, who, docType, data);
  if (outcome.ok && outcome.id) await deleteOwn(ctx, who, docType, outcome.id);
  return expectRejected(label, outcome, pattern);
}

const createPost = (ctx, who, content) => createFeed(ctx, who, 'post', postData({ content }), 'a post');

/** Skips a moderator case when a charter is seated: the interim owner is refused 41101 there, correctly. */
function interimOnly(ctx, key) {
  if (!ctx.seated) return false;
  console.log(`SKIP  ${key}: a moderation charter is seated on this contract, so the interim owner may no longer moderate (41101). Run the election script's team cases instead.`);
  return true;
}

/** The fresh identity of x3a/y1d (no DashPay profile, no starter claim), or null. */
async function freshActor(ctx) {
  if (ctx.fresh !== undefined) return ctx.fresh;
  if (FRESH_BOT === null) { ctx.fresh = null; return null; }
  const owner = resolveOwner({ botIndex: Number(FRESH_BOT), ...(FRESH_OWNER ? { ownerId: FRESH_OWNER } : {}) });
  const { identityKey, signer } = await signerFor(ctx.sdk, owner);
  ctx.fresh = { ownerId: owner.ownerId, identityKey, signer, label: owner.label };
  return ctx.fresh;
}

// ---- Cases -----------------------------------------------------------------------

async function caseE0Declaration(ctx) {
  const { sdk, contractId } = ctx;
  console.log('\n--- e0. the published contract declares elected moderation, interim owner, three lists ---');
  const moderation = ctx.contract.config.moderation;
  const moderators = moderation?.moderators;
  check('e0a the parsed config keeps banlist, suspensions and warnings',
    moderation?.banlist === true && moderation?.suspensions === true && moderation?.warnings === true, describeValue(moderation));
  check('e0b the moderators are elected with the contract owner as the interim',
    moderators?.$type === 'elected' && moderators?.interim?.$type === 'contractOwner', describeValue(moderators));
  const declared = V10.config.moderation.moderators;
  check('e0c the published declaration is the committed one (windows, seat, additions, abilities incl. report changeDocumentFields, owner protection)',
    moderators?.joinWindow === declared.joinWindow && moderators?.voteWindow === declared.voteWindow
      && moderators?.seatContestable === declared.seatContestable && moderators?.maxAddedModerators === declared.maxAddedModerators
      && moderators?.ownerProtected === declared.ownerProtected
      && JSON.stringify(moderators?.moderatedDocumentTypes) === JSON.stringify(declared.moderatedDocumentTypes),
    describeValue(moderators));
  const seated = await readback(() => sdk.moderationCharters.seatedCharter(contractId));
  ctx.seated = seated !== undefined && seated !== null;
  check(`e0d the seat is read (${ctx.seated ? 'a charter IS seated: moderator cases will skip' : 'no charter seated: the interim owner moderates'})`, true);
}

async function caseD1DistinctFrom(ctx) {
  const { botA, botB } = ctx;
  console.log('\n--- d1. distinctFrom $ownerId: self-follow, self-block, self-request refused (10419) ---');
  const self = bs58.decode(botA.ownerId);
  await expectCreateRefused(ctx, 'd1a a self-follow is refused (10419)', botA, 'follow', followData({ followingId: self }), NOT_DISTINCT);
  await expectCreateRefused(ctx, 'd1b a self-block is refused (10419)', botA, 'block', blockData({ blockedId: self }), NOT_DISTINCT);
  await expectCreateRefused(ctx, 'd1c a self follow-request is refused (10419)', botA, 'followRequest', followRequestData({ targetId: self }), NOT_DISTINCT);
  const existing = await queryOne(ctx, 'follow', [['$ownerId', '==', botA.ownerId], ['followingId', '==', botB.ownerId]]);
  if (existing) {
    check('d1d A already follows B (an earlier run): the control is the existing follow', true, `id=${idOf(existing.id)}`);
  } else {
    const follow = await attemptCreate(ctx.sdk, botA, { contractId: ctx.contractId, docType: 'follow', data: followData({ followingId: bs58.decode(botB.ownerId) }) });
    expectAccepted('d1d a follow of someone else lands (control)', follow);
  }
}

async function caseP1PrivateFeedGates(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- p1. private-feed gates: feed state required, request required, self-grant refused ---');
  // A is the feed owner. privateFeedState is permanent and unique per owner, so
  // a re-run finds it; the "no feed yet" probes only run on A's first pass.
  let feedState = await queryOne(ctx, 'privateFeedState', [['$ownerId', '==', botA.ownerId]]);
  if (!feedState) {
    await expectCreateRefused(ctx, 'p1a a rekey by an identity with NO privateFeedState is refused (40120 on $ownerId)', botA, 'privateFeedRekey', rekeyData(), REFERENCE_NOT_FOUND, NOT_FOUND_ON_OWNER);
    await expectCreateRefused(ctx, 'p1b a grant by an identity with NO privateFeedState is refused (40120 on $ownerId)', botA, 'privateFeedGrant', grantData({ recipientId: bs58.decode(botB.ownerId) }), REFERENCE_NOT_FOUND, NOT_FOUND_ON_OWNER);
    const enabled = await attemptCreate(sdk, botA, { contractId, docType: 'privateFeedState', data: feedStateData() });
    expectAccepted('p1c A enables a private feed (privateFeedState)', enabled);
    feedState = enabled.ok ? await queryOne(ctx, 'privateFeedState', [['$ownerId', '==', botA.ownerId]]) : null;
  } else {
    console.log(`SKIP  p1a–p1c: A already has a privateFeedState (${idOf(feedState.id)}) from an earlier run; the no-feed probes need a fresh owner (--bot)`);
  }
  if (!feedState) { check('p1 fixture', false, 'A has no privateFeedState'); return; }

  // Clear what an earlier run left: B's request and A's grant to B.
  const staleGrant = await queryOne(ctx, 'privateFeedGrant', [['$ownerId', '==', botA.ownerId], ['recipientId', '==', botB.ownerId]]);
  if (staleGrant) await deleteOwn(ctx, botA, 'privateFeedGrant', idOf(staleGrant.id));
  const staleRequest = await queryOne(ctx, 'followRequest', [['targetId', '==', botA.ownerId], ['$ownerId', '==', botB.ownerId]]);
  if (staleRequest) await deleteOwn(ctx, botB, 'followRequest', idOf(staleRequest.id));
  if (staleGrant || staleRequest) await settle();

  const leafIndex = Number(BigInt.asUintN(10, BigInt(Date.now())));
  await expectCreateRefused(ctx, 'p1d a grant to B with NO followRequest from B is refused (40120 on recipientId)', botA, 'privateFeedGrant', grantData({ recipientId: bs58.decode(botB.ownerId), leafIndex }), REFERENCE_NOT_FOUND, NOT_FOUND_ON_RECIPIENT);

  const request = await attemptCreate(sdk, botB, { contractId, docType: 'followRequest', data: followRequestData({ targetId: bs58.decode(botA.ownerId) }) });
  expectAccepted('p1e B files a followRequest to A', request);
  const grant = await attemptCreate(sdk, botA, { contractId, docType: 'privateFeedGrant', data: grantData({ recipientId: bs58.decode(botB.ownerId), leafIndex }) });
  expectAccepted('p1f A\'s grant to B lands once B\'s request exists', grant);

  // The client's stale-request cleanup: the requester deletes the request after
  // approval. A grant is never replaced, so nothing re-validates it.
  if (request.ok && grant.ok) {
    const cleanupError = await deleteOwn(ctx, botB, 'followRequest', request.id);
    await settle();
    check('p1g B deletes its request after approval (the client\'s cleanup)', (await fetchDocument(sdk, contractId, 'followRequest', request.id)) === null, (cleanupError ?? '').slice(0, 160));
    check('p1h …and A\'s grant to B is still there', (await fetchDocument(sdk, contractId, 'privateFeedGrant', grant.id)) !== null);
  }

  await expectCreateRefused(ctx, 'p1i a self-grant is refused (10419 distinctFrom, before the request lookup)', botA, 'privateFeedGrant', grantData({ recipientId: bs58.decode(botA.ownerId), leafIndex: (leafIndex + 1) % 1024 }), NOT_DISTINCT);

  // A rekey by the feed owner: the key generation is unique per owner, so pick a fresh one.
  const keyGeneration = 2 + Number(BigInt.asUintN(20, BigInt(Date.now())));
  const rekey = await attemptCreate(sdk, botA, { contractId, docType: 'privateFeedRekey', data: rekeyData({ keyGeneration, revokedLeaf: leafIndex }) });
  expectAccepted('p1j a rekey by the feed owner lands (ownerRefersTo satisfied)', rekey);
}

async function caseB1TypedBlockFollows(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- b1. blockFollow.followedBlockers as a typed identifier array ---');
  // blockFollow is unique per owner; start from a clean slate so the create path is exercised.
  const stale = await queryOne(ctx, 'blockFollow', [['$ownerId', '==', botA.ownerId]]);
  if (stale) { await deleteOwn(ctx, botA, 'blockFollow', idOf(stale.id)); await settle(); }

  const ghost = randomIdBytes();
  await expectCreateRefused(ctx, 'b1a an element naming no identity is refused (40120 on followedBlockers[0])', botA, 'blockFollow', blockFollowData([ghost]), REFERENCE_NOT_FOUND);
  await expectCreateRefused(ctx, 'b1b the owner\'s own id as an element is refused (10419)', botA, 'blockFollow', blockFollowData([botB.ownerId, botA.ownerId]), NOT_DISTINCT);
  await expectCreateRefused(ctx, 'b1c a duplicate element is refused (uniqueItems)', botA, 'blockFollow', blockFollowData([botB.ownerId, botB.ownerId]), DUPLICATE_ITEMS);

  const created = await attemptCreate(sdk, botA, { contractId, docType: 'blockFollow', data: blockFollowData([botB.ownerId]) });
  expectAccepted('b1d followedBlockers [B] lands as an identifier list', created);
  if (!created.ok) return;
  const stored = await fetchDocument(sdk, contractId, 'blockFollow', created.id);
  const list = stored?.toJSON?.().followedBlockers;
  check('b1e it reads back as a LIST of base58 ids, not packed bytes', Array.isArray(list) && list.length === 1 && list[0] === botB.ownerId, describeValue(list));

  const withOwner = await attemptReplace(sdk, botA, { contractId, docType: 'blockFollow', id: created.id, revision: BigInt(stored?.revision ?? 1), data: blockFollowData([botB.ownerId, ctx.ownerId]) });
  expectAccepted('b1f a replace growing the list to [B, contract owner] lands', withOwner);
}

async function caseW1Warnings(ctx) {
  const { sdk, contractId, botB, moderator } = ctx;
  console.log('\n--- w1. warnings: a record, not a bar; accumulate; clear ---');
  if (interimOnly(ctx, 'w1')) return;
  const post = await createPost(ctx, botB, 'a post the warning cites');
  // Start clean: a warning left by an earlier run would shift every count.
  await errorOf(() => sdk.contracts.clearUserWarnings({ identity: moderator.identity, contractId, identityId: botB.ownerId, signer: moderator.signer }));
  const warn = (text) => errorOf(() => sdk.contracts.warnUser({
    identity: moderator.identity, contractId, identityId: botB.ownerId, signer: moderator.signer,
    reason: { text, ...(post ? { documents: [{ documentTypeName: 'post', documentId: post }] } : {}) },
  }));
  const first = await warn('v10 battery warning 1');
  check('w1a the interim owner warns B, citing the post', first === null, (first ?? '').slice(0, 200));
  await settle();
  const status = await standingOf(ctx, botB.ownerId, ['warnings']);
  check('w1b moderationStatus proves one warning with its reason', status.warnings?.length === 1 && status.warnings[0].reason?.text === 'v10 battery warning 1', describeValue(status));

  const bookmark = post ? await attemptCreate(sdk, botB, { contractId, docType: 'bookmark', data: { postId: bs58.decode(post) } }) : null;
  if (bookmark) expectAccepted('w1c a warned identity still writes (a warning bars nothing)', bookmark);

  const second = await warn('v10 battery warning 2');
  check('w1d a second warning is accepted', second === null, (second ?? '').slice(0, 200));
  await settle();
  const two = await standingOf(ctx, botB.ownerId, ['warnings']);
  check('w1e warnings accumulate, oldest first', two.warnings?.length === 2 && two.warnings[1].reason?.text === 'v10 battery warning 2', describeValue(two));
  // Paged in identity-id order: walk until B is found or the list ends.
  let listed = false;
  let scanned = 0;
  for (let startAfter; !listed;) {
    const page = await readback(() => sdk.contracts.moderationEntries({ contractId, list: 'warnings', ...(startAfter ? { startAfter } : {}) }));
    scanned += page.entries.length;
    listed = page.entries.some((entry) => entry.identityId === botB.ownerId);
    if (!page.nextStartAfter) break;
    startAfter = page.nextStartAfter;
  }
  check('w1f the warnings list lists B', listed, `scanned ${scanned} entries`);

  const cleared = await errorOf(() => sdk.contracts.clearUserWarnings({ identity: moderator.identity, contractId, identityId: botB.ownerId, signer: moderator.signer }));
  check('w1g clearWarnings lands', cleared === null, (cleared ?? '').slice(0, 200));
  await settle();
  const none = await standingOf(ctx, botB.ownerId, ['warnings']);
  check('w1h …and the status proves no warnings', Array.isArray(none.warnings) && none.warnings.length === 0, describeValue(none));
  const again = await errorOf(() => sdk.contracts.clearUserWarnings({ identity: moderator.identity, contractId, identityId: botB.ownerId, signer: moderator.signer }));
  expectRejected('w1i clearing an identity with no warnings is refused (41117)', asOutcome(again), NOT_WARNED);
}

async function caseM1DeleteRestore(ctx) {
  const { sdk, contractId, botB, moderator } = ctx;
  console.log('\n--- m1. the interim owner deletes and restores a post ---');
  if (interimOnly(ctx, 'm1')) return;
  const postId = await createPost(ctx, botB, 'to be removed and restored');
  if (!postId) { check('m1 fixture', false, 'no post'); return; }
  // A restore must bring back the document AS IT WAS: keep the fetched instance.
  const before = await fetchDocument(sdk, contractId, 'post', postId);
  try {
    const removal = await sdk.contracts.moderatorDeleteDocument({ identity: moderator.identity, contractId, documentTypeName: 'post', documentId: postId, reason: { text: 'v10 battery takedown' }, signer: moderator.signer });
    check('m1a the interim owner deletes B\'s post', idOf(removal.documentOwnerId) === botB.ownerId, `hash=${removal.documentHash}`);
  } catch (e) {
    check('m1a the interim owner deletes B\'s post', false, describeErr(e).slice(0, 220));
    return;
  }
  await settle();
  check('m1b the post no longer fetches', (await fetchDocument(sdk, contractId, 'post', postId)) === null);

  const restore = () => sdk.contracts.moderatorRestoreDocument({ identity: moderator.identity, contractId, documentTypeName: 'post', document: before, signer: moderator.signer });
  try {
    const record = await restore();
    check('m1c the owner restores it; the record is marked restored', record.restoredBy !== undefined && idOf(record.restoredBy) === moderator.ownerId, describeValue({ restoredBy: record.restoredBy && idOf(record.restoredBy), restoredAt: record.restoredAt }));
  } catch (e) {
    check('m1c the owner restores it', false, describeErr(e).slice(0, 220));
    return;
  }
  await settle();
  check('m1d the post fetches again', (await fetchDocument(sdk, contractId, 'post', postId)) !== null);
  const again = await errorOf(restore);
  expectRejected('m1e restoring a live document is refused (41122)', asOutcome(again), ALREADY_RESTORED);
}

async function caseM2InterimBan(ctx) {
  const { sdk, contractId, botB, moderator } = ctx;
  console.log('\n--- m2. the interim owner bans and unbans (v8 authority before any seat) ---');
  if (interimOnly(ctx, 'm2')) return;
  const probe = () => attemptCreate(sdk, botB, { contractId, docType: 'block', data: blockData({ blockedId: randomIdBytes() }) });
  try {
    await sdk.contracts.banUser({ identity: moderator.identity, contractId, identityId: botB.ownerId, reason: { text: 'v10 battery ban' }, signer: moderator.signer });
    check('m2a the interim owner bans B', true);
  } catch (e) {
    check('m2a the interim owner bans B', false, describeErr(e).slice(0, 220));
    return;
  }
  try {
    await settle();
    expectRejected('m2b B\'s create while banned is refused (41107)', await probe(), BANNED);
  } finally {
    const unban = await errorOf(() => sdk.contracts.unbanUser({ identity: moderator.identity, contractId, identityId: botB.ownerId, signer: moderator.signer }));
    check('m2c the owner unbans B', unban === null, unban ? `${unban.slice(0, 200)} — B MAY STILL BE BANNED; unban by hand` : '');
  }
  await settle();
  const after = await standingOf(ctx, botB.ownerId, ['banlist']);
  check('m2d B is no longer banned', after.banned === false, describeValue(after));
}

// ---- $ownerId agreements (carried from v7, `where` since beta.7) ---------------
//
// Fixtures: posts and the reply are owned by B, so A's likes and reposts agree
// against a DIFFERENT identity. Likes pay in credits (the token cost is
// optional); a repost is a post, so it carries the post's action fee agreement.

/** A post owned by B, created once per run and keyed by role. */
async function ensurePost(ctx, key, overrides = {}) {
  if (ctx.posts[key]) return ctx.posts[key];
  const id = await createFeed(ctx, ctx.botB, 'post', postData({ content: `battery ${key}`, ...overrides }), key);
  if (id) ctx.posts[key] = id;
  return id;
}

/** A reply by B on B's anchor post, for the likeReply agreement. */
async function ensureReply(ctx) {
  if (ctx.replyId) return ctx.replyId;
  const rootPostId = await ensurePost(ctx, 'anchor');
  if (!rootPostId) return null;
  ctx.replyId = await createFeed(ctx, ctx.botB, 'reply', replyData({
    rootPostId: bs58.decode(rootPostId),
    parentOwnerId: bs58.decode(ctx.botB.ownerId),
    content: 'battery anchor reply',
  }), 'the anchor reply');
  return ctx.replyId;
}

async function caseO1LikeOwnerAgreement(ctx) {
  const { botA, botB } = ctx;
  console.log('\n--- o1. like.postAuthor agrees with the post\'s $ownerId (40127) ---');
  const tagged = await ensurePost(ctx, 'tagged', { hashtag: ctx.tag });
  const untagged = await ensurePost(ctx, 'untagged');
  const spare = await ensurePost(ctx, 'spare', { hashtag: ctx.tag });
  if (!tagged || !untagged || !spare) { check('o1 fixture', false, 'fixture posts unavailable'); return; }
  const likeOn = (postId, data) => attemptCreateIndexOnly(ctx.sdk, botA, {
    contractId: ctx.contractId,
    docType: 'like',
    data: likeData({ postId: bs58.decode(postId), ...data }),
    accepted: () => entryExists(ctx.sdk, ctx.contractId, 'like', 'postId', postId, botA.ownerId),
  });
  const owner = bs58.decode(botB.ownerId);

  // Every violation targets a post A has NOT yet liked: the 40105 uniqueness
  // probe fires before the agreement check and would mask the 40127.
  expectRejected('o1a a like whose postAuthor is the LIKER is refused', await likeOn(tagged, { hashtag: ctx.tag, postAuthor: bs58.decode(botA.ownerId) }), PROPERTY_MISMATCH);
  expectRejected('o1b a like whose postAuthor is an unrelated identity is refused', await likeOn(tagged, { hashtag: ctx.tag, postAuthor: randomIdBytes() }), PROPERTY_MISMATCH);
  expectRejected('o1c the hashtag pair holds: a wrong tag is refused', await likeOn(tagged, { hashtag: `${ctx.tag}x`, postAuthor: owner }), PROPERTY_MISMATCH);
  expectRejected('o1d absence is strict: a tagged like on an UNTAGGED post is refused', await likeOn(untagged, { hashtag: ctx.tag, postAuthor: owner }), PROPERTY_MISMATCH);
  expectRejected('o1e and the other way: a hashtag-ABSENT like on a TAGGED post is refused', await likeOn(spare, { postAuthor: owner }), PROPERTY_MISMATCH);
  expectAccepted('o1f a like naming the post owner\'s $ownerId (and its tag) is accepted', await likeOn(tagged, { hashtag: ctx.tag, postAuthor: owner }));
  expectAccepted('o1g both-absent agrees: a hashtag-less like on an untagged post', await likeOn(untagged, { postAuthor: owner }));
}

async function caseO2LikeReplyOwnerAgreement(ctx) {
  const { botA, botB } = ctx;
  console.log('\n--- o2. likeReply.replyAuthor agrees with the reply\'s $ownerId (40127) ---');
  const replyId = await ensureReply(ctx);
  if (!replyId) { check('o2 fixture', false, 'no anchor reply available'); return; }
  const likeReplyCount = () => countBy(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId);
  const likeReplyOn = (replyAuthor, accepted) => attemptCreateIndexOnly(ctx.sdk, botA, {
    contractId: ctx.contractId,
    docType: 'likeReply',
    data: likeReplyData({ replyId: bs58.decode(replyId), replyAuthor }),
    accepted: accepted ?? (() => entryExists(ctx.sdk, ctx.contractId, 'likeReply', 'replyId', replyId, botA.ownerId)),
  });

  expectRejected('o2a a reply like whose replyAuthor is the LIKER is refused', await likeReplyOn(bs58.decode(botA.ownerId)), PROPERTY_MISMATCH);
  expectAccepted('o2b a reply like naming the reply owner\'s $ownerId is accepted', await likeReplyOn(bs58.decode(botB.ownerId)));
  // o2b's entry makes the existence probe true whatever consensus decides, so
  // the duplicate is scored by the entry COUNT rising above its baseline.
  const beforeDuplicate = await likeReplyCount();
  expectRejected('o2c re-liking the same reply is the structural duplicate (40105)',
    await likeReplyOn(bs58.decode(botB.ownerId), async () => (await likeReplyCount()) > beforeDuplicate), DUPLICATE_UNIQUE);
}

async function caseO3RepostOwnerAgreement(ctx) {
  const { botA, botB } = ctx;
  console.log('\n--- o3. a bare repost names the post\'s real owner in quotedPostOwnerId (40127) ---');
  const postId = await ensurePost(ctx, 'reposted');
  if (!postId) { check('o3 fixture', false, 'no post to repost'); return; }
  const repostWith = (ownerId) => repostOf({ postId: bs58.decode(postId), ownerId });
  // Without the agreement a repost could name any identity in quotedPostOwnerRecent
  // and show it "X reposted your post" for a post that is not theirs. The
  // refusals come first: once A's repost lands, another is the 40105 of
  // ownerAndQuotedPost, which would mask the agreement.
  await expectFeedRefused(ctx, 'o3a a bare repost naming a third party in quotedPostOwnerId is refused', botA, 'post', repostWith(randomIdBytes()), PROPERTY_MISMATCH);
  await expectFeedRefused(ctx, 'o3b a bare repost naming the REPOSTER in quotedPostOwnerId is refused', botA, 'post', repostWith(bs58.decode(botA.ownerId)), PROPERTY_MISMATCH);
  expectAccepted('o3c a bare repost naming the post owner\'s $ownerId is accepted', await createFeedOutcome(ctx, botA, 'post', repostWith(bs58.decode(botB.ownerId))));
}

async function caseO4QuoteAndParentOwner(ctx) {
  const { botA, botB } = ctx;
  console.log('\n--- o4. a quote and a nested reply name their target\'s real owner (40127, beta.6) ---');
  const postId = await ensurePost(ctx, 'anchor');
  const replyId = await ensureReply(ctx);
  if (!postId || !replyId) { check('o4 fixture', false, 'no anchor post or reply'); return; }
  const [post, reply, a, b] = [postId, replyId, botA.ownerId, botB.ownerId].map((id) => bs58.decode(id));
  const create = async (docType, data) => {
    const { agreement } = await feeAgreement(ctx, docType === 'post' ? POST_ACTION_FEE : REPLY_ACTION_FEE);
    return manualCreate(ctx, botA, { docType, data, agreement });
  };
  expectRejected('o4a a quote of B\'s post naming A as its owner is refused', await create('post', postData({ content: 'o4 forged quote owner', quotedPostId: post, quotedPostOwnerId: a })), PROPERTY_MISMATCH);
  expectRejected('o4b a quote of B\'s reply naming A as its owner is refused', await create('post', { ...postData({ content: 'o4 forged reply-quote owner', quotedPostOwnerId: a }), quotedReplyId: reply }), PROPERTY_MISMATCH);
  expectAccepted('o4c a quote of B\'s reply naming B lands', await create('post', { ...postData({ content: 'o4 reply quote', quotedPostOwnerId: b }), quotedReplyId: reply }));
  expectRejected('o4d a reply to B\'s reply naming A as the parent owner is refused', await create('reply', { ...replyData({ content: 'o4 forged parent', rootPostId: post, parentOwnerId: a }), replyToReplyId: reply }), PROPERTY_MISMATCH);
  expectAccepted('o4e a reply to B\'s reply naming B lands', await create('reply', { ...replyData({ content: 'o4 nested reply', rootPostId: post, parentOwnerId: b }), replyToReplyId: reply }));
}


// ---- v10: real deletes -----------------------------------------------------------

async function caseX1RealDeletes(ctx) {
  const { sdk, contractId, botA, botB, moderator } = ctx;
  console.log('\n--- x1. real deletes: the post is gone, counts drop, nothing new may point at it (40120) ---');
  const target = await createFeed(ctx, botB, 'post', postData({ content: `x1 target ${Date.now()}`, hashtag: ctx.tag }), 'x1 target');
  if (!target) { check('x1 fixture', false, 'no target post'); return; }
  const [targetBytes, owner] = [target, botB.ownerId].map((id) => bs58.decode(id));
  // One quote and one reply by A, so the counts have something to lose.
  const quote = await createFeed(ctx, botA, 'post', postData({ content: 'x1 quote', quotedPostId: targetBytes, quotedPostOwnerId: owner }), 'x1 quote');
  const reply = await createFeed(ctx, botA, 'reply', replyData({ content: 'x1 reply', rootPostId: targetBytes, parentOwnerId: owner }), 'x1 reply');
  if (!quote || !reply) { check('x1 fixtures', false, 'the quote or reply did not land'); return; }
  await settle();

  const stored = await fetchDocument(sdk, contractId, 'post', target);
  const replaced = await attemptReplace(sdk, botB, { contractId, docType: 'post', id: target, revision: BigInt(stored?.revision ?? 1), data: postData({ content: 'x1 edited', hashtag: ctx.tag }) });
  expectRejected('x1a a post cannot be replaced (documentsMutable false: no editing)', replaced, NOT_MUTABLE);

  const quoteBefore = await countBy(sdk, contractId, 'post', 'quotedPostId', target);
  const replyBefore = await countBy(sdk, contractId, 'reply', 'rootPostId', target);
  check('x1b before the delete the post has one quote and one reply', quoteBefore === 1 && replyBefore === 1, `quotes=${quoteBefore} replies=${replyBefore}`);

  // A's own quote first: an author's delete of a document others point at.
  const quoteDeleted = await deleteOwn(ctx, botA, 'post', quote);
  const deleted = await deleteOwn(ctx, botB, 'post', target);
  await settle();
  check('x1c B deletes its own post (a real delete, no tombstone)', deleted === null && (await fetchDocument(sdk, contractId, 'post', target)) === null, (deleted ?? '').slice(0, 200));
  check('x1d …and A deletes its quote: the quote count drops to 0 exactly', quoteDeleted === null && (await countBy(sdk, contractId, 'post', 'quotedPostId', target)) === 0, (quoteDeleted ?? '').slice(0, 160));
  check('x1e the existing reply stays (its reference dangles), counted under the dead root', (await fetchDocument(sdk, contractId, 'reply', reply)) !== null && (await countBy(sdk, contractId, 'reply', 'rootPostId', target)) === 1);
  const replyDeleted = await deleteOwn(ctx, botA, 'reply', reply);
  await settle();
  check('x1f A deletes the reply under the deleted root (a v9 tombstone could not): the reply count drops to 0', replyDeleted === null && (await countBy(sdk, contractId, 'reply', 'rootPostId', target)) === 0, (replyDeleted ?? '').slice(0, 160));

  // Every new pointer at the deleted post is refused: QA D-14 in consensus.
  await expectFeedRefused(ctx, 'x1g a reply to the deleted post is refused (40120)', botA, 'reply', replyData({ content: 'x1 late reply', rootPostId: targetBytes, parentOwnerId: owner }), REFERENCE_NOT_FOUND);
  await expectFeedRefused(ctx, 'x1h a quote of the deleted post is refused (40120)', botA, 'post', postData({ content: 'x1 late quote', quotedPostId: targetBytes, quotedPostOwnerId: owner }), REFERENCE_NOT_FOUND);
  await expectFeedRefused(ctx, 'x1i a bare repost of the deleted post is refused (40120)', botA, 'post', repostOf({ postId: targetBytes, ownerId: owner }), REFERENCE_NOT_FOUND);
  await expectCreateRefused(ctx, 'x1j a bookmark of the deleted post is refused (40120)', botA, 'bookmark', { postId: targetBytes }, REFERENCE_NOT_FOUND);
  await expectCreateRefused(ctx, 'x1k a report of the deleted post is refused (40120)', botA, 'report', reportData({ postId: targetBytes, targetOwnerId: owner }), REFERENCE_NOT_FOUND);
  expectRejected('x1l a like of the deleted post is refused (40120)', await attemptCreateIndexOnly(sdk, botA, {
    contractId, docType: 'like', data: likeData({ postId: targetBytes, hashtag: ctx.tag, postAuthor: owner }),
    accepted: () => entryExists(sdk, contractId, 'like', 'postId', target, botA.ownerId),
  }), REFERENCE_NOT_FOUND);

  // An author's delete leaves no removal record, so there is nothing to restore.
  if (interimOnly(ctx, 'x1m')) return;
  const restore = await errorOf(() => sdk.contracts.moderatorRestoreDocument({ identity: moderator.identity, contractId, documentTypeName: 'post', document: stored, signer: moderator.signer }));
  expectRejected('x1m a moderator cannot restore an author\'s own delete (41119: no removal record)', asOutcome(restore), NO_REMOVAL_RECORD);
}

// ---- v10: media hashes and content limits ----------------------------------------

async function caseX2MediaAndLimits(ctx) {
  const { sdk, contractId, botA } = ctx;
  console.log('\n--- x2. media hash + fingerprint (dependentRequired, 10101), 1000 characters / 2000 bytes (10101 / 10421), no language ---');
  const media = await mediaFields();
  // The reply cases need B's anchor post; its absence is a fixture failure, not an abort of x2.
  const anchorId = await ensurePost(ctx, 'anchor');
  const anchor = anchorId ? bs58.decode(anchorId) : null;
  if (!anchor) check('x2 reply fixture', false, 'no anchor post: x2c and x2j are skipped');
  await expectFeedRefused(ctx, 'x2a mediaUrl without its hash and fingerprint is refused (10101)', botA, 'post', postData({ content: 'x2 bare url', media: { mediaUrl: media.mediaUrl } }), SCHEMA_REFUSED);
  await expectFeedRefused(ctx, 'x2b a mediaHash without mediaUrl is refused (10101)', botA, 'post', postData({ content: 'x2 bare hash', media: { mediaHash: media.mediaHash } }), SCHEMA_REFUSED);
  if (anchor) await expectFeedRefused(ctx, 'x2c a reply with mediaUrl and no fingerprint is refused (10101)', botA, 'reply', { ...replyData({ content: 'x2 reply media', rootPostId: anchor, parentOwnerId: bs58.decode(ctx.botB.ownerId) }), mediaUrl: media.mediaUrl, mediaHash: media.mediaHash }, SCHEMA_REFUSED);
  const withMedia = await createFeedOutcome(ctx, botA, 'post', postData({ content: 'x2 with media', media }));
  expectAccepted('x2d mediaUrl with its 32-byte hash and 8-byte fingerprint lands', withMedia);
  if (withMedia.ok) {
    const stored = (await fetchDocument(sdk, contractId, 'post', withMedia.id))?.toJSON?.();
    check('x2e the hash and fingerprint read back', typeof stored?.mediaHash === 'string' && typeof stored?.mediaFingerprint === 'string', describeValue({ mediaHash: stored?.mediaHash, mediaFingerprint: stored?.mediaFingerprint }));
  }

  expectAccepted('x2f content of exactly 1000 characters lands', await createFeedOutcome(ctx, botA, 'post', postData({ content: 'x'.repeat(1000) })));
  await expectFeedRefused(ctx, 'x2g content of 1001 characters is refused (10101 maxLength)', botA, 'post', postData({ content: 'x'.repeat(1001) }), SCHEMA_REFUSED);
  // 667 three-byte characters: 667 code points (under 1000) but 2001 UTF-8 bytes.
  await expectFeedRefused(ctx, 'x2h 667 three-byte characters (2001 bytes) are refused (10421 maxBytes)', botA, 'post', postData({ content: '€'.repeat(667) }), MAX_BYTES);
  expectAccepted('x2i 666 three-byte characters (1998 bytes) land', await createFeedOutcome(ctx, botA, 'post', postData({ content: '€'.repeat(666) })));
  if (anchor) await expectFeedRefused(ctx, 'x2j a reply over 2000 bytes is refused too (10421)', botA, 'reply', replyData({ content: '€'.repeat(667), rootPostId: anchor, parentOwnerId: bs58.decode(ctx.botB.ownerId) }), MAX_BYTES);
  await expectFeedRefused(ctx, 'x2k a post carrying `language` is refused (10101: the property is gone)', botA, 'post', { ...postData({ content: 'x2 language' }), language: 'en' }, SCHEMA_REFUSED);

  // The global timeline replaces the per-language one: a fresh post heads it.
  const fresh = await createFeed(ctx, botA, 'post', postData({ content: `x2 timeline ${Date.now()}` }), 'x2 timeline post');
  if (fresh) {
    const page = await readback(() => sdk.documents.query({ dataContractId: contractId, documentTypeName: 'post', where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']], limit: 20 }));
    check('x2l the global timeline [$createdAt] lists the fresh post among the newest 20', [...page.keys()].map(idOf).includes(fresh), `${page.size} posts`);
  }
}

// ---- v10: the DashPay profile extension ------------------------------------------

async function caseX3ProfileExtension(ctx) {
  const { sdk, contractId, botA, moderator } = ctx;
  console.log('\n--- x3. yapprProfile needs a DashPay profile (ownerRefersTo, 40120), one per owner (40105) ---');
  const fresh = await freshActor(ctx);
  if (!fresh) {
    console.log('SKIP  x3a: needs --fresh-bot <n>, an identity with no DashPay profile');
  } else if (await queryOne(ctx, 'profile', [['$ownerId', '==', fresh.ownerId]], DASHPAY_CONTRACT_ID)) {
    console.log(`SKIP  x3a: ${fresh.label} already has a DashPay profile`);
  } else {
    await expectCreateRefused(ctx, 'x3a an extension by an identity with NO DashPay profile is refused (40120 on $ownerId)', fresh, 'yapprProfile', yapprProfileData(), REFERENCE_NOT_FOUND, NOT_FOUND_ON_OWNER);
  }

  // A's DashPay profile: write it when missing (a system contract; ordinary create).
  let base = await queryOne(ctx, 'profile', [['$ownerId', '==', botA.ownerId]], DASHPAY_CONTRACT_ID);
  if (!base) {
    const created = await attemptCreate(sdk, botA, { contractId: DASHPAY_CONTRACT_ID, docType: 'profile', data: dashpayProfileData(`battery ${botA.ownerId.slice(0, 6)}`) });
    expectAccepted('x3b A writes a DashPay profile', created);
    base = created.ok ? await queryOne(ctx, 'profile', [['$ownerId', '==', botA.ownerId]], DASHPAY_CONTRACT_ID) : null;
  } else {
    check('x3b A already has a DashPay profile (an earlier run)', true, `id=${idOf(base.id)}`);
  }
  if (!base) { check('x3 fixture', false, 'A has no DashPay profile'); return; }

  const stale = await queryOne(ctx, 'yapprProfile', [['$ownerId', '==', botA.ownerId]]);
  if (stale) { await deleteOwn(ctx, botA, 'yapprProfile', idOf(stale.id)); await settle(); }
  const extension = await attemptCreate(sdk, botA, { contractId, docType: 'yapprProfile', data: yapprProfileData() });
  expectAccepted('x3c with a DashPay profile, A\'s yapprProfile extension lands', extension);
  if (!extension.ok) return;
  await expectCreateRefused(ctx, 'x3d a second extension by A is refused (40105, one per owner)', botA, 'yapprProfile', { location: 'Twice' }, DUPLICATE_UNIQUE);
  await expectCreateRefused(ctx, 'x3e an empty extension is refused (10101, minProperties 1)', botA, 'yapprProfile', {}, SCHEMA_REFUSED);

  if (interimOnly(ctx, 'x3f')) return;
  try {
    const removal = await sdk.contracts.moderatorDeleteDocument({ identity: moderator.identity, contractId, documentTypeName: 'yapprProfile', documentId: extension.id, reason: { text: 'v10 battery profile takedown' }, signer: moderator.signer });
    check('x3f the moderator deletes the extension, keeping a removal record', idOf(removal?.documentOwnerId ?? '') === botA.ownerId, describeValue({ owner: removal?.documentOwnerId && idOf(removal.documentOwnerId) }));
  } catch (e) {
    check('x3f the moderator deletes the extension', false, describeErr(e).slice(0, 220));
  }
}

// ---- v10: propertyConstraints ---------------------------------------------------

async function caseC1PropertyConstraints(ctx) {
  const { botA } = ctx;
  console.log('\n--- c1. propertyConstraints: post and reply co-occurrence rules (10422) ---');
  const anchor = await ensurePost(ctx, 'anchor');
  const fields = (data) => ({ ...data, ...(data.rootPostId ? { rootPostId: bs58.decode(anchor), parentOwnerId: bs58.decode(ctx.botB.ownerId) } : {}) });
  for (const docType of ['post', 'reply']) {
    if (docType === 'reply' && !anchor) { check('c1 reply fixture', false, 'no anchor post'); continue; }
    for (const [label, data, rule] of refusedCreates(CONTRACT_FILE.replace('contracts/', ''), docType)) {
      await expectFeedRefused(ctx, `c1 ${label} is refused (10422 ${rule})`, botA, docType, fields(data), constraintViolation(rule));
    }
  }
}

// ---- v10: reports the moderators resolve ------------------------------------------

/** The moderator's field change; answers the error or null. */
const changeReport = (ctx, who, documentId, fields, reason) => errorOf(() => ctx.sdk.contracts.moderatorChangeDocumentFields({
  identity: who.identity, contractId: ctx.contractId, documentTypeName: 'report', documentId, fields, signer: who.signer,
  ...(reason ? { reason } : {}),
}));

async function caseR1Reports(ctx) {
  const { sdk, contractId, botA, botB, moderator } = ctx;
  console.log('\n--- r1. reports: one per reporter and target, author-agreed, resolved by a moderator (status/resolution), purged without a record ---');
  const postId = await ensurePost(ctx, 'anchor');
  const replyId = await ensureReply(ctx);
  const otherId = await ensurePost(ctx, 'reported');
  if (!postId || !replyId || !otherId) { check('r1 fixture', false, 'no anchor post, anchor reply or second post'); return; }
  const [post, reply, other, author] = [postId, replyId, otherId, botB.ownerId].map((id) => bs58.decode(id));
  const report = (data) => attemptCreate(sdk, botA, { contractId, docType: 'report', data: reportData(data) });

  const postReport = await report({ postId: post, targetOwnerId: author, reason: 0 });
  expectAccepted('r1a A reports B\'s post', postReport);
  await expectCreateRefused(ctx, 'r1b a second report of the same post by A is refused (40105)', botA, 'report', reportData({ postId: post, targetOwnerId: author, reason: 1 }), DUPLICATE_UNIQUE);
  const replyReport = await report({ replyId: reply, targetOwnerId: author, reason: 8, note: 'v10 battery report' });
  expectAccepted('r1c A reports B\'s reply ("something else", with a note)', replyReport);
  await expectCreateRefused(ctx, 'r1d a report naming someone other than the author is refused (40127)', botA, 'report', reportData({ postId: other, targetOwnerId: randomIdBytes(), reason: 0 }), PROPERTY_MISMATCH);
  await expectCreateRefused(ctx, 'r1e B reporting its own post is refused (10419)', botB, 'report', reportData({ postId: post, targetOwnerId: author, reason: 0 }), NOT_DISTINCT);
  await expectCreateRefused(ctx, 'r1f a report of a post that does not exist is refused (40120)', botA, 'report', reportData({ postId: randomIdBytes(), targetOwnerId: author, reason: 0 }), REFERENCE_NOT_FOUND);
  for (const [label, data, rule] of refusedCreates(CONTRACT_FILE.replace('contracts/', ''), 'report')) {
    const fields = { ...data, ...(data.postId ? { postId: other } : {}), ...(data.replyId ? { replyId: reply } : {}), targetOwnerId: author };
    await expectCreateRefused(ctx, `r1g ${label} is refused (10422 ${rule})`, botA, 'report', fields, constraintViolation(rule));
  }
  // The moderators' fields: a reporter can never file a report already "handled".
  await expectCreateRefused(ctx, 'r1h a reporter setting `status` is refused (41124)', botA, 'report', reportData({ postId: other, targetOwnerId: author, reason: 0, status: 1 }), MODERATOR_FIELD);

  if (replyReport.ok) {
    const withdrawn = await deleteOwn(ctx, botA, 'report', replyReport.id);
    await settle();
    check('r1i A withdraws its reply report', withdrawn === null && (await fetchDocument(sdk, contractId, 'report', replyReport.id)) === null, (withdrawn ?? '').slice(0, 160));
  }

  if (!postReport.ok || interimOnly(ctx, 'r1j–r1s')) return;
  const resolved = await changeReport(ctx, moderator, postReport.id, { status: 2, resolution: 'post removed' }, { text: 'v10 battery: report reviewed', documents: [{ documentTypeName: 'post', documentId: postId }] });
  check('r1j the interim owner resolves A\'s report (status 2, a resolution)', resolved === null, (resolved ?? '').slice(0, 220));
  await settle();
  const handled = await fetchDocument(sdk, contractId, 'report', postReport.id);
  const fields = handled?.toJSON?.() ?? {};
  check('r1k the report stays, carrying status and resolution', fields.status === 2 && fields.resolution === 'post removed', describeValue({ status: fields.status, resolution: fields.resolution }));
  check('r1l it is stamped $moderatedBy (the owner) and $moderatedAt, at revision 2',
    idOf(handled?.moderatedBy ?? '') === moderator.ownerId && handled?.moderatedAt !== undefined && BigInt(handled?.revision ?? 0) === 2n,
    describeValue({ moderatedBy: handled?.moderatedBy && idOf(handled.moderatedBy), moderatedAt: handled?.moderatedAt, revision: handled?.revision }));
  const byModerator = await readback(() => sdk.documents.query({ dataContractId: contractId, documentTypeName: 'report', where: [['$moderatedBy', '==', moderator.ownerId]], orderBy: [['$moderatedBy', 'asc'], ['$moderatedAt', 'desc']], limit: 50 }));
  check('r1m byModerator [$moderatedBy, $moderatedAt] lists it', [...byModerator.keys()].map(idOf).includes(postReport.id), `${byModerator.size} report(s)`);
  const byStatus = await readback(() => sdk.documents.query({ dataContractId: contractId, documentTypeName: 'report', where: [['status', '==', 2]], orderBy: [['status', 'asc'], ['$createdAt', 'desc']], limit: 50 }));
  check('r1n byStatus [status, $createdAt] lists it under status 2', [...byStatus.keys()].map(idOf).includes(postReport.id), `${byStatus.size} report(s)`);

  const noop = await changeReport(ctx, moderator, postReport.id, { status: 2, resolution: 'post removed' });
  expectRejected('r1o a change that changes nothing is refused (10905)', asOutcome(noop), FIELDS_INVALID);
  const foreign = await changeReport(ctx, moderator, postReport.id, { note: 'rewritten' });
  expectRejected('r1p a field outside changeFields is refused (41123)', asOutcome(foreign), FIELD_NOT_CHANGEABLE);
  const orphan = await changeReport(ctx, moderator, postReport.id, { resolution: 'status dropped', status: null });
  expectRejected('r1q a resolution without a status is refused (10422 resolvedHasStatus)', asOutcome(orphan), constraintViolation('resolvedHasStatus'));

  // References are not checked again: a report on a post that is gone still resolves.
  const gonePost = await createFeed(ctx, botB, 'post', postData({ content: `r1 gone ${Date.now()}` }), 'r1 gone post');
  const goneReport = gonePost ? await report({ postId: bs58.decode(gonePost), targetOwnerId: author, reason: 1 }) : { ok: false };
  if (goneReport.ok) {
    await deleteOwn(ctx, botB, 'post', gonePost);
    await settle();
    const late = await changeReport(ctx, moderator, goneReport.id, { status: 1 });
    check('r1r a report whose post was deleted can still be resolved', late === null, (late ?? '').slice(0, 200));
    // Purge: a report deletion keeps no record (deleteKeepsRecord false) and refunds nothing (ttl).
    const purged = await errorOf(async () => {
      const result = await sdk.contracts.moderatorDeleteDocument({ identity: moderator.identity, contractId, documentTypeName: 'report', documentId: goneReport.id, reason: { text: 'v10 battery purge' }, signer: moderator.signer });
      if (result !== undefined) throw new Error(`a removal record came back: ${describeValue(result)}`);
    });
    check('r1s the moderator purges a report and no removal record comes back', purged === null, (purged ?? '').slice(0, 200));
    await settle();
    check('r1t the purged report no longer fetches', (await fetchDocument(sdk, contractId, 'report', goneReport.id)) === null);
  } else {
    check('r1r–r1t fixture', false, 'no report on a post to delete');
  }
  // A resolved report keeps its unique entry, so a second report of the post stays refused.
  await expectCreateRefused(ctx, 'r1u a resolved report still holds its place (a re-report is 40105)', botA, 'report', reportData({ postId: post, targetOwnerId: author, reason: 3 }), DUPLICATE_UNIQUE);

  // Purge the resolved report: final, no record (a type that keeps none is refused by
  // documentRemovals, and nothing can be restored), and its unique entry goes with it.
  const reportDoc = await fetchDocument(sdk, contractId, 'report', postReport.id);
  const purge = await errorOf(() => sdk.contracts.moderatorDeleteDocument({ identity: moderator.identity, contractId, documentTypeName: 'report', documentId: postReport.id, reason: { text: 'v10 battery purge' }, signer: moderator.signer }));
  await settle();
  check('r1v the moderator purges the resolved report; it no longer fetches', purge === null && (await fetchDocument(sdk, contractId, 'report', postReport.id)) === null, (purge ?? '').slice(0, 200));
  const removals = await errorOf(() => sdk.contracts.documentRemovals({ contractId, documentTypeName: 'report', documentIds: [postReport.id] }));
  expectRejected('r1w documentRemovals refuses report: its deletions keep no record', asOutcome(removals), /whose moderators' deletions keep\s+records/i);
  if (reportDoc) {
    const restore = await errorOf(() => sdk.contracts.moderatorRestoreDocument({ identity: moderator.identity, contractId, documentTypeName: 'report', document: reportDoc, signer: moderator.signer }));
    expectRejected('r1x the purge cannot be restored (41119)', asOutcome(restore), NO_REMOVAL_RECORD);
  }
  expectAccepted('r1y A may report the post again once the report is purged', await report({ postId: post, targetOwnerId: author, reason: 0 }));
}

/**
 * r2, the publisher's POST-SEAT step: run once masternodes have seated a team,
 * with `--team-member bot:<n>` and `--reason-doc <id>` (a `reason` document the
 * seated proposal lists; a charter meant to handle reports should list one
 * such as REP "Report handled"). Skips on an unseated contract.
 */
async function caseR2SeatedResolution(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- r2. a seated team resolves reports: a listed reason is required (41203) ---');
  if (!ctx.seated) { console.log('SKIP  r2: no charter is seated yet; run it after the election seats a team'); return; }
  if (!TEAM_MEMBER_SPEC || !REASON_DOCUMENT_ID) { check('r2 needs --team-member bot:<n> and --reason-doc <id>', false); return; }
  const member = await resolveModerator(sdk, TEAM_MEMBER_SPEC);
  const postId = await createFeed(ctx, botB, 'post', postData({ content: `r2 reported ${Date.now()}` }), 'the r2 post');
  if (!postId) { check('r2 fixture', false, 'no post to report'); return; }
  const filed = await attemptCreate(sdk, botA, { contractId, docType: 'report', data: reportData({ postId: bs58.decode(postId), targetOwnerId: bs58.decode(botB.ownerId), reason: 0 }) });
  expectAccepted('r2a A reports B\'s post', filed);
  if (!filed.ok) return;
  const bare = await changeReport(ctx, member, filed.id, { status: 1 }, { text: 'v10 battery r2' });
  expectRejected('r2b a resolution citing no listed reason is refused (41203)', asOutcome(bare), REASON_NOT_LISTED);
  const listed = await changeReport(ctx, member, filed.id, { status: 1, resolution: 'no action' }, { text: 'v10 battery r2', reasonDocumentId: REASON_DOCUMENT_ID });
  check('r2c a resolution citing a listed reason lands', listed === null, (listed ?? '').slice(0, 200));
  // Field changes are no deletion: the owner's protection does not stop them.
  const ownerReport = await attemptCreate(sdk, ctx.moderator, { contractId, docType: 'report', data: reportData({ postId: bs58.decode(postId), targetOwnerId: bs58.decode(botB.ownerId), reason: 0 }) });
  if (ownerReport.ok) {
    const onOwner = await changeReport(ctx, member, ownerReport.id, { status: 1 }, { text: 'v10 battery r2', reasonDocumentId: REASON_DOCUMENT_ID });
    check('r2d the team resolves the protected owner\'s report too (a change, not a deletion)', onOwner === null, (onOwner ?? '').slice(0, 200));
    // …but a DELETION of it is refused: the ownerProtected owner's documents are out of the team's reach.
    const deleted = await errorOf(() => sdk.contracts.moderatorDeleteDocument({
      identity: member.identity, contractId, documentTypeName: 'report', documentId: ownerReport.id,
      reason: { text: 'v10 battery r2', reasonDocumentId: REASON_DOCUMENT_ID }, signer: member.signer,
    }));
    expectRejected('r2e the team cannot delete the protected owner\'s report (41102)', asOutcome(deleted), TARGET_NOT_ALLOWED);
    await deleteOwn(ctx, ctx.moderator, 'report', ownerReport.id);
  }
}

// ---- v10: trending without beat ------------------------------------------------------

/**
 * The DocumentsQuery `timeRange` option reading `docType`'s windowed index
 * `name` through its oldest open window, the grid off the committed JSON. The
 * grid is named because like and post bucket $createdAt on several grids.
 */
const gridOf = (docType, name) => {
  const { range, step } = V10.documentSchemas[docType].indices.find((index) => index.name === name).timeRange;
  return { timeRange: [{ field: '$createdAt', selector: 'oldest', grid: { range, step } }] };
};
const TRENDING_TAGS = gridOf('like', 'byTrendHashtagPost');
const TOP_POSTS = gridOf('like', 'byTrendPost');

const WINDOW_PAGE = 100;
const WINDOW_PAGES = 10;

/**
 * The notification windows of `docType`'s windowed index `name` as the client
 * reads them: the grid is non-overlapping (step == range) with ttl twice the
 * range, so the last week is the current window (`newest`) and the one before
 * it, named by its start (`byStart`): the node's `oldest` is the oldest window
 * still containing now, which on this grid is the current one again.
 */
const notificationWindowsOf = (docType, name) => {
  const { range, step } = V10.documentSchemas[docType].indices.find((index) => index.name === name).timeRange;
  const stepMs = step * 1000;
  const previousStart = (Math.floor(Date.now() / stepMs) - 1) * stepMs;
  return [{ selector: 'newest' }, { selector: 'byStart', startMs: previousStart }]
    .map((pick) => ({ timeRange: [{ field: '$createdAt', ...pick, grid: { range, step } }] }));
};

/**
 * Whether `docType`'s windowed notification index `indexName`, read through
 * both open windows with `where`, lists a document matching `predicate`. A
 * windowed read takes no `$createdAt` clause and no `$createdAt` orderBy (the
 * window is the time bound), so each window pages by id while pages come back
 * full. A document is counted once.
 */
async function windowLists(ctx, docType, indexName, where, predicate) {
  const seen = new Set();
  for (const window of notificationWindowsOf(docType, indexName)) {
    let startAfter;
    for (let page = 0; page < WINDOW_PAGES; page++) {
      const result = await readback(() => ctx.sdk.documents.query({
        dataContractId: ctx.contractId, documentTypeName: docType, where, ...window,
        limit: WINDOW_PAGE, ...(startAfter ? { startAfter } : {}),
      }));
      let last = null;
      for (const document of result.values()) {
        if (!document) continue;
        last = document;
        seen.add(idOf(document.id));
        if (predicate(document)) return { found: true, scanned: seen.size };
      }
      if (result.size < WINDOW_PAGE || !last) break;
      startAfter = idOf(last.id);
    }
  }
  return { found: false, scanned: seen.size };
}

async function rankedWindow(ctx, window, extra) {
  return readback(() => ctx.sdk.documents.ranked({ dataContractId: ctx.contractId, documentTypeName: 'like', aggregate: { type: 'count' }, direction: 'desc', limit: 100, ...window, ...extra }));
}

/** Per like type: the liked target's field and its author field, the lead of byAuthorPostTime / byAuthorReplyTime. */
const LIKE_FIELDS = { like: { target: 'postId', author: 'postAuthor' }, likeReply: { target: 'replyId', author: 'replyAuthor' } };
const LIKE_PAGE = 100;

/**
 * One page of the likes of `authorId`'s `targetId`, newest first, off the
 * author index that carries `$createdAt` after the pinned target
 * (`byAuthorPostTime [postAuthor, postId, $createdAt]`, `byAuthorReplyTime`
 * for reply likes). `timeClause` is the page's `$createdAt` bound, if any.
 */
function likesOfTarget(ctx, docType, authorId, targetId, timeClause) {
  const { target, author } = LIKE_FIELDS[docType];
  return readback(() => ctx.sdk.documents.query({
    dataContractId: ctx.contractId, documentTypeName: docType,
    where: [[author, '==', authorId], [target, '==', targetId], ...(timeClause ? [timeClause] : [])],
    orderBy: [[author, 'asc'], [target, 'asc'], ['$createdAt', 'desc']], limit: LIKE_PAGE,
  }));
}

/**
 * `{ id, createdAt }` of `likerId`'s like of `targetId` by `authorId`, or null:
 * the delete-by-values tuple. Pages the per-target likes newest first with a
 * `$createdAt <=` keyset and dedupes by liker (a page boundary can split one
 * millisecond); an id `startAfter` cursor is never used, the node refuses it
 * on an indexOnly type.
 */
async function likeTuple(ctx, docType, authorId, targetId, likerId) {
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const result = await likesOfTarget(ctx, docType, authorId, targetId, cursor === null ? null : ['$createdAt', '<=', cursor]);
    let fresh = 0;
    for (const document of result.values()) {
      if (!document || document.createdAt === undefined) continue;
      const liker = idOf(document.ownerId);
      const createdAt = Number(document.createdAt);
      cursor = cursor === null ? createdAt : Math.min(cursor, createdAt);
      if (seen.has(liker)) continue;
      seen.add(liker);
      fresh++;
      if (liker === likerId) return { id: document.id.toBytes?.() ?? bs58.decode(idOf(document.id)), createdAt };
    }
    if (result.size < LIKE_PAGE || fresh === 0) return null;
  }
  return null;
}

async function caseT2TrendingOnLike(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- t2. rolling trending on like (no beat): byTrendHashtagPost counts tagged likes only, byTrendPost every like ---');
  const tag = `${ctx.tag}t`;
  const tagged = await createFeed(ctx, botB, 'post', postData({ content: 't2 tagged', hashtag: tag }), 't2 tagged post');
  const untagged = await createFeed(ctx, botB, 'post', postData({ content: 't2 untagged' }), 't2 untagged post');
  if (!tagged || !untagged) { check('t2 fixture', false, 'no fixture posts'); return; }
  const owner = bs58.decode(botB.ownerId);
  const like = (postId, hashtag) => attemptCreateIndexOnly(sdk, botA, {
    contractId, docType: 'like', data: likeData({ postId: bs58.decode(postId), ...(hashtag ? { hashtag } : {}), postAuthor: owner }),
    accepted: () => entryExists(sdk, contractId, 'like', 'postId', postId, botA.ownerId),
  });
  expectAccepted('t2a A likes the tagged post (one transition, no beat companion)', await like(tagged, tag));
  expectAccepted('t2b A likes the untagged post', await like(untagged));
  await settle();

  const tags = await rankedWindow(ctx, TRENDING_TAGS, { groupBy: 'hashtag' });
  const entry = tags.entries.find((e) => e.groupValue === tag);
  check('t2c the 24h trending tags (groupBy hashtag) carry the run\'s tag at 1', Number(entry?.value ?? -1) === 1, `value=${entry?.value} groups=${tags.entries.length}`);
  check('t2d no untagged group appears (skipIfAbsent)', tags.entries.every((e) => typeof e.groupValue === 'string' && e.groupValue !== ''), describeValue(tags.entries.map((e) => e.groupValue)));
  const perTag = await rankedWindow(ctx, TRENDING_TAGS, { groupBy: 'postId', where: [['hashtag', '==', tag]] });
  check('t2e the tag\'s 24h top posts rank the tagged post at 1', Number(perTag.entries.find((e) => e.groupValue === tagged)?.value ?? -1) === 1, `groups=${perTag.entries.length}`);
  const perTagUntagged = perTag.entries.some((e) => e.groupValue === untagged);
  check('t2f the untagged post is not in the tag\'s window', !perTagUntagged);
  const allTime = await readback(() => sdk.documents.ranked({ dataContractId: contractId, documentTypeName: 'like', groupBy: 'postId', aggregate: { type: 'count' }, where: [['hashtag', '==', tag]], limit: 10 }));
  const topPosts = await rankedWindow(ctx, TOP_POSTS, { groupBy: 'postId' });
  check('t2j the 3-day top posts (byTrendPost) count both the tagged and the untagged like',
    [tagged, untagged].every((id) => Number(topPosts.entries.find((e) => e.groupValue === id)?.value ?? -1) === 1), `groups=${topPosts.entries.length}`);
  check('t2g the all-time per-tag ranking (byHashtagPost) agrees', Number(allTime.entries.find((e) => e.groupValue === tagged)?.value ?? -1) === 1);

  // A delete by values needs the like's $createdAt. An indexOnly document is
  // synthesized from the index it is read through, so read it back through
  // byAuthorPostTime [postAuthor, postId, $createdAt], the post pinned, newest first.
  const stored = await likeTuple(ctx, 'like', botB.ownerId, tagged, botA.ownerId);
  if (!stored) { check('t2 unlike fixture', false, 'A\'s like was not found on byAuthorPostTime with its $createdAt'); return; }
  const { document } = buildDocument({ contractId, docType: 'like', ownerId: botA.ownerId, id: stored.id,
    createdAt: stored.createdAt, data: likeData({ postId: bs58.decode(tagged), hashtag: tag, postAuthor: owner }) });
  expectAccepted('t2h A unlikes the tagged post (delete by values)', await attemptDeleteByValues(sdk, botA, { document, accepted: async () => !(await entryExists(sdk, contractId, 'like', 'postId', tagged, botA.ownerId)) }));
  await settle();
  try {
    const after = await rankedWindow(ctx, TRENDING_TAGS, { groupBy: 'postId', where: [['hashtag', '==', tag]] });
    check('t2i the tag\'s window no longer counts the post', Number(after.entries.find((e) => e.groupValue === tagged)?.value ?? 0) === 0, `groups=${after.entries.length}`);
    const afterTop = await rankedWindow(ctx, TOP_POSTS, { groupBy: 'postId' });
    check('t2k …nor does the 3-day window (byTrendPost), while the untagged like stays', Number(afterTop.entries.find((e) => e.groupValue === tagged)?.value ?? 0) === 0 && Number(afterTop.entries.find((e) => e.groupValue === untagged)?.value ?? -1) === 1, `groups=${afterTop.entries.length}`);
  } catch (e) {
    // A window bucket that drained to nothing can fail proof generation instead of proving empty (platform#4592).
    const cold = /single-path axis read must produce exactly one axis descent/i.test(describeErr(e));
    check('t2i the tag\'s window no longer counts the post', cold, cold ? 'cold bucket (the empty answer)' : describeErr(e).slice(0, 200));
  }
}

// ---- v10: one mention per post or reply, the notification windows ---------------------

/** The `docType` documents naming `mentionedUserId` since an hour ago, newest first, on the permanent mentionedUserAndTime. */
async function mentionsSinceAnHour(ctx, docType, mentionedUserId) {
  const mentions = await readback(() => ctx.sdk.documents.query({
    dataContractId: ctx.contractId, documentTypeName: docType,
    where: [['mentionedUserId', '==', mentionedUserId], ['$createdAt', '>', Date.now() - 3_600_000]],
    orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'desc']], limit: 100,
  }));
  return [...(mentions instanceof Map ? mentions.values() : Object.values(mentions ?? {}))].filter(Boolean).map((document) => idOf(document.id));
}

async function caseN1Mention(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- n1. one mention per post or reply: mentionedUserId (refersTo identity), listed by the permanent mentionedUserAndTime ---');
  const post = await createFeedOutcome(ctx, botA, 'post', postData({ content: `n1 hello B ${Date.now()}`, mentionedUserId: bs58.decode(botB.ownerId) }));
  expectAccepted('n1a A\'s post naming B in mentionedUserId lands', post);
  if (post.ok) {
    await settle();
    const stored = (await fetchDocument(sdk, contractId, 'post', post.id))?.toJSON?.() ?? {};
    check('n1b it reads back naming B', stored.mentionedUserId === botB.ownerId, describeValue({ mentionedUserId: stored.mentionedUserId }));
    const listedIds = await mentionsSinceAnHour(ctx, 'post', botB.ownerId);
    check('n1c the permanent mentionedUserAndTime lists it for B, newest first since an hour ago (the "mentioned you" source and the Mentions tab)', listedIds.includes(post.id), `${listedIds.length} post(s)`);
  }
  await expectFeedRefused(ctx, 'n1d a mention of an identity that does not exist is refused (40120)', botA, 'post', postData({ content: 'n1 ghost mention', mentionedUserId: randomIdBytes() }), REFERENCE_NOT_FOUND);

  // A reply mentions the same way, on its own reply.mentionedUserAndTime.
  const root = await createFeed(ctx, botA, 'post', postData({ content: `n1 reply root ${Date.now()}` }), 'n1 reply root');
  if (!root) { check('n1 reply fixture', false, 'no root post'); return; }
  const onRoot = { rootPostId: bs58.decode(root), parentOwnerId: bs58.decode(botA.ownerId) };
  const reply = await createFeedOutcome(ctx, botA, 'reply', replyData({ content: `n1 hi B ${Date.now()}`, ...onRoot, mentionedUserId: bs58.decode(botB.ownerId) }));
  expectAccepted('n1e A\'s reply naming B in mentionedUserId lands', reply);
  if (reply.ok) {
    await settle();
    const listedIds = await mentionsSinceAnHour(ctx, 'reply', botB.ownerId);
    check('n1f the permanent reply.mentionedUserAndTime lists it for B, newest first since an hour ago (the reply "mentioned you" source)', listedIds.includes(reply.id), `${listedIds.length} reply(ies)`);
  }
  await expectFeedRefused(ctx, 'n1g a reply mention of an identity that does not exist is refused (40120)', botA, 'reply', replyData({ content: 'n1 ghost reply mention', ...onRoot, mentionedUserId: randomIdBytes() }), REFERENCE_NOT_FOUND);
}

async function caseN2NotificationWindows(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- n2. the reply notification window; like notifications, the heart state and unlikes on the permanent like indexes ---');
  const target = await createFeed(ctx, botB, 'post', postData({ content: `n2 target ${Date.now()}` }), 'n2 target');
  if (!target) { check('n2 fixtures', false, 'no target post'); return; }
  const [targetBytes, owner] = [target, botB.ownerId].map((id) => bs58.decode(id));
  const onTarget = (who, content) => createFeed(ctx, who, 'reply', replyData({ content, rootPostId: targetBytes, parentOwnerId: owner }), content);
  const bReply = await onTarget(botB, 'n2 B reply');
  const aReply = await onTarget(botA, 'n2 A reply');
  if (!bReply || !aReply) { check('n2 fixtures', false, 'a reply did not land'); return; }
  // [docType, target id, like data, what is liked, the case ids of its notification / heart / unlike checks]
  const likes = [
    ['like', target, likeData({ postId: targetBytes, postAuthor: owner }), 'post', ['n2b', 'n2c', 'n2d']],
    ['likeReply', bReply, likeReplyData({ replyId: bs58.decode(bReply), replyAuthor: owner }), 'reply', ['n2e', 'n2f', 'n2g']],
  ];
  const liked = (docType, targetId) => entryExists(sdk, contractId, docType, LIKE_FIELDS[docType].target, targetId, botA.ownerId);
  for (const [docType, targetId, data, what] of likes) {
    expectAccepted(`n2 fixture: A likes B's ${what}`, await attemptCreateIndexOnly(sdk, botA, { contractId, docType, data, accepted: () => liked(docType, targetId) }));
  }
  await settle();

  const replies = await windowLists(ctx, 'reply', 'parentOwnerRecent', [['parentOwnerId', '==', botB.ownerId]], (document) => idOf(document.id) === aReply);
  check('n2a reply.parentOwnerRecent\'s two open windows list A\'s reply for B (the "replied to you" source)', replies.found, `${replies.scanned} reply(ies) scanned`);
  const since = Date.now() - 3_600_000;
  for (const [docType, targetId, data, what, [notifyCase, heartCase, unlikeCase]] of likes) {
    const { target: field, author } = LIKE_FIELDS[docType];
    const [authorIndex, targetIndex] = docType === 'like' ? ['byAuthorPostTime', 'byPost'] : ['byAuthorReplyTime', 'byReply'];
    // "Liked your post": the per-target read since a watermark, newest first.
    const notified = await likesOfTarget(ctx, docType, botB.ownerId, targetId, ['$createdAt', '>', since]);
    const mine = [...notified.values()].find((document) => document && idOf(document.ownerId) === botA.ownerId);
    check(`${notifyCase} ${authorIndex} lists A's like of B's ${what} since an hour ago (\`${author} ==\`, \`${field} ==\`, \`$createdAt >\`; the "liked your ${what}" source)`,
      mine !== undefined && Number(mine.createdAt) > since, describeValue(mine && { createdAt: mine.createdAt }));
    // The heart state: byPost / byReply [target] terminal $ownerId, the target `in` batch pinned to the viewer.
    const hearts = await readback(() => sdk.documents.query({ dataContractId: contractId, documentTypeName: docType,
      where: [[field, 'in', [targetId]], ['$ownerId', '==', botA.ownerId]], orderBy: [[field, 'asc'], ['$ownerId', 'asc']], limit: 1 }));
    check(`${heartCase} ${docType}.${targetIndex} answers "did A like it" (\`${field} in\`, \`$ownerId ==\`)`, [...hearts.values()].filter(Boolean).length === 1);
    const tuple = await likeTuple(ctx, docType, botB.ownerId, targetId, botA.ownerId);
    if (!tuple) { check(`${unlikeCase} unlike fixture`, false, `A's like was not found on ${authorIndex} with its $createdAt`); continue; }
    const { document } = buildDocument({ contractId, docType, ownerId: botA.ownerId, id: tuple.id, createdAt: tuple.createdAt, data });
    expectAccepted(`${unlikeCase} A unlikes B's ${what} by values, the tuple read off ${authorIndex} (\`$createdAt <=\` keyset)`,
      await attemptDeleteByValues(sdk, botA, { document, accepted: async () => !(await liked(docType, targetId)) }));
  }
}

// ---- v10: YAPP is locked -----------------------------------------------------------------

async function caseY1YappLocked(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- y1. YAPP: paused for good (no transfer), never priced (no purchase); costs and the grant still work ---');
  const tokenId = await readback(() => sdk.tokens.calculateId(contractId, YAPP_TOKEN_POSITION));
  const balance = (id) => tokenBalance(readback, sdk, tokenId, id);
  const before = { a: await balance(botA.ownerId), b: await balance(botB.ownerId) };
  const transfer = await errorOf(() => sdk.tokens.transfer({ dataContractId: contractId, tokenPosition: YAPP_TOKEN_POSITION, senderId: botA.ownerId, recipientId: botB.ownerId, amount: 1n, identityKey: botA.identityKey, signer: botA.signer }));
  await settle();
  const moved = (await balance(botB.ownerId)) !== before.b;
  expectRejected('y1a a YAPP transfer is refused (40711: the token is paused)', { ok: transfer === null || moved, error: transfer }, TOKEN_PAUSED);

  const prices = await readback(() => sdk.tokens.directPurchasePrices([tokenId]));
  const price = prices instanceof Map ? prices.get(tokenId) : prices?.[tokenId];
  check('y1b YAPP has no direct-purchase price', price === undefined || price === null, describeValue(price));
  const purchase = await errorOf(() => sdk.tokens.directPurchase({ dataContractId: contractId, tokenPosition: YAPP_TOKEN_POSITION, buyerId: botA.ownerId, amount: 100n, maxTotalCost: 10_000_000_000n, identityKey: botA.identityKey, signer: botA.signer }));
  expectRejected('y1c a direct purchase is refused (40721: not for sale)', asOutcome(purchase), NOT_FOR_SALE);

  // A token COST is not a transfer: posting still pays 10 YAPP from a paused token.
  const { agreement } = await feeAgreement(ctx, POST_ACTION_FEE);
  const payment = paymentInfo(tokenCostFor('post').amount, { gasFeesPaidBy: PREFER_CONTRACT_OWNER }).tokenPaymentInfo;
  const paid = await manualCreate(ctx, botA, { docType: 'post', data: postData({ content: 'y1 paid in YAPP' }), agreement, payment });
  expectAccepted('y1d a post paying 10 YAPP lands on the paused token', paid);
  await settle();
  const after = await balance(botA.ownerId);
  check('y1e …and A\'s balance fell by exactly the post\'s token cost', after === before.a - BigInt(tokenCostFor('post').amount), `before=${before.a} after=${after}`);

  const fresh = await freshActor(ctx);
  if (!fresh) { console.log('SKIP  y1f–y1g: needs --fresh-bot <n>, an identity that has not claimed its starter grant'); return; }
  const claim = () => errorOf(() => sdk.tokens.claim({ dataContractId: contractId, tokenPosition: YAPP_TOKEN_POSITION, identityId: fresh.ownerId, distributionType: 'oncePerIdentity', identityKey: fresh.identityKey, signer: fresh.signer }));
  const start = await balance(fresh.ownerId);
  const first = await claim();
  if (first !== null && ALREADY_CLAIMED.test(first)) {
    console.log(`SKIP  y1f–y1g: ${fresh.label} already claimed its grant on an earlier run; pass a --fresh-bot that has not`);
    return;
  }
  await settle();
  check(`y1f a fresh identity claims its ${STARTER_GRANT} starter YAPP (a claim is not a transfer)`, (await balance(fresh.ownerId)) === start + STARTER_GRANT, (first ?? '').slice(0, 160));
  const second = await claim();
  expectRejected('y1g a second claim is refused (40722)', asOutcome(second), ALREADY_CLAIMED);
}

// ---- Carried from verify-v8: fees, suspension, token costs (v8 needs a v9 chain) ----

const creditsOf = async (ctx, ownerId) => (await readback(() => ctx.sdk.identities.balance(ownerId))) ?? 0n;
const moderatorsPot = async (ctx) => (await readback(() => ctx.sdk.contracts.feePots(ctx.contractId))).moderators;
const yappPayment = (amount) => paymentInfo(amount, { gasFeesPaidBy: PREFER_CONTRACT_OWNER }).tokenPaymentInfo;
async function tokenIdOf(ctx) {
  ctx.tokenId ??= await readback(() => ctx.sdk.tokens.calculateId(ctx.contractId, YAPP_TOKEN_POSITION));
  return ctx.tokenId;
}
const yappOf = async (ctx, ownerId) => tokenBalance(readback, ctx.sdk, await tokenIdOf(ctx), ownerId);

async function caseA1NoAgreement(ctx) {
  console.log('\n--- a1. post create without an action fee agreement → 40132 ---');
  // sdk.documents.create has no agreement option: exactly what an un-upgraded client sends.
  const outcome = await attemptCreate(ctx.sdk, ctx.botA, { contractId: ctx.contractId, docType: 'post', data: postData({ content: 'no agreement' }) });
  expectRejected('a1a post without $actionFeeAgreement is refused (40132)', outcome, AGREEMENT_NOT_SET);
}

/** A 40134 (a stale multiplier across an epoch turn) is not the agreement refusal a2 means to prove. */
function expectMismatch(label, outcome, pattern = AGREEMENT_MISMATCH) {
  if (!outcome.ok && FEE_MULTIPLIER_NOT_TOLERATED.test(outcome.error ?? '')) {
    check(label, false, `refused for the stale fee multiplier (40134), not the agreement: ${(outcome.error ?? '').slice(0, 160)}`);
    return outcome;
  }
  return expectRejected(label, outcome, pattern);
}

async function caseA2MismatchedAgreement(ctx) {
  console.log('\n--- a2. post create with a mismatched agreement → 40139 (a discount) / 40133 ---');
  const { knownPermille } = await feeAgreement(ctx, POST_ACTION_FEE);
  ctx.seated ??= (await readback(() => ctx.sdk.moderationCharters.seatedCharter(ctx.contractId))) != null;
  // drive's batch validation (v4.2.0-beta.7, rs-drive state_transition_action/batch/v0):
  // same pricing and owner part with a SMALLER moderators part on an elected
  // contract's moderated type is a discount claim, judged only against the
  // seated charter's share; everything else is the 40133 exact match.
  const discounted = new DocumentActionFeeAgreement(actionFeeAgreementOptions({ ...POST_ACTION_FEE, moderators: 1n }, knownPermille));
  const underpaid = expectMismatch(
    `a2a an under-declared moderators part is a refused discount (40139, ${ctx.seated ? 'not the seated charter\'s share' : 'no charter seated'})`,
    await manualCreate(ctx, ctx.botA, { docType: 'post', data: postData({ content: 'discounted fee' }), agreement: discounted }),
    MODERATORS_SHARE_MISMATCH
  );
  if (!ctx.seated && !underpaid.ok && MODERATORS_SHARE_MISMATCH.test(underpaid.error ?? '')) {
    check('a2a\' unseated, the refusal says nothing may be discounted', NO_SEATED_CHARTER.test(underpaid.error ?? ''), (underpaid.error ?? '').slice(0, 200));
  }
  const fixed = new DocumentActionFeeAgreement(actionFeeAgreementOptions({ ...POST_ACTION_FEE, pricing: 'fixed' }, knownPermille));
  expectMismatch('a2b agreement to FIXED pricing on a feeMultiplier fee is a mismatch (40133)', await manualCreate(ctx, ctx.botA, { docType: 'post', data: postData({ content: 'fixed pricing' }), agreement: fixed }));
  const overpaid = new DocumentActionFeeAgreement(actionFeeAgreementOptions({ ...POST_ACTION_FEE, moderators: POST_ACTION_FEE.moderators + 1n }, knownPermille));
  expectMismatch('a2c agreement naming a LARGER moderators part is a mismatch, not a discount (40133)', await manualCreate(ctx, ctx.botA, { docType: 'post', data: postData({ content: 'overpaid fee' }), agreement: overpaid }));
}

async function caseA3AgreedFee(ctx) {
  const { botA } = ctx;
  console.log('\n--- a3. the agreed fee lands, the derived id matches, the moderators pot grows ---');
  const potBefore = (await moderatorsPot(ctx)).credits;
  const { agreement, knownPermille } = await feeAgreement(ctx, POST_ACTION_FEE);
  const post = await manualCreate(ctx, botA, { docType: 'post', data: postData({ content: 'agreed fee', hashtag: ctx.tag }), agreement });
  expectAccepted('a3a post with the declared agreement lands', post);
  if (!post.ok) return;
  check('a3b the nonce-committed v1 id derived locally is the id Platform stored', post.fromResult && post.resultId === post.derivedId, `derived=${post.derivedId} result=${post.resultId ?? '(no result: broadcast wait threw)'}`);
  await settle();
  const potAfterPost = (await moderatorsPot(ctx)).credits;
  const expectedPostFee = (POST_ACTION_FEE.moderators * knownPermille) / 1000n;
  check('a3c the moderators pot grew by the post fee × the epoch multiplier', potAfterPost - potBefore === expectedPostFee, `pot ${potBefore}→${potAfterPost} (Δ${potAfterPost - potBefore}, expected ${expectedPostFee} at ${knownPermille}‰)`);
  const { agreement: replyAgreement } = await feeAgreement(ctx, REPLY_ACTION_FEE);
  const reply = await manualCreate(ctx, botA, { docType: 'reply', data: replyData({ rootPostId: bs58.decode(post.id), parentOwnerId: bs58.decode(botA.ownerId) }), agreement: replyAgreement });
  expectAccepted('a3d reply with its own declared agreement lands', reply);
  await settle();
  const potAfterReply = (await moderatorsPot(ctx)).credits;
  check('a3e …growing the pot by the reply fee × multiplier', reply.ok && potAfterReply - potAfterPost === (REPLY_ACTION_FEE.moderators * knownPermille) / 1000n, `Δ${potAfterReply - potAfterPost}`);
}

async function caseA4Claim(ctx) {
  const { sdk, contractId, moderator } = ctx;
  console.log('\n--- a4. claimFees pays the moderators pot; once per epoch (41111) ---');
  if (interimOnly(ctx, 'a4')) return;
  const pot = await moderatorsPot(ctx);
  if (pot.credits === 0n) { check('a4 pot is funded (run a3 first)', false, 'the moderators pot is empty'); return; }
  const before = await creditsOf(ctx, moderator.ownerId);
  const first = await errorOf(() => sdk.contracts.claimFees({ identity: moderator.identity, contractId, pot: 'moderators', signer: moderator.signer }));
  if (first !== null && ALREADY_CLAIMED_EPOCH.test(first)) { check('a4a the pot was already claimed this epoch (an earlier run); the refusal is 41111', true, first.slice(0, 160)); return; }
  check('a4a the interim owner claims the moderators pot', first === null, (first ?? '').slice(0, 220));
  if (first !== null) return;
  await settle();
  check('a4b the claimant\'s credits rose (net of the claim\'s own fee)', (await creditsOf(ctx, moderator.ownerId)) > before);
  const second = await errorOf(() => sdk.contracts.claimFees({ identity: moderator.identity, contractId, pot: 'moderators', signer: moderator.signer }));
  expectRejected('a4c a second claim in the same epoch is refused (41111)', asOutcome(second), ALREADY_CLAIMED_EPOCH);
}

async function caseS1Suspend(ctx) {
  const { sdk, contractId, botB, moderator } = ctx;
  console.log('\n--- s1. suspend: refused (41108) until the block time lapses ---');
  if (interimOnly(ctx, 's1')) return;
  const until = Date.now() + SUSPENSION_MS;
  const suspended = await errorOf(() => sdk.contracts.suspendUser({ identity: moderator.identity, contractId, identityId: botB.ownerId, until: BigInt(until), reason: { text: 'v10 battery suspension' }, signer: moderator.signer }));
  check('s1a the interim owner suspends B for ~25 s', suspended === null, (suspended ?? '').slice(0, 220));
  if (suspended !== null) return;
  const status = await standingOf(ctx, botB.ownerId, ['suspensions']);
  check('s1b moderationStatus proves the suspension and its end', status.suspendedUntil !== undefined && Number(status.suspendedUntil) === until, describeValue(status));
  const { agreement } = await feeAgreement(ctx, POST_ACTION_FEE);
  expectRejected('s1c B\'s post while suspended is refused (41108)', await manualCreate(ctx, botB, { docType: 'post', data: postData({ content: 'suspended post' }), agreement }), SUSPENDED);
  const probe = () => attemptCreate(sdk, botB, { contractId, docType: 'block', data: blockData({ blockedId: randomIdBytes() }) });
  expectRejected('s1d …and so is an unpriced create', await probe(), SUSPENDED);
  await settle(Math.max(until - Date.now() + 8000, 0));
  // `until` is judged against BLOCK time, which trails the wall clock on a quiet devnet.
  let lapsed = await probe();
  let retries = 0;
  for (; retries < 12 && !lapsed.ok && SUSPENDED.test(lapsed.error ?? ''); retries++) {
    await settle(10_000);
    lapsed = await probe();
  }
  expectAccepted(`s1e B's create lands once the suspension lapsed (after ${retries} block-time retr${retries === 1 ? 'y' : 'ies'})`, lapsed);
  check('s1f the lapsed suspension was swept by that write', (await standingOf(ctx, botB.ownerId, ['suspensions'])).suspendedUntil === undefined);
}

async function caseK1OptionalTokenCost(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- k1. optional token cost: credits without payment info, YAPP + sponsored gas with it ---');
  const targets = [await createPost(ctx, botB, 'k1 credits-paid like target'), await createPost(ctx, botB, 'k1 yapp-paid like target')];
  if (targets.some((id) => !id)) { check('k1 fixtures', false, 'could not create the target posts'); return; }
  const likeOn = (postId) => attemptCreateIndexOnly(sdk, botA, {
    contractId, docType: 'like', data: likeData({ postId: bs58.decode(postId), postAuthor: bs58.decode(botB.ownerId) }),
    accepted: () => entryExists(sdk, contractId, 'like', 'postId', postId, botA.ownerId),
  });
  const [creditsBefore, yappBefore] = await Promise.all([creditsOf(ctx, botA.ownerId), yappOf(ctx, botA.ownerId)]);
  expectAccepted('k1a a like WITHOUT payment info lands', await likeOn(targets[0]));
  await settle();
  const [creditsAfter, yappAfter] = await Promise.all([creditsOf(ctx, botA.ownerId), yappOf(ctx, botA.ownerId)]);
  check('k1b …charging credits and no YAPP', creditsAfter < creditsBefore && yappAfter === yappBefore, `credits ${creditsBefore}→${creditsAfter} yapp ${yappBefore}→${yappAfter}`);
  const [ownerBefore, aCreditsBefore, aYappBefore] = await Promise.all([creditsOf(ctx, ctx.ownerId), creditsOf(ctx, botA.ownerId), yappOf(ctx, botA.ownerId)]);
  const paidError = await errorOf(async () => {
    const { document } = buildDocument({ contractId, docType: 'like', ownerId: botA.ownerId, data: likeData({ postId: bs58.decode(targets[1]), postAuthor: bs58.decode(botB.ownerId) }), entropy: randomIdBytes() });
    await sdk.documents.create({ document, identityKey: botA.identityKey, signer: botA.signer, tokenPaymentInfo: yappPayment(TOKEN_COST.like), settings: { identityNonceStaleTimeS: 0 } });
  });
  await settle();
  const landed = await entryExists(sdk, contractId, 'like', 'postId', targets[1], botA.ownerId);
  check('k1c a like WITH payment info (PreferContractOwner gas) lands on the paused token', landed, landed ? '' : (paidError ?? '').slice(0, 220));
  const [ownerAfter, aCreditsAfter, aYappAfter] = await Promise.all([creditsOf(ctx, ctx.ownerId), creditsOf(ctx, botA.ownerId), yappOf(ctx, botA.ownerId)]);
  check(`k1d …charging exactly ${TOKEN_COST.like} YAPP`, aYappBefore - aYappAfter === BigInt(TOKEN_COST.like), `yapp ${aYappBefore}→${aYappAfter}`);
  check('k1e …and the contract OWNER paid the gas (its credits moved, A\'s did not)', ownerAfter < ownerBefore && aCreditsAfter === aCreditsBefore, `owner ${ownerBefore}→${ownerAfter} A ${aCreditsBefore}→${aCreditsAfter}`);
}

async function resolvePoorBot(sdk) {
  const ownerId = loadIdentityIds()[POOR_BOT_INDEX];
  if (!ownerId) return null;
  try {
    const owner = resolveOwner({ botIndex: POOR_BOT_INDEX, ownerId });
    const { identityKey, signer } = await signerFor(sdk, owner);
    return { ownerId, identityKey, signer, label: owner.label };
  } catch (e) {
    console.log(`     (no poor bot: ${describeErr(e).slice(0, 120)})`);
    return null;
  }
}

async function caseK2InsufficientYapp(ctx) {
  const { sdk, contractId, botB } = ctx;
  console.log('\n--- k2. payment info with insufficient YAPP is a refusal (40700), never a credits fallback ---');
  const poor = await resolvePoorBot(sdk);
  if (!poor) { console.log('SKIP  k2 needs a bot with no YAPP (--poor <index>); none resolved'); return; }
  const balance = await yappOf(ctx, poor.ownerId);
  if (balance > 0n) { console.log(`SKIP  k2: ${poor.label} holds ${balance} YAPP; pick a --poor bot with none`); return; }
  const target = await createPost(ctx, botB, 'k2 poor bot target');
  if (!target) { check('k2 fixture', false, 'no target post'); return; }
  const error = await errorOf(async () => {
    const { document } = buildDocument({ contractId, docType: 'like', ownerId: poor.ownerId, data: likeData({ postId: bs58.decode(target), postAuthor: bs58.decode(botB.ownerId) }), entropy: randomIdBytes() });
    await sdk.documents.create({ document, identityKey: poor.identityKey, signer: poor.signer, tokenPaymentInfo: yappPayment(TOKEN_COST.like) });
  });
  await settle();
  const landed = await entryExists(sdk, contractId, 'like', 'postId', target, poor.ownerId);
  expectRejected('k2a a like with payment info and 0 YAPP is refused (40700)', { ok: landed, error }, INSUFFICIENT_TOKENS);
}

// ---- v10: a repost is a quote ------------------------------------------------------

async function caseQ1RepostIsAQuote(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- q1. a repost is a post quoting its target with no content: the post price, one quote or repost per author and target (40105), notEmpty (10422) ---');
  const target = await createFeed(ctx, botB, 'post', postData({ content: `q1 target ${Date.now()}` }), 'q1 target');
  const reply = target
    ? await createFeed(ctx, botB, 'reply', replyData({ content: 'q1 reply target', rootPostId: bs58.decode(target), parentOwnerId: bs58.decode(botB.ownerId) }), 'q1 reply target')
    : null;
  if (!target || !reply) { check('q1 fixtures', false, 'no target post or reply'); return; }
  const [post, replyBytes, owner] = [target, reply, botB.ownerId].map((id) => bs58.decode(id));
  const bare = repostOf({ postId: post, ownerId: owner });

  // The refusal first: once A's repost lands, any other is the 40105.
  await expectCreateRefused(ctx, 'q1a a bare repost without the post action fee agreement is refused (40132: it is a post)', botA, 'post', bare, AGREEMENT_NOT_SET);

  const [yappBefore, potBefore] = [await yappOf(ctx, botA.ownerId), (await moderatorsPot(ctx)).credits];
  const { agreement, knownPermille } = await feeAgreement(ctx, POST_ACTION_FEE);
  const repost = await manualCreate(ctx, botA, { docType: 'post', data: bare, agreement, payment: yappPayment(TOKEN_COST.post) });
  expectAccepted('q1b A\'s bare repost of B\'s post (quotedPostId + quotedPostOwnerId, no content) lands with the post agreement, paying YAPP', repost);
  if (!repost.ok) return;
  await settle();
  const [yappAfter, potAfter] = [await yappOf(ctx, botA.ownerId), (await moderatorsPot(ctx)).credits];
  check(`q1c it cost the post price: exactly ${TOKEN_COST.post} YAPP`, yappBefore - yappAfter === BigInt(TOKEN_COST.post), `yapp ${yappBefore}→${yappAfter}`);
  const postFee = (POST_ACTION_FEE.moderators * knownPermille) / 1000n;
  check('q1d …and the post\'s action fee: the moderators pot grew by it', potAfter - potBefore === postFee, `pot ${potBefore}→${potAfter} (Δ${potAfter - potBefore}, expected ${postFee})`);
  const stored = (await fetchDocument(sdk, contractId, 'post', repost.id))?.toJSON?.() ?? {};
  check('q1e it reads back as a post with no content, quoting the target and naming its owner',
    stored.content === undefined && stored.quotedPostId === target && stored.quotedPostOwnerId === botB.ownerId,
    describeValue({ content: stored.content, quotedPostId: stored.quotedPostId, quotedPostOwnerId: stored.quotedPostOwnerId }));

  await expectFeedRefused(ctx, 'q1f a second bare repost of the same post by A is refused (40105 ownerAndQuotedPost)', botA, 'post', bare, DUPLICATE_UNIQUE);
  await expectFeedRefused(ctx, 'q1g a quote of the same post by A is refused too (40105: one quote or repost per author and target)', botA, 'post', postData({ content: 'q1 quote after repost', quotedPostId: post, quotedPostOwnerId: owner }), DUPLICATE_UNIQUE);
  expectAccepted('q1h another author\'s bare repost of the same post lands (B reposts its own post)', await createFeedOutcome(ctx, botB, 'post', bare));
  await settle();
  const quotes = await countBy(sdk, contractId, 'post', 'quotedPostId', target);
  check('q1i the quote count is the repost count: exactly 2', quotes === 2, `quotes=${quotes}`);
  const notified = await windowLists(ctx, 'post', 'quotedPostOwnerRecent', [['quotedPostOwnerId', '==', botB.ownerId]], (document) => idOf(document.id) === repost.id);
  check('q1j quotedPostOwnerRecent\'s two open windows list A\'s repost for B (the "reposted your post" source)', notified.found, `${notified.scanned} post(s) scanned`);

  const replyRepost = repostOf({ replyId: replyBytes, ownerId: owner });
  expectAccepted('q1k A\'s bare repost of B\'s reply (quotedReplyId) lands', await createFeedOutcome(ctx, botA, 'post', replyRepost));
  await expectFeedRefused(ctx, 'q1l a quote of the same reply by A is refused (40105 ownerAndQuotedReply)', botA, 'post', { ...postData({ content: 'q1 reply quote after repost', quotedPostOwnerId: owner }), quotedReplyId: replyBytes }, DUPLICATE_UNIQUE);
  await settle();
  const replyQuotes = await countBy(sdk, contractId, 'post', 'quotedReplyId', reply);
  check('q1m the reply\'s quote count is exactly 1', replyQuotes === 1, `quotes=${replyQuotes}`);

  await expectFeedRefused(ctx, 'q1n a post with only a hashtag and `sensitive` is refused (10422 notEmpty)', botA, 'post', { hashtag: ctx.tag, sensitive: true }, constraintViolation('notEmpty'));
  expectAccepted('q1o a media-only post (no content) lands: media satisfies notEmpty', await createFeedOutcome(ctx, botA, 'post', await mediaFields('ipfs://bafyv10batterymediaonly')));
}

// ---- v10: counts through the merged list indexes ------------------------------------

/** A grouped count with its zero groups dropped (a group may come back as 0 or not at all). */
const nonZero = (grouped) => JSON.stringify([...grouped].filter(([, n]) => n !== 0).sort(([x], [y]) => x.localeCompare(y)));
const expectedGroups = (entries) => JSON.stringify(Object.entries(entries).filter(([, n]) => n !== 0).sort(([x], [y]) => x.localeCompare(y)));

/**
 * A ranked page agrees with a count: the key's entry carries `count`, or a full
 * page ends at or above it (the key ranks below the page). Either way the page
 * is ordered.
 */
async function checkRankedAgrees(ctx, label, docType, groupBy, key, count) {
  const page = await readback(() => ctx.sdk.documents.ranked({ dataContractId: ctx.contractId, documentTypeName: docType, groupBy, aggregate: { type: 'count' }, direction: 'desc', limit: 100 }));
  const values = page.entries.map((entry) => Number(entry.value));
  const ordered = values.every((value, i) => i === 0 || values[i - 1] >= value);
  const entry = page.entries.find((e) => groupKeyOf(e.groupValue) === key);
  const agrees = entry ? Number(entry.value) === count : values.length === 100 && values[values.length - 1] >= count;
  check(label, ordered && agrees, `${entry ? `value=${entry.value}` : 'below the page'} expected=${count} groups=${values.length} ordered=${ordered}`);
}

async function caseQ2MergedCounts(ctx) {
  const { sdk, contractId, botA, botB } = ctx;
  console.log('\n--- q2. counts through the merged list indexes: quotes, replies, posts per author, follows, ranked ---');
  const [a, b] = [botA.ownerId, botB.ownerId];
  const count = (docType, where) => countWhere(sdk, contractId, docType, where);
  const grouped = (docType, where, field) => groupedCountBy(sdk, contractId, docType, where, [field]);
  const postsBefore = await grouped('post', [['$ownerId', 'in', [a, b]]], '$ownerId');
  const aPostsBefore = await count('post', [['$ownerId', '==', a]]);

  // Fresh targets by B, so every per-target count is exact.
  const targets = [];
  for (const n of [1, 2, 3]) targets.push(await createFeed(ctx, botB, 'post', postData({ content: `q2 target ${n} ${Date.now()}` }), `q2 target ${n}`));
  if (targets.some((id) => !id)) { check('q2 fixtures', false, 'a target post did not land'); return; }
  const [p1, p2, p3] = targets;
  const [p1Bytes, p2Bytes, aBytes, bBytes] = [p1, p2, a, b].map((id) => bs58.decode(id));
  // Quotes: A and B repost P1, A quotes P2 → P1 2, P2 1, P3 none. A +2 posts, B +4.
  const quotes = [
    await createFeed(ctx, botA, 'post', repostOf({ postId: p1Bytes, ownerId: bBytes }), 'q2 A reposts P1'),
    await createFeed(ctx, botB, 'post', repostOf({ postId: p1Bytes, ownerId: bBytes }), 'q2 B reposts P1'),
    await createFeed(ctx, botA, 'post', postData({ content: 'q2 quote of P2', quotedPostId: p2Bytes, quotedPostOwnerId: bBytes }), 'q2 A quotes P2'),
  ];
  // Replies: r1 (A) and r2 (B) directly under P1, r3 (A) under r1, r4 (B) under P2.
  const r1 = await createFeed(ctx, botA, 'reply', replyData({ content: 'q2 r1', rootPostId: p1Bytes, parentOwnerId: bBytes }), 'q2 r1');
  const r2 = await createFeed(ctx, botB, 'reply', replyData({ content: 'q2 r2', rootPostId: p1Bytes, parentOwnerId: bBytes }), 'q2 r2');
  const r3 = r1 ? await createFeed(ctx, botA, 'reply', { ...replyData({ content: 'q2 r3', rootPostId: p1Bytes, parentOwnerId: aBytes }), replyToReplyId: bs58.decode(r1) }, 'q2 r3') : null;
  const r4 = await createFeed(ctx, botB, 'reply', replyData({ content: 'q2 r4', rootPostId: p2Bytes, parentOwnerId: bBytes }), 'q2 r4');
  if (quotes.some((id) => !id) || ![r1, r2, r3, r4].every(Boolean)) { check('q2 fixtures', false, 'a quote or reply did not land'); return; }
  await settle();

  const p1Quotes = await count('post', [['quotedPostId', '==', p1]]);
  check('q2a quotes of P1 (`quotedPostId ==` on quotesOfPost) = 2', p1Quotes === 2, `quotes=${p1Quotes}`);
  const quoteGroups = await grouped('post', [['quotedPostId', 'in', targets]], 'quotedPostId');
  check('q2b batched `quotedPostId in` + groupBy: P1 2, P2 1, P3 0', nonZero(quoteGroups) === expectedGroups({ [p1]: 2, [p2]: 1 }), nonZero(quoteGroups));
  const thread = await count('reply', [['rootPostId', '==', p1]]);
  check('q2c the whole thread under P1 (`rootPostId ==` on repliesOf) = 3', thread === 3, `replies=${thread}`);
  const threadGroups = await grouped('reply', [['rootPostId', 'in', targets]], 'rootPostId');
  check('q2d batched `rootPostId in` + groupBy: P1 3, P2 1, P3 0', nonZero(threadGroups) === expectedGroups({ [p1]: 3, [p2]: 1 }), nonZero(threadGroups));
  const underR1 = await count('reply', [['rootPostId', '==', p1], ['replyToReplyId', '==', r1]]);
  check('q2e replies to r1 (root pinned, `replyToReplyId ==`) = 1', underR1 === 1, `replies=${underR1}`);
  const perReply = await grouped('reply', [['rootPostId', '==', p1], ['replyToReplyId', 'in', [r1, r2]]], 'replyToReplyId');
  check('q2f batched per reply under P1 (`replyToReplyId in` + groupBy): r1 1, r2 0', nonZero(perReply) === expectedGroups({ [r1]: 1 }), nonZero(perReply));
  const direct = await count('reply', [['rootPostId', '==', p1], ['replyToReplyId', '==', null]]);
  check('q2g direct replies to P1 (the null pin) = 2', direct === 2, `replies=${direct}`);

  const aPostsAfter = await count('post', [['$ownerId', '==', a]]);
  check('q2h A\'s post count (`$ownerId ==` on ownerAndTime) rose by exactly its 2 posts', aPostsAfter - aPostsBefore === 2, `${aPostsBefore}→${aPostsAfter}`);
  const postsAfter = await grouped('post', [['$ownerId', 'in', [a, b]]], '$ownerId');
  const delta = (after, before, key) => (after.get(key) ?? 0) - (before.get(key) ?? 0);
  check('q2i batched `$ownerId in` + groupBy: A +2, B +4 (3 targets and a repost)', delta(postsAfter, postsBefore, a) === 2 && delta(postsAfter, postsBefore, b) === 4, `A ${postsBefore.get(a)}→${postsAfter.get(a)} B ${postsBefore.get(b)}→${postsAfter.get(b)}`);

  // Follows: start from no A→B follow, so its create moves each count by exactly one.
  const stale = await queryOne(ctx, 'follow', [['$ownerId', '==', a], ['followingId', '==', b]]);
  if (stale) { await deleteOwn(ctx, botA, 'follow', idOf(stale.id)); await settle(); }
  const followers = () => count('follow', [['followingId', '==', b]]);
  const following = () => count('follow', [['$ownerId', '==', a]]);
  const followerGroups = () => grouped('follow', [['followingId', 'in', [a, b]]], 'followingId');
  const followingGroups = () => grouped('follow', [['$ownerId', 'in', [a, b]]], '$ownerId');
  const before = { followers: await followers(), following: await following(), followerGroups: await followerGroups(), followingGroups: await followingGroups() };
  const follow = await attemptCreate(sdk, botA, { contractId, docType: 'follow', data: followData({ followingId: bBytes }) });
  expectAccepted('q2 fixture: A follows B', follow);
  if (!follow.ok) return;
  await settle();
  const after = { followers: await followers(), following: await following(), followerGroups: await followerGroups(), followingGroups: await followingGroups() };
  check('q2j B\'s followers (`followingId ==` on followers) rose by 1', after.followers - before.followers === 1, `${before.followers}→${after.followers}`);
  check('q2k A\'s following (`$ownerId ==` on following) rose by 1', after.following - before.following === 1, `${before.following}→${after.following}`);
  check('q2l batched followers (`followingId in` + groupBy): B +1, A +0',
    delta(after.followerGroups, before.followerGroups, b) === 1 && delta(after.followerGroups, before.followerGroups, a) === 0, `${nonZero(before.followerGroups)} → ${nonZero(after.followerGroups)}`);
  check('q2m batched following (`$ownerId in` + groupBy): A +1, B +0',
    delta(after.followingGroups, before.followingGroups, a) === 1 && delta(after.followingGroups, before.followingGroups, b) === 0, `${nonZero(before.followingGroups)} → ${nonZero(after.followingGroups)}`);

  await checkRankedAgrees(ctx, 'q2n ranked top authors (post groupBy $ownerId) agree with A\'s post count', 'post', '$ownerId', a, aPostsAfter);
  await checkRankedAgrees(ctx, 'q2o ranked most followed (follow groupBy followingId) agree with B\'s follower count', 'follow', 'followingId', b, after.followers);
  await checkRankedAgrees(ctx, 'q2p ranked most replied roots (reply groupBy rootPostId) agree with P1\'s 3', 'reply', 'rootPostId', p1, 3);
  check('q2 P3 stayed untouched (no quotes, no replies)', (await count('post', [['quotedPostId', '==', p3]])) === 0 && (await count('reply', [['rootPostId', '==', p3]])) === 0);
}

// ---- Registry ------------------------------------------------------------------

async function ensurePrepared(ctx) {
  if (ctx.prepared === true) return;
  if (ctx.prepared instanceof Error) throw ctx.prepared;
  try {
    ctx.contract = await readback(() => ctx.sdk.contracts.fetch(ctx.contractId));
    ctx.ownerId = ctx.contract.ownerId.toBase58();
    ctx.moderator = await resolveModerator(ctx.sdk, MODERATOR_SPEC);
    console.log(`contract owner: ${ctx.ownerId}; moderator: ${ctx.moderator.label}`);
    if (ctx.seated === null) ctx.seated = (await readback(() => ctx.sdk.moderationCharters.seatedCharter(ctx.contractId))) != null;
    ctx.prepared = true;
  } catch (e) {
    ctx.prepared = e instanceof Error ? e : new Error(String(e));
    throw ctx.prepared;
  }
}

const prepared = (run) => async (ctx) => { await ensurePrepared(ctx); return run(ctx); };

const CASES = new Map([
  ['e0', prepared(caseE0Declaration)],
  ['d1', prepared(caseD1DistinctFrom)],
  ['p1', prepared(caseP1PrivateFeedGates)],
  ['b1', prepared(caseB1TypedBlockFollows)],
  ['w1', prepared(caseW1Warnings)],
  ['m1', prepared(caseM1DeleteRestore)],
  ['m2', prepared(caseM2InterimBan)],
  ['o1', caseO1LikeOwnerAgreement],
  ['o2', caseO2LikeReplyOwnerAgreement],
  ['o3', caseO3RepostOwnerAgreement],
  ['o4', caseO4QuoteAndParentOwner],
  ['q1', caseQ1RepostIsAQuote],
  ['q2', caseQ2MergedCounts],
  ['x1', prepared(caseX1RealDeletes)],
  ['x2', caseX2MediaAndLimits],
  ['x3', prepared(caseX3ProfileExtension)],
  ['c1', caseC1PropertyConstraints],
  ['r1', prepared(caseR1Reports)],
  ['r2', prepared(caseR2SeatedResolution)],
  ['t2', caseT2TrendingOnLike],
  ['n1', caseN1Mention],
  ['n2', caseN2NotificationWindows],
  ['y1', caseY1YappLocked],
  ['a1', prepared(caseA1NoAgreement)],
  ['a2', prepared(caseA2MismatchedAgreement)],
  ['a3', prepared(caseA3AgreedFee)],
  ['a4', prepared(caseA4Claim)],
  ['s1', prepared(caseS1Suspend)],
  ['k1', prepared(caseK1OptionalTokenCost)],
  ['k2', prepared(caseK2InsufficientYapp)],
]);

// ---- Self-test ------------------------------------------------------------------

/** Offline: the committed JSON declares every rule a case asserts. */
function selfTest() {
  const schemas = V10.documentSchemas;
  const problems = [];
  const expect = (what, ok) => { if (!ok) problems.push(what); };
  const moderators = V10.config.moderation.moderators;
  const where = (type, prop) => schemas[type].properties[prop].refersTo?.where ?? {};
  expect('config $formatVersion is "2"', V10.config.$formatVersion === '2');
  expect('all three moderation lists are kept (e0, w1)', V10.config.moderation.banlist && V10.config.moderation.suspensions && V10.config.moderation.warnings);
  expect('moderators are elected with the owner as interim (e0, m1, m2, w1)', moderators.$type === 'elected' && moderators.interim?.$type === 'contractOwner');
  expect('post and reply are moderator-deletable with a record (m1)', ['post', 'reply'].every((t) => schemas[t].moderatorAbilities?.delete === true && schemas[t].moderatorAbilities.deleteKeepsRecord !== false));
  for (const [type, prop] of [['follow', 'followingId'], ['block', 'blockedId'], ['followRequest', 'targetId'], ['privateFeedGrant', 'recipientId']]) {
    expect(`${type}.${prop} is distinctFrom $ownerId (d1, p1i)`, schemas[type].properties[prop].distinctFrom === '$ownerId');
  }
  expect('grant and rekey gate the writer on privateFeedState (p1a, p1b)', ['privateFeedGrant', 'privateFeedRekey'].every((t) => schemas[t].ownerRefersTo?.documentType === 'privateFeedState' && schemas[t].ownerRefersTo?.findBy?.$ownerId === '.'));
  expect('grant.recipientId needs a followRequest found by (targetId, $ownerId) (p1d)', JSON.stringify(schemas.privateFeedGrant.properties.recipientId.refersTo?.findBy) === JSON.stringify({ targetId: '$ownerId', $ownerId: '.' }));
  expect('the private feed counts key generations (p1)', schemas.privateFeedRekey.properties.keyGeneration && schemas.privateFeedGrant.properties.keyGeneration && schemas.privateFeedState.properties.maxKeyGeneration && !schemas.post.properties.epoch);
  const blockers = schemas.blockFollow.properties.followedBlockers;
  expect('followedBlockers is a typed identity array with distinct, owner-excluded items (b1)', blockers.items?.refersTo?.type === 'identity' && blockers.items?.distinctFrom === '$ownerId' && blockers.uniqueItems === true);
  expect('the post action fee is 80M credits to the moderators (fixtures)', POST_ACTION_FEE?.moderators === 80_000_000n);
  expect('like.postId agrees hashtag and postAuthor with the post (o1)', where('like', 'postId').hashtag === 'hashtag' && where('like', 'postId').$ownerId === 'postAuthor');
  expect('likeReply.replyId agrees replyAuthor with the reply (o2)', where('likeReply', 'replyId').$ownerId === 'replyAuthor');
  expect('there is no repost type: a repost is a post (o3, q1)', !schemas.repost);
  expect('a quote or bare repost binds quotedPostOwnerId (o3, o4a, o4b)', where('post', 'quotedPostId').$ownerId === 'quotedPostOwnerId' && where('post', 'quotedReplyId').$ownerId === 'quotedPostOwnerId');
  expect('a nested reply binds parentOwnerId (o4d)', where('reply', 'replyToReplyId').$ownerId === 'parentOwnerId');
  expect('post and reply are immutable and owner-deletable, with no tombstone field (x1)', ['post', 'reply'].every((t) => schemas[t].documentsMutable === false && schemas[t].canBeDeleted === undefined && !schemas[t].properties.deleted) && V10.config.documentsCanBeDeletedContractDefault === true);
  expect('every reference at post or reply is deletable, so a deleted target is 40120 (x1g–x1l)', Object.values(schemas).every((s) => Object.values(s.properties).every((p) => !['post', 'reply'].includes(p.refersTo?.documentType) || p.refersTo.type === 'deletableDocument')));
  // The merged count indexes: every count the battery reads goes through a list index.
  const index = (type, name) => schemas[type].indices.find((i) => i.name === name);
  const shape = (type, name) => (index(type, name)?.properties ?? []).map((p) => Object.keys(p)[0]).join(',');
  const countsAt = (type, name, at) => index(type, name)?.rangeCountable === true && (at === undefined ? index(type, name).rankedCountable === undefined : index(type, name).rankedCountable?.at === at);
  expect('post ownerAndTime [$ownerId, $createdAt] is rangeCountable, ranked at $ownerId (q2h, q2i, q2n)', shape('post', 'ownerAndTime') === '$ownerId,$createdAt' && countsAt('post', 'ownerAndTime', '$ownerId'));
  expect('quotesOfPost / quotesOfReply [target, $createdAt] are rangeCountable, skipped when absent (x1b, x1d, q1i, q1m, q2a, q2b)',
    shape('post', 'quotesOfPost') === 'quotedPostId,$createdAt' && shape('post', 'quotesOfReply') === 'quotedReplyId,$createdAt'
      && ['quotesOfPost', 'quotesOfReply'].every((n) => countsAt('post', n) && index('post', n).skipIfAbsent === true));
  expect('one quote or repost per author and target: unique ownerAndQuotedPost / ownerAndQuotedReply, skipped when absent (q1f, q1g, q1l)',
    shape('post', 'ownerAndQuotedPost') === '$ownerId,quotedPostId' && shape('post', 'ownerAndQuotedReply') === '$ownerId,quotedReplyId'
      && ['ownerAndQuotedPost', 'ownerAndQuotedReply'].every((n) => index('post', n).unique === true && index('post', n).skipIfAbsent === true));
  // The notification-only indexes: non-overlapping 3.5-day windows (each entry
  // written once) kept for a week, $createdAt first; read as the current window
  // and the previous one by its start.
  const HALF_WEEK_WINDOW = JSON.stringify({ on: '$createdAt', range: 302_400, step: 302_400, ttl: 604_800 });
  const halfWeekly = (type, name, properties) => shape(type, name) === properties && JSON.stringify(index(type, name).timeRange) === HALF_WEEK_WINDOW;
  expect('quotedPostOwnerRecent [$createdAt, quotedPostOwnerId] is on the 3.5-day grid kept a week, skipped when absent (q1j)', halfWeekly('post', 'quotedPostOwnerRecent', '$createdAt,quotedPostOwnerId') && index('post', 'quotedPostOwnerRecent').skipIfAbsent === true);
  expect('reply parentOwnerRecent [$createdAt, parentOwnerId] is on the 3.5-day grid kept a week (n2a)', halfWeekly('reply', 'parentOwnerRecent', '$createdAt,parentOwnerId'));
  for (const [type, cases] of [['post', 'n1c'], ['reply', 'n1f']]) {
    expect(`${type} mentionedUserAndTime [mentionedUserId, $createdAt] is permanent (no window), skipped when absent, like tagAndTime (${cases})`, shape(type, 'mentionedUserAndTime') === 'mentionedUserId,$createdAt' && index(type, 'mentionedUserAndTime').skipIfAbsent === true && index(type, 'mentionedUserAndTime').timeRange === undefined);
    const mentioned = schemas[type].properties.mentionedUserId;
    expect(`${type}.mentionedUserId is an optional identifier referring to an identity (n1d, n1g)`, mentioned?.type === 'array' && mentioned.byteArray === true && mentioned.minItems === 32 && mentioned.maxItems === 32
      && mentioned.contentMediaType === 'application/x.dash.dpp.identifier' && mentioned.refersTo?.type === 'identity' && !(schemas[type].required ?? []).includes('mentionedUserId'));
  }
  // Likes keep their permanent indexes: a windowed indexOnly index cannot be
  // read as documents (the node refuses it). Design C: the heart state reads
  // the target index (terminal $ownerId), and the author index pins the target
  // before $createdAt, so it serves the per-post notification read, the
  // unlike tuple and the author's rankings. There is no byLiker.
  const names = (type) => schemas[type].indices.map((i) => i.name).join(',');
  const byAuthor = index('like', 'byAuthorPostTime');
  expect('like indexes are exactly byPost, byHashtagPost, byAuthorPostTime, byTrendPost, byTrendHashtagPost; likeReply exactly byReply, byAuthorReplyTime',
    names('like') === 'byPost,byHashtagPost,byAuthorPostTime,byTrendPost,byTrendHashtagPost' && names('likeReply') === 'byReply,byAuthorReplyTime');
  expect('like / likeReply byPost / byReply [target] terminal $ownerId: the heart state (n2c, n2f)',
    shape('like', 'byPost') === 'postId' && index('like', 'byPost').terminal === '$ownerId' && index('like', 'byPost').rangeCountable === true
      && shape('likeReply', 'byReply') === 'replyId' && index('likeReply', 'byReply').terminal === '$ownerId');
  expect('like byAuthorPostTime [postAuthor, postId, $createdAt] terminal $ownerId, rangeCountable, ranked at [postAuthor, postId], permanent (n2b, n2d, t2h)',
    shape('like', 'byAuthorPostTime') === 'postAuthor,postId,$createdAt' && byAuthor.terminal === '$ownerId' && byAuthor.rangeCountable === true
      && JSON.stringify(byAuthor.rankedCountable?.at) === JSON.stringify(['postAuthor', 'postId']) && byAuthor.timeRange === undefined);
  expect('likeReply byAuthorReplyTime [replyAuthor, replyId, $createdAt] terminal $ownerId, permanent (n2e, n2g)',
    shape('likeReply', 'byAuthorReplyTime') === 'replyAuthor,replyId,$createdAt' && index('likeReply', 'byAuthorReplyTime').terminal === '$ownerId'
      && index('likeReply', 'byAuthorReplyTime').timeRange === undefined);
  expect('no byLiker, byAuthorPost, byAuthorTimePost, byAuthorTimeReply or byAuthorRecent on like / likeReply',
    ['like', 'likeReply'].every((t) => ['byLiker', 'byAuthorPost', 'byAuthorTimePost', 'byAuthorTimeReply', 'byAuthorRecent'].every((n) => !index(t, n))));
  expect('follow.followers and followRequest.target stay permanent (no window)', index('follow', 'followers')?.timeRange === undefined && index('followRequest', 'target')?.timeRange === undefined);
  const retired = { post: ['quotedPostOwnerAndTime'], reply: ['parentOwnerAndTime'] };
  expect('the permanent notification indexes are gone (replaced by the windows)', Object.entries(retired).every(([type, names]) => names.every((n) => !index(type, n))));
  const mention = schemas.post.properties.mentionedUserId;
  expect('there is no postMention: a post names one optional mentionedUserId, an identifier that refersTo an identity (n1)',
    !schemas.postMention && mention?.contentMediaType === 'application/x.dash.dpp.identifier' && mention.byteArray === true && mention.minItems === 32 && mention.maxItems === 32
      && mention.refersTo?.type === 'identity' && !schemas.post.required?.includes('mentionedUserId'));
  expect('reply repliesOf [rootPostId, replyToReplyId, $createdAt] is rangeCountable, ranked at rootPostId, and keeps direct replies (nullable replyToReplyId, no skipIfAbsent) (x1b, x1e, x1f, q2c–q2g, q2p)',
    shape('reply', 'repliesOf') === 'rootPostId,replyToReplyId,$createdAt' && countsAt('reply', 'repliesOf', 'rootPostId')
      && index('reply', 'repliesOf').skipIfAbsent === undefined && !schemas.reply.required.includes('replyToReplyId'));
  expect('follow following [$ownerId, $createdAt] is rangeCountable; followers [followingId, $createdAt] too, ranked at followingId (q2j–q2m, q2o)',
    shape('follow', 'following') === '$ownerId,$createdAt' && countsAt('follow', 'following')
      && shape('follow', 'followers') === 'followingId,$createdAt' && countsAt('follow', 'followers', 'followingId'));
  const removed = { post: ['quoteCount', 'quoteReplyCount', 'byOwner'], reply: ['rootAndTime', 'byRoot', 'replyToReplyAndTime', 'byReplyToReply'], follow: ['followerCount', 'followingCount'] };
  expect('the count-only indexes are gone (merged into their list twins)', Object.entries(removed).every(([type, names]) => names.every((n) => !index(type, n))));
  expect('post keeps at most 10 indexes', schemas.post.indices.length <= 10);
  const notEmpty = schemas.post.propertyConstraints?.notEmpty?.anyOf ?? [];
  expect('post notEmpty: content, ciphertext, media, an embed or a quote (q1n, q1o; a bare repost passes through its quote)',
    notEmpty.length === 6 && ['encryptedContent', 'mediaUrl', 'embedId', 'quotedPostId', 'quotedReplyId'].every((p) => notEmpty.some((alt) => alt.present === p))
      && notEmpty.some((alt) => alt.greaterThan?.[0]?.length === 'content' && alt.greaterThan[1] === 0));
  expect('a repost costs the post price: 10 YAPP, optional, gas offered to the owner (q1c)', schemas.post.tokenCost?.create?.amount === TOKEN_COST.post && TOKEN_COST.post === 10 && schemas.post.tokenCost.create.optional === true);
  for (const type of ['post', 'reply']) {
    expect(`${type} content is 1000 characters / 2000 bytes (x2f–x2j)`, schemas[type].properties.content.maxLength === 1000 && schemas[type].properties.content.maxBytes === 2000);
    expect(`${type} media hash and fingerprint are required with mediaUrl, and only with it (x2a–x2d)`, JSON.stringify(schemas[type].dependentRequired) === JSON.stringify({ mediaUrl: ['mediaHash', 'mediaFingerprint'], mediaHash: ['mediaUrl'], mediaFingerprint: ['mediaUrl'] }));
  }
  expect('post has no language and a global timeline (x2k, x2l)', !schemas.post.properties.language && schemas.post.indices.some((i) => i.name === 'timeline' && JSON.stringify(i.properties) === '[{"$createdAt":"asc"}]'));
  expect('yapprProfile needs a DashPay profile (x3a)', JSON.stringify(schemas.yapprProfile.ownerRefersTo) === JSON.stringify({ type: 'deletableDocument', contractId: DASHPAY_CONTRACT_ID, documentType: 'profile', findBy: { $ownerId: '.' } }));
  expect('yapprProfile is one per owner, non-empty and moderator-deletable (x3d–x3f)', schemas.yapprProfile.indices.some((i) => i.unique && JSON.stringify(i.properties) === '[{"$ownerId":"asc"}]') && schemas.yapprProfile.minProperties === 1 && schemas.yapprProfile.moderatorAbilities?.delete === true && moderators.moderatedDocumentTypes.yapprProfile?.includes('deleteDocuments'));
  const window = (name) => schemas.like.indices.find((i) => i.name === name)?.timeRange;
  expect('there is no beat; like carries the rolling windows: tags 24h/6h skipped when untagged, posts 72h/24h (t2)',
    !schemas.beat && schemas.like.indices.some((i) => i.name === 'byTrendHashtagPost' && i.skipIfAbsent === true)
      && window('byTrendHashtagPost')?.range === 86_400 && window('byTrendHashtagPost')?.step === 21_600
      && window('byTrendPost')?.range === 259_200 && window('byTrendPost')?.step === 86_400
      && !schemas.like.indices.some((i) => /^byDay/.test(i.name)));
  expect('a report expires 90 days after it is filed', schemas.report.ttl === 7_776_000 && schemas.report.required.includes('$createdAt'));
  expect('reports are resolved through changeFields status/resolution and purged without a record (r1)', JSON.stringify(schemas.report.moderatorAbilities) === JSON.stringify({ delete: true, deleteKeepsRecord: false, changeFields: ['status', 'resolution'] }) && JSON.stringify(moderators.moderatedDocumentTypes.report) === '["deleteDocuments","changeDocumentFields"]');
  expect('reports index byStatus and byModerator (r1m, r1n)', ['byStatus', 'byModerator'].every((n) => schemas.report.indices.some((i) => i.name === n)));
  expect('one report per reporter and post, and per reporter and reply (r1b)', ['postId', 'replyId'].every((p) => schemas.report.indices.some((i) => i.unique && JSON.stringify(i.properties) === JSON.stringify([{ $ownerId: 'asc' }, { [p]: 'asc' }]))));
  expect('report.targetOwnerId agrees with the target and is not the reporter (r1d, r1e)', where('report', 'postId').$ownerId === 'targetOwnerId' && where('report', 'replyId').$ownerId === 'targetOwnerId' && schemas.report.properties.targetOwnerId.distinctFrom === '$ownerId');
  const token = V10.tokens['0'];
  expect('YAPP starts paused, nobody can unpause it or price it, and the owner may mint to anyone (y1)', token.startAsPaused === true && token.emergencyActionRules.authorizedToMakeChange.$type === 'noOne' && token.distributionRules.changeDirectPurchasePricingRules.authorizedToMakeChange.$type === 'noOne' && token.manualMintingRules.authorizedToMakeChange.$type === 'contractOwner' && token.distributionRules.mintingAllowChoosingDestination === true);
  expect('the starter grant is 100 once per identity (y1f)', token.distributionRules.oncePerIdentityDistribution?.amount === 100);
  expect('the election windows are one hour each on this devnet cut (e0c)', moderators.joinWindow === 3600 && moderators.voteWindow === 3600);
  for (const [type, rules] of Object.entries(DECLARED_RULES['yappr-social-contract-v10.json'])) {
    expect(`${type} declares exactly the propertyConstraints rules c1 and r1 assert`, JSON.stringify(Object.keys(schemas[type].propertyConstraints ?? {}).sort()) === JSON.stringify([...rules].sort()));
  }
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  if (problems.length > 0) { console.error(`${CONTRACT_FILE} no longer declares what this battery asserts`); return 1; }
  console.log(`${CONTRACT_FILE} declares every rule this battery asserts`);
  return 0;
}

if (process.argv.includes('--self-test') && selfTest() !== 0) process.exit(1);

const someId = randomIdBytes;
const botIndexArg = (flag, fallback) => { const i = process.argv.indexOf(flag); return i === -1 ? fallback : Number(process.argv[i + 1]); };
const SHAPE_MEDIA = await mediaFields();

// Offline, before runBattery: every shape the live run writes must SERIALIZE
// under the parsed v10 contract (Document.toBytes runs the type's encoder).
const SHAPES = [
  ['follow (self: refused)', 'follow', followData({ followingId: someId() })],
  ['block', 'block', blockData({ blockedId: someId() })],
  ['followRequest', 'followRequest', followRequestData({ targetId: someId() })],
  ['privateFeedState', 'privateFeedState', feedStateData()],
  ['privateFeedGrant', 'privateFeedGrant', grantData({ recipientId: someId() })],
  ['privateFeedRekey', 'privateFeedRekey', rekeyData()],
  ['blockFollow (typed ids)', 'blockFollow', blockFollowData([someId(), someId()])],
  ['post (credits, agreed fee)', 'post', postData()],
  ['post (tagged, quote + owner denorm)', 'post', postData({ hashtag: 'v10tag', quotedPostId: someId(), quotedPostOwnerId: someId() })],
  ['post (media triple + sensitive)', 'post', postData({ media: SHAPE_MEDIA, sensitive: true })],
  ['post (1000 characters)', 'post', postData({ content: 'x'.repeat(1000) })],
  ['post (one mention)', 'post', postData({ content: 'hi', mentionedUserId: someId() })],
  ['reply', 'reply', replyData({ rootPostId: someId(), parentOwnerId: someId() })],
  ['reply (one mention)', 'reply', replyData({ rootPostId: someId(), parentOwnerId: someId(), mentionedUserId: someId() })],
  ['like (tagged)', 'like', likeData({ postId: someId(), hashtag: 'v10tag', postAuthor: someId() })],
  ['like (hashtag absent)', 'like', likeData({ postId: someId(), postAuthor: someId() })],
  ['likeReply', 'likeReply', likeReplyData({ replyId: someId(), replyAuthor: someId() })],
  ['post (bare repost: a quote, no content)', 'post', repostOf({ postId: someId(), ownerId: someId() })],
  ['post (bare repost of a reply)', 'post', repostOf({ replyId: someId(), ownerId: someId() })],
  ['post (media only, no content)', 'post', SHAPE_MEDIA],
  ['report (post)', 'report', reportData({ postId: someId(), targetOwnerId: someId() })],
  ['report (reply, something else + note)', 'report', reportData({ replyId: someId(), targetOwnerId: someId(), reason: 8, note: 'why' })],
  ['yapprProfile', 'yapprProfile', yapprProfileData()],
];
if (process.argv.includes('--self-test') || process.argv.includes('--dry-run')) {
  await ensureInitialized();
  const placeholder = bs58.encode(new Uint8Array(32).fill(1));
  const platformVersion = PlatformVersion.latest();
  const contract = DataContract.fromJSON({ $formatVersion: '1', id: placeholder, ownerId: placeholder, version: 1, documentSchemas: V10.documentSchemas, config: V10.config, tokens: V10.tokens }, true, platformVersion);
  const owner = new Uint8Array(32).fill(2);
  const documentOf = (docType, data) => Document.fromObject({
    $formatVersion: '0', $id: someId(), $ownerId: owner, $dataContractId: bs58.decode(placeholder), $type: docType,
    $revision: 1n, $createdAt: Date.now(), $updatedAt: Date.now(), ...data,
  }, platformVersion);
  for (const [label, docType, data] of SHAPES) {
    try {
      documentOf(docType, data).toBytes(contract, platformVersion);
      console.log(`serializes under v10: ${label}`);
    } catch (e) {
      console.error(`FAIL  ${label} does not serialize under the v10 contract: ${String(e?.message ?? e).slice(0, 200)}`);
      process.exit(1);
    }
  }
}

await runBattery({
  name: 'v10',
  contractEnvVar: 'V10_CONTRACT_ID',
  usage:
    'Usage: node scripts/verify-v10.mjs --contract <id> [--bot <n>] [--bot2 <n>] [--fresh-bot <n> [--fresh-owner <id>]]\n' +
    '       [--moderator maker] [--owner <id>] [--owner2 <id>] [--team-member bot:<n> --reason-doc <id>] [--only e0,x1] [--dry-run|--self-test]',
  cases: CASES,
  shapes: SHAPES,
  replaceShapes: [
    ['blockFollow (grown list)', 'blockFollow', blockFollowData([someId(), someId(), someId()])],
    ['yapprProfile (edited)', 'yapprProfile', { ...yapprProfileData(), nsfw: true }],
  ],
  makeContext: ({ sdk, contractId, botA, botB }) => ({
    sdk,
    contractId,
    botA: { ...botA, wif: wifForBot(botIndexArg('--bot', 0)) },
    botB: { ...botB, wif: wifForBot(botIndexArg('--bot2', 1)) },
    prepared: false,
    contract: null,
    ownerId: null,
    moderator: null,
    seated: null,
    /** Run-unique lowercase hashtag, so per-tag assertions stay exact across re-runs. */
    tag: `v10b${Date.now().toString(36)}`,
    /** Fixture posts owned by B, keyed by role. */
    posts: {},
    replyId: null,
  }),
  summarize: (ctx) => {
    console.log(`seated charter: ${ctx.seated === null ? 'not read' : ctx.seated}`);
    console.log(`run tag: #${ctx.tag}; fixture posts: ${JSON.stringify(ctx.posts)}`);
  },
});
