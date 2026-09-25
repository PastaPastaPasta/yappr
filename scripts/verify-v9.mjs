/**
 * Registration-day battery for **contract v9**
 * (`contracts/yappr-social-contract-v9.json`, docs/SOCIAL_V9.md): the
 * 4.2.0-beta.4 grammar Yappr adopted, exercised against a freshly registered
 * contract on a beta.4 devnet. The machinery is verify-lib; the v8 write path
 * (manual batches carrying `$actionFeeAgreement`) is social-battery-lib. v9
 * keeps v8's fees, costs and grant byte for byte, so `verify-v8.mjs` runs
 * against a v9 contract unchanged for those; this file is the v9 deltas only.
 *
 * There is NO default contract id. Pass `--contract` or set `V9_CONTRACT_ID`.
 *
 * ## Who moderates
 *
 * v9 declares ELECTED moderation with the contract owner as the interim. Until
 * a charter is seated, the owner (`--moderator maker`, the default: the maker
 * publishes the contract) moderates exactly as on v8, and is the only
 * identity that can: `contractOwner` appoints nobody. Once masternodes seat a
 * team, the owner is refused 41101 and only the team moderates, naming a listed
 * `reason` document on every ban/suspend/warn/delete (41203). Case e0 reads the
 * seat first; every moderator case SKIPS on a seated contract rather than
 * scoring a correct 41101 as a failure. The election itself (charter, join
 * requests, the contest, the team moderating) is a separate script: see the
 * `ELECTION_HOOKS` note at the bottom.
 *
 * ## Cases
 *
 *   e0  the parsed contract declares elected moderation with the owner as the
 *       interim, all three lists, and no seated charter yet
 *   d1  distinctFrom $ownerId: a self-follow, self-block and self-request are
 *       refused 10419; a follow of someone else lands (control)
 *   p1  private-feed gates: A (no privateFeedState) cannot rekey or grant
 *       (40120 on $ownerId); A enables a feed; a grant to B with no request is
 *       refused (40120 on recipientId); B requests; the grant lands; B deletes
 *       the request afterwards and the grant stays; a self-grant is refused
 *       10419; a rekey by the feed owner lands
 *   b1  typed block follows: A writes followedBlockers [B] as an identifier
 *       list and reads it back as a list; a ghost identity element is refused
 *       40120; A's own id as an element is refused 10419; a duplicate element
 *       is refused (uniqueItems); an update to [B, owner-of-contract] lands
 *   w1  warnings: the interim owner warns B with a reason citing a post; the
 *       status proves it; B's writes still land (a warning bars nothing); a
 *       second warning accumulates; clearWarnings empties it; clearing again is
 *       41117
 *   m1  interim moderator delete + restore: the owner deletes B's post (record
 *       with reason), restores it from the document fetched before the delete
 *       (record marked restored, the post fetches again); a second restore is
 *       41122
 *   m2  the interim owner bans and unbans B (v8's m1, shortened) — proof that
 *       the interim kind moderates with v8's authority before any seat
 *
 * ## Run
 *
 *   node scripts/verify-v9.mjs --self-test          # offline: contract + shapes
 *   NETWORK=devnet node scripts/verify-v9.mjs --contract <freshV9Id> \
 *        [--bot 0] [--bot2 1] [--only e0,p1]
 *
 * `--moderator` accepts only `maker` (the default): the interim kind is
 * `contractOwner`, which appoints nobody, so the publishing identity is the
 * one moderator until a charter is seated.
 *
 * Both bots need credits and YAPP on the contract under test (the post
 * fixtures pay the v8 action fee in credits, never YAPP).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import bs58 from 'bs58';
import { DataContract, Document, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import { REPO_ROOT, actionFeeFor } from './seed/seed-lib.mjs';
import {
  attemptCreate,
  attemptReplace,
  check,
  expectAccepted,
  expectRejected,
  fetchDocument,
  followData,
  randomIdBytes,
  readback,
  runBattery,
} from './verify-lib.mjs';
import {
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
import { describeErr } from './owner-keys.mjs';

const CONTRACT_FILE = 'contracts/yappr-social-contract-v9.json';
const V9 = JSON.parse(readFileSync(join(REPO_ROOT, CONTRACT_FILE), 'utf8'));
const POST_ACTION_FEE = actionFeeFor('post');
const MODERATOR_SPEC = takeFlag('--moderator', 'maker');
// v9's interim is `contractOwner`, which appoints nobody: before a charter is
// seated the contract owner is the ONLY identity that may moderate, so a
// `bot:<n>` moderator would score every moderator case as a 41101 failure.
// (A seated team's members are the election script's business.)
if (MODERATOR_SPEC !== 'maker') {
  console.error(`--moderator ${MODERATOR_SPEC}: v9's interim moderator is the contract owner alone (interim: contractOwner appoints nobody); run with --moderator maker (the default), as the identity that published the contract`);
  process.exit(1);
}

// ---- Expected rejections (code-anchored, see verify-lib) ---------------------

// "Document type "follow" property "followingId" must differ from "$ownerId", but the two values are equal"
const NOT_DISTINCT = /\bcode"?\s*[=:]\s*10419\b|must differ from "?\$ownerId"?, but the two values are equal/i;
// "referenced <entity> <id> not found for path <path>"
const REFERENCE_NOT_FOUND = /\bcode"?\s*[=:]\s*40120\b|referenced .{0,80}not found|referencedentitynotfound/i;
const NOT_FOUND_ON_OWNER = /\$ownerId/;
const NOT_FOUND_ON_RECIPIENT = /recipientId/;
// uniqueItems is a JSON-schema rule: JsonSchemaError (10101), whose message is
// "JsonSchemaError: <summary>, path: <path>". Anchored on the code or on that
// prefix plus the rule's own words, never on a bare "unique" (40105 duplicate
// unique INDEX errors say that too). The summary echoes the offending value, so
// for a list of 32-byte ids the rule's words sit ~300 characters in; beta.4
// words it "<value> has non-unique elements, path: /followedBlockers".
const DUPLICATE_ITEMS = /\bcode"?\s*[=:]\s*10101\b|jsonschemaerror.{0,2000}?(uniqueitems|duplicate items|has non-unique elements|must not have duplicate)/i;
const NOT_WARNED = /\bcode"?\s*[=:]\s*41117\b|carries no warning|contractusernotwarned/i;
const ALREADY_RESTORED = /\bcode"?\s*[=:]\s*41122\b|already restored|contractdocumentalreadyrestored/i;
const BANNED = /\bcode"?\s*[=:]\s*41107\b|contractuserbanned|is banned/i;

// ---- v9 document shapes ------------------------------------------------------

const postData = ({ content = 'v9 battery post' } = {}) => ({ content, language: 'en' });
const blockData = ({ blockedId }) => ({ blockedId });
const followRequestData = ({ targetId }) => ({ targetId });
const feedStateData = () => ({ treeCapacity: 1024, maxEpoch: 2000, encryptedSeed: randomIdBytes() });
const grantData = ({ recipientId, leafIndex = 0, epoch = 1 }) => ({ recipientId, leafIndex, epoch, encryptedPayload: crypto.getRandomValues(new Uint8Array(96)) });
const rekeyData = ({ epoch = 2, revokedLeaf = 0 } = {}) => ({ epoch, revokedLeaf, packets: crypto.getRandomValues(new Uint8Array(64)), encryptedCEK: crypto.getRandomValues(new Uint8Array(48)) });
/** A typed identifier array is a list of 32-byte ids — never one packed byte array. */
const blockFollowData = (ids) => ({ followedBlockers: ids.map((id) => (typeof id === 'string' ? bs58.decode(id) : id)) });

// ---- Reads ---------------------------------------------------------------------

async function standingOf(ctx, identityId, lists = ['banlist', 'suspensions', 'warnings']) {
  return readback(() => ctx.sdk.contracts.moderationStatus({ contractId: ctx.contractId, identityId, lists }));
}

async function queryOne(ctx, docType, where) {
  const result = await readback(() => ctx.sdk.documents.query({ dataContractId: ctx.contractId, documentTypeName: docType, where, limit: 1 }));
  for (const document of result.values()) if (document) return document;
  return null;
}

/** Deletes `who`'s document `id` of `docType`; answers the error or null. */
const deleteOwn = (ctx, who, docType, id) => errorOf(() => ctx.sdk.documents.delete({
  document: { id, ownerId: who.ownerId, dataContractId: ctx.contractId, documentTypeName: docType },
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

async function createPost(ctx, who, content) {
  const { agreement } = await feeAgreement(ctx, POST_ACTION_FEE);
  const created = await manualCreate(ctx, who, { docType: 'post', data: postData({ content }), agreement });
  if (!created.ok) console.log(`     (could not create a post: ${(created.error ?? '').slice(0, 200)})`);
  return created.ok ? created.id : null;
}

/** Skips a moderator case when a charter is seated: the interim owner is refused 41101 there, correctly. */
function interimOnly(ctx, key) {
  if (!ctx.seated) return false;
  console.log(`SKIP  ${key}: a moderation charter is seated on this contract, so the interim owner may no longer moderate (41101). Run the election script's team cases instead.`);
  return true;
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
  const declared = V9.config.moderation.moderators;
  check('e0c the published declaration is the committed one (windows, seat, additions, abilities, owner protection)',
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
  // Control: the same shape naming someone else lands (then is removed so re-runs stay clean).
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

  // A rekey by the feed owner: the epoch is unique per owner, so pick a fresh one.
  const epoch = 2 + Number(BigInt.asUintN(20, BigInt(Date.now())));
  const rekey = await attemptCreate(sdk, botA, { contractId, docType: 'privateFeedRekey', data: rekeyData({ epoch, revokedLeaf: leafIndex }) });
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
  const first = await warn('v9 battery warning 1');
  check('w1a the interim owner warns B, citing the post', first === null, (first ?? '').slice(0, 200));
  await settle();
  const status = await standingOf(ctx, botB.ownerId, ['warnings']);
  check('w1b moderationStatus proves one warning with its reason', status.warnings?.length === 1 && status.warnings[0].reason?.text === 'v9 battery warning 1', describeValue(status));

  const bookmark = post ? await attemptCreate(sdk, botB, { contractId, docType: 'bookmark', data: { postId: bs58.decode(post) } }) : null;
  if (bookmark) expectAccepted('w1c a warned identity still writes (a warning bars nothing)', bookmark);

  const second = await warn('v9 battery warning 2');
  check('w1d a second warning is accepted', second === null, (second ?? '').slice(0, 200));
  await settle();
  const two = await standingOf(ctx, botB.ownerId, ['warnings']);
  check('w1e warnings accumulate, oldest first', two.warnings?.length === 2 && two.warnings[1].reason?.text === 'v9 battery warning 2', describeValue(two));
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
  expectRejected('w1i clearing an identity with no warnings is refused (41117)', { ok: again === null, error: again }, NOT_WARNED);
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
    const removal = await sdk.contracts.moderatorDeleteDocument({ identity: moderator.identity, contractId, documentTypeName: 'post', documentId: postId, reason: { text: 'v9 battery takedown' }, signer: moderator.signer });
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
  expectRejected('m1e restoring a live document is refused (41122)', { ok: again === null, error: again }, ALREADY_RESTORED);
}

async function caseM2InterimBan(ctx) {
  const { sdk, contractId, botB, moderator } = ctx;
  console.log('\n--- m2. the interim owner bans and unbans (v8 authority before any seat) ---');
  if (interimOnly(ctx, 'm2')) return;
  const probe = () => attemptCreate(sdk, botB, { contractId, docType: 'block', data: blockData({ blockedId: randomIdBytes() }) });
  try {
    await sdk.contracts.banUser({ identity: moderator.identity, contractId, identityId: botB.ownerId, reason: { text: 'v9 battery ban' }, signer: moderator.signer });
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
]);

/**
 * ELECTION_HOOKS — the cases a separate `verify-v9-election.mjs` will own, in
 * order, against the moderation charters system contract
 * (`sdk.moderationCharters`, EG7RGfV8…): file `reason` documents; a leader
 * files a `submittedCharter` for this contract; members file `joinRequest`s
 * (`buildJoinRequest`); the leader files an `electedCharter` (opens the
 * contest, 0.5 DASH prefund); masternodes vote over joinWindow + voteWindow
 * (one day each on v9, so the run spans ≥ 1 day); after seating:
 * `team(contractId)`, the owner's ban refused 41101, a member's ban naming a
 * listed reason lands, one naming none is 41203, the owner cannot be banned
 * (ownerProtected, 41102), an addition past maxAddedModerators is 41202, and the
 * interim's pot claim is 41113. `ctx.seated` (case e0) is the switch these cases
 * key on; the interim cases here skip once it is true.
 */

// ---- Self-test ------------------------------------------------------------------

/** Offline: the committed JSON declares every rule a case asserts. */
function selfTest() {
  const schemas = V9.documentSchemas;
  const problems = [];
  const expect = (what, ok) => { if (!ok) problems.push(what); };
  const moderators = V9.config.moderation.moderators;
  expect('config $formatVersion is "2"', V9.config.$formatVersion === '2');
  expect('all three moderation lists are kept (e0, w1)', V9.config.moderation.banlist && V9.config.moderation.suspensions && V9.config.moderation.warnings);
  expect('moderators are elected with the owner as interim (e0, m1, m2, w1)', moderators.$type === 'elected' && moderators.interim?.$type === 'contractOwner');
  expect('post is moderator-deletable (m1)', schemas.post.canBeDeletedByModerators === true);
  for (const [type, prop] of [['follow', 'followingId'], ['block', 'blockedId'], ['followRequest', 'targetId'], ['privateFeedGrant', 'recipientId']]) {
    expect(`${type}.${prop} is distinctFrom $ownerId (d1, p1i)`, schemas[type].properties[prop].distinctFrom === '$ownerId');
  }
  expect('grant and rekey gate the writer on privateFeedState (p1a, p1b)', ['privateFeedGrant', 'privateFeedRekey'].every((t) => schemas[t].ownerRefersTo?.documentType === 'privateFeedState'));
  expect('grant.recipientId needs a followRequest (p1d)', schemas.privateFeedGrant.properties.recipientId.refersTo?.documentType === 'followRequest');
  const blockers = schemas.blockFollow.properties.followedBlockers;
  expect('followedBlockers is a typed identity array with distinct, owner-excluded items (b1)', blockers.items?.refersTo?.type === 'identity' && blockers.items?.distinctFrom === '$ownerId' && blockers.uniqueItems === true);
  expect('the post action fee is v8\'s (fixtures)', POST_ACTION_FEE?.moderators === 80_000_000n);
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  if (problems.length > 0) { console.error(`${CONTRACT_FILE} no longer declares what this battery asserts`); return 1; }
  console.log(`${CONTRACT_FILE} declares every rule this battery asserts`);
  return 0;
}

if (process.argv.includes('--self-test') && selfTest() !== 0) process.exit(1);

const someId = randomIdBytes;
const botIndexArg = (flag, fallback) => { const i = process.argv.indexOf(flag); return i === -1 ? fallback : Number(process.argv[i + 1]); };

// Offline, before runBattery: every shape the live run writes must SERIALIZE
// under the parsed v9 contract (Document.toBytes runs the type's encoder, which
// refuses a packed byte array where a typed list is declared), and the typed
// identifier array must round-trip as a list of 32-byte ids.
const SHAPES = [
  ['follow (self: refused)', 'follow', followData({ followingId: someId() })],
  ['block', 'block', blockData({ blockedId: someId() })],
  ['followRequest', 'followRequest', followRequestData({ targetId: someId() })],
  ['privateFeedState', 'privateFeedState', feedStateData()],
  ['privateFeedGrant', 'privateFeedGrant', grantData({ recipientId: someId() })],
  ['privateFeedRekey', 'privateFeedRekey', rekeyData()],
  ['blockFollow (typed ids)', 'blockFollow', blockFollowData([someId(), someId()])],
  ['post (credits, agreed fee)', 'post', postData()],
];
if (process.argv.includes('--self-test') || process.argv.includes('--dry-run')) {
  await ensureInitialized();
  const placeholder = bs58.encode(new Uint8Array(32).fill(1));
  const platformVersion = PlatformVersion.latest();
  const contract = DataContract.fromJSON({ $formatVersion: '1', id: placeholder, ownerId: placeholder, version: 1, documentSchemas: V9.documentSchemas, config: V9.config, tokens: V9.tokens }, true, platformVersion);
  const owner = new Uint8Array(32).fill(2);
  // Encoding is where a typed array is enforced: `toBytes` runs the type's
  // encoder, which refuses a packed byte array where a list is declared.
  // Built directly (not through buildDocument) so the document carries every
  // system clock a type may require ($updatedAt on blockFollow).
  const documentOf = (docType, data) => Document.fromObject({
    $formatVersion: '0', $id: someId(), $ownerId: owner, $dataContractId: bs58.decode(placeholder), $type: docType,
    $revision: 1n, $createdAt: Date.now(), $updatedAt: Date.now(), ...data,
  }, platformVersion);
  const serialize = (docType, data) => documentOf(docType, data).toBytes(contract, platformVersion);
  // A full round-trip of the typed list.
  const roundTrip = (data) => Document.fromBytes(serialize('blockFollow', data), contract, 'blockFollow', platformVersion);
  for (const [label, docType, data] of SHAPES) {
    try {
      serialize(docType, data);
      console.log(`serializes under v9: ${label}`);
    } catch (e) {
      console.error(`FAIL  ${label} does not serialize under the v9 contract: ${String(e?.message ?? e).slice(0, 200)}`);
      process.exit(1);
    }
  }
  const back = roundTrip(blockFollowData([someId(), someId()])).toJSON().followedBlockers;
  const ok = Array.isArray(back) && back.length === 2 && back.every((id) => bs58.decode(id).length === 32);
  console.log(`typed identifier array round-trips as a list of two base58 ids: ${ok}`);
  let packedRefused = false;
  try { roundTrip({ followedBlockers: new Uint8Array(64) }); } catch { packedRefused = true; }
  console.log(`the v8 packed-bytes encoding is refused under v9: ${packedRefused}`);
  if (!ok || !packedRefused) { console.error('FAIL  typed array document shape'); process.exit(1); }
}

await runBattery({
  name: 'v9',
  contractEnvVar: 'V9_CONTRACT_ID',
  usage:
    'Usage: node scripts/verify-v9.mjs --contract <id> [--bot <n>] [--bot2 <n>]\n' +
    '       [--moderator maker] [--owner <id>] [--owner2 <id>] [--only e0,p1] [--dry-run|--self-test]',
  cases: CASES,
  shapes: SHAPES,
  replaceShapes: [
    ['blockFollow (grown list)', 'blockFollow', blockFollowData([someId(), someId(), someId()])],
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
  }),
  summarize: (ctx) => {
    console.log(`seated charter: ${ctx.seated === null ? 'not read' : ctx.seated}`);
  },
});
