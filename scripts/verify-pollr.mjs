/**
 * Registration-day battery for the **Pollr v7 contract** (5.0.0-beta.5,
 * `contracts/pollr-contract.json`, docs/NON_SOCIAL_CONTRACTS.md), run live on a
 * devnet. Actors are seed-ledger personas: a CREATOR (who owns the polls) and two
 * VOTERS. Ballots are free.
 *
 * A `poll` is `{ question, options, multiChoice, endsAt }`, immutable: closes after
 * creation and within 31 days (`endsAfterCreation`, `endsWithin31Days`), and its
 * owner may delete it only before the first ballot, withdrawn ones included
 * (`deleteConstraints.noBallots` counting `vote.byPoll`; a refused delete is a paid
 * 40147). Ballots refer to the poll as a deletableDocument, so one cast after the
 * delete is a 40120 (p8).
 *
 * `vote` is the ONE stored, mutable, undeletable ballot doctype, and a voter holds ONE
 * ballot per poll (unique `byPollVoter` [pollId, $ownerId]; a second create is 40105).
 * Its `choices` is a typed array of distinct option indices (one on a single-choice
 * poll, several on a multi-choice one); an ABSENT `choices` is a withdrawn ballot, and
 * a change of mind or a withdrawal is a REPLACE. `pollId` is immutable (40128). The
 * contract judges `choices` against the poll's own options and mode (10422
 * `choicesAreOptions` / `choicesAreOptionsHigh` / `singleChoice`), and the close is
 * the pollId `where { endsAt >= $updatedAt }`: every create AND replace must land by
 * the poll's endsAt, a late one is 40127 (p9). Tallies come off `byPollChoice`, a
 * typed-array ELEMENT index (a ballot counts once under each of its choices; a
 * withdrawn one under none), and `byPoll` counts every ballot. Acceptance is decided
 * by reading the ballot back (by its byPollVoter key for a create, by id for a
 * replace), never by the SDK's throw/no-throw.
 *
 *   NETWORK=devnet node scripts/verify-pollr.mjs [--register-test-contract] \
 *     [--creator 230] [--voter 231] [--voter2 232] [--close-in 180000] [--only p3,p6]
 *   NETWORK=devnet node scripts/verify-pollr.mjs --live-contract [--contract <id>] [--only p1,p2,p10] [--keep-content]
 *   node scripts/verify-pollr.mjs --self-test   # offline: contract declares what the cases assert
 *
 * WHERE IT RUNS. A poll with a ballot is permanent (`vote` cannot be deleted and
 * `noBallots` counts withdrawn ballots), so on the published contract every run
 * would leave polls in the app for good. By default the cases therefore run on
 * the pollr-test contract: a copy of `contracts/pollr-contract.json` the creator
 * registered once, reused by every run on this network and never read by the
 * app, so its polls stay there harmlessly. It is recorded in the gitignored
 * `.test-contracts.local.json` beside the sha256 of the file it was registered
 * from (battery-lib TEST_CONTRACTS_FILE). When none is recorded, or the file
 * changed since, the run stops and asks for `--register-test-contract`, which
 * registers a new one for about 19×10⁹ credits (≈1,150¢), paid by the creator
 * (a battery persona the treasury funds; never the maker). Nothing in the
 * contract names another contract, a token or a moderator, so the cases, their
 * ids and their expected error codes are the same on the copy.
 *
 * `--live-contract` aims the cases at the published contract instead (`--contract`,
 * POLLR_CONTRACT_ID, else NEXT_PUBLIC_POLLR_CONTRACT_ID), e.g. to prove a fresh
 * registration. Its cleanup then deletes the run's polls that took no ballot
 * and lists the others as leftovers. p2 and p10 cast only refused ballots, so
 * their polls go; the single, multi and closing polls of p1 take ballots in
 * p1, p3 and p4, and p8 votes on two of its own, so those stay for good.
 * `--keep-content` skips that cleanup.
 *
 * `--close-in` (ms, default 3 minutes) is the window of the closing poll p1 opens
 * and p9 waits out to prove the close rule live.
 *
 * Cases: p1 fixtures; p2 refersTo (ghost poll 40120) and schema-refused `choices`;
 * p3 single-choice life cycle, foreign replace, rule-breaking replaces; p4
 * multi-choice, tallies per element; p5 tallies (grouped, per option, byPoll, scan);
 * p6 my ballot (byPollVoter); p7 stale revision; p8 deletes; p9 the close (late
 * create, replace and withdraw, all 40127); p10 the propertyConstraints cases.
 */
import {
  DELETE_CONSTRAINT, DELETE_FORBIDDEN, DUPLICATE_UNIQUE, IMMUTABLE_CHANGED, PROPERTY_MISMATCH, REFERENCE_NOT_FOUND,
  decodeIntGroupKey, ghostIdentity, id32, normalizeId, reportSelfTest, runBattery, selfTest,
} from './battery-lib.mjs';
import { readFileSync } from 'node:fs';
import { buildDocument, sleep } from './seed/seed-lib.mjs';
import { DECLARED_RULES, constraintViolation, refusedCreates } from './property-constraint-cases.mjs';
import { cleanPollr, printReport } from './surface-cleanup.mjs';

const CONTRACT_FILE = 'pollr-contract.json';

/** Option labels the fixture polls carry, in order; the indices are the choices. */
const OPTIONS = ['alpha', 'bravo', 'charlie'];
const ALL_CHOICES = OPTIONS.map((_, index) => index);
const DAY_MS = 86_400_000;
/** DocumentOwnerIdMismatchError: a delete or replace signed by someone other than the document's owner. */
const OWNER_MISMATCH = /\b40102\b|mismatch with existing/i;
/** InvalidDocumentRevisionError: a replace built on a revision that is no longer current. */
const STALE_REVISION = /\b40106\b|has invalid revision/i;
/**
 * A write the JSON schema refuses (`choices: []` minItems, duplicates uniqueItems). The SDK may also
 * refuse it client-side before any broadcast, so no code is pinned: the verdict is that it is refused
 * and does not read back (the rejection text is logged verbatim at the end).
 */
const ANY_REFUSAL = /[\s\S]+/;
/** p9 waits this long past the close, so the block time stamped into $updatedAt is past it too. */
const CLOSE_MARGIN_MS = 30_000;
/** The read the client uses for "my ballot on this poll": byPollVoter. */
const VOTER_ORDER = [['pollId', 'asc'], ['$ownerId', 'asc']];

const pollData = ({ question, options = OPTIONS, multiChoice, endsAt }) => ({ question, options, multiChoice, endsAt });
/** A ballot on `poll`; `choices` undefined = withdrawn (the field is absent). */
const ballotData = (poll, choices, overrides = {}) => ({
  pollId: id32(poll.id), ...(choices === undefined ? {} : { choices }), ...overrides,
});

// ---- Ballot helpers ----------------------------------------------------------

/** A ballot's choices as a sorted number array (stored integers may come back as BigInt), undefined when absent. */
const choicesOf = (doc) => (doc.choices === undefined || doc.choices === null
  ? undefined
  : [...doc.choices].map(Number).sort((a, b) => a - b));

/** A stored ballot holds exactly `data`: its poll, and exactly those choices (none when `data` names none). */
const sameBallot = (stored, data) => normalizeId(stored.pollId) === normalizeId(data.pollId)
  && JSON.stringify(choicesOf(stored)) === JSON.stringify(choicesOf(data));

const showChoices = (doc) => `[${choicesOf(doc)?.join(',') ?? '-'}]`;
const showBallots = (docs) => docs.map((doc) => `${showChoices(doc)}@${doc.$revision}`).join(',');

/** The voter's one ballot on a poll, by its unique byPollVoter key. */
async function ballotOf(ctx, pollId, who) {
  const found = await ctx.battery.queryDocs('vote', { where: [['pollId', '==', pollId], ['$ownerId', '==', who.ownerId]], orderBy: VOTER_ORDER });
  return found[0] ?? null;
}

async function readBallot(ctx, id) {
  const doc = await ctx.battery.fetchDocument('vote', id);
  return doc ? { ...doc.toObject(), $revision: BigInt(doc.revision) } : null;
}

const verdict = (ctx, label, expect, outcome) => (expect
  ? ctx.battery.expectRejected(label, outcome, expect)
  : ctx.battery.expectAccepted(label, outcome));

/**
 * Casts a ballot. Accepted = the voter's ballot on the poll reads back holding
 * `data` under an id it did not have before the write, so a refused duplicate
 * cannot score the ballot it collided with as its own. `key` names the ballot
 * in `ctx.ids` for the cases that edit it later.
 */
async function probeBallot(ctx, label, expect, who, data, key) {
  const pollId = normalizeId(data.pollId);
  const before = normalizeId((await ballotOf(ctx, pollId, who))?.$id);
  let id = null;
  const outcome = await ctx.battery.attemptCreate(who, 'vote', data, {
    accepted: async () => {
      const now = await ballotOf(ctx, pollId, who);
      if (!now || normalizeId(now.$id) === before || !sameBallot(now, data)) return false;
      id = normalizeId(now.$id);
      return true;
    },
  });
  if (outcome.ok && key) ctx.ids.set(key, id);
  return verdict(ctx, label, expect, { ...outcome, id });
}

function idOf(ctx, key) {
  const id = ctx.ids.get(key);
  if (!id) throw new Error(`the ${key} ballot is unavailable (did its case run?)`);
  return id;
}

/**
 * Replaces a ballot with `data` at an explicit `revision` (the one the replace
 * CARRIES; default: stored + 1). Accepted = the ballot reads back at exactly that
 * revision holding exactly `data` — battery-lib's `attemptReplace` only checks
 * the revision moved, which a stale replace's target revision already satisfies.
 */
async function probeEdit(ctx, label, expect, who, key, data, revision) {
  const { battery, contractId } = ctx;
  const id = idOf(ctx, key);
  const next = revision ?? (await battery.revisionOf('vote', id)) + 1n;
  const { document } = buildDocument({ contractId, docType: 'vote', ownerId: who.ownerId, data, revision: next, id: id32(id) });
  const outcome = await battery.attemptWrite(
    { accepted: async () => { const stored = await readBallot(ctx, id); return stored !== null && stored.$revision === next && sameBallot(stored, data); } },
    () => battery.sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer })
  );
  return verdict(ctx, label, expect, { ...outcome, id });
}

/** Per-option tally: ONE grouped count off byPollChoice (a typed-array element index; a ballot counts under each of its choices). */
const tallyOf = (ctx, pollId) => ctx.battery.groupedCount('vote', [['pollId', '==', pollId], ['choices', 'containsAny', ALL_CHOICES]], ['choices'], decodeIntGroupKey);
/** One option's count: a `contains` read on the same index. */
const countChoice = (ctx, pollId, choice) => ctx.battery.countBy('vote', [['pollId', '==', pollId], ['choices', 'contains', choice]]);
/** Every ballot on a poll, withdrawn ones included: the byPoll count the noBallots rule reads. */
const ballotCount = (ctx, pollId) => ctx.battery.countBy('vote', [['pollId', '==', pollId]]);
const sameTally = (got, want) => got.size === want.size && [...want].every(([choice, count]) => got.get(choice) === count);
const showTally = (tally) => JSON.stringify(Object.fromEntries([...tally].sort(([a], [b]) => a - b)));
const myBallot = (ctx, poll, who) => ctx.battery.queryDocs('vote', { where: [['pollId', '==', poll.id], ['$ownerId', '==', who.ownerId]], orderBy: VOTER_ORDER });

// ---- Cases ------------------------------------------------------------------

async function caseP1Fixtures(ctx) {
  const { battery, creator, voter, run, args } = ctx;
  console.log('\n--- p1. fixtures: single-choice, multi-choice, never-voted and closing polls ---');
  // The closing poll goes LAST, with its pre-close ballot straight after, and its
  // close is taken from the clock right before its own create, so the window only
  // has to cover those two writes.
  for (const [key, label, multiChoice, closesIn] of [
    ['pollS', 'Single', false, DAY_MS], ['pollM', 'Multi', true, DAY_MS],
    ['pollZ', 'Untouched', false, DAY_MS], ['pollC', 'Closing', false, args['close-in']],
  ]) {
    const endsAt = Date.now() + closesIn;
    const created = await battery.probeCreate(`p1 ${key} created (multiChoice ${multiChoice}, closes ${new Date(endsAt).toISOString()})`, null, creator, 'poll', pollData({ question: `${label} ${run}?`, multiChoice, endsAt }));
    ctx[key] = created.ok ? { id: created.id, multiChoice, endsAt } : null;
  }
  if (!ctx.pollS || !ctx.pollM || !ctx.pollZ || !ctx.pollC) throw new Error('fixture polls unavailable');
  await probeBallot(ctx, 'p1e a ballot on the closing poll, cast before its close (choices [1])', null, voter, ballotData(ctx.pollC, [1]), 'C/voter');

  const stored = (await battery.fetchDocument('poll', ctx.pollS.id))?.toObject();
  battery.check('p1f the single-choice poll reads back with its options in order, multiChoice false WRITTEN (not absent), endsAt, and no optionCount',
    JSON.stringify(stored?.options) === JSON.stringify(OPTIONS) && stored?.multiChoice === false && Number(stored?.endsAt) === ctx.pollS.endsAt && stored?.optionCount === undefined,
    `options=${JSON.stringify(stored?.options)} multiChoice=${stored?.multiChoice} endsAt=${stored?.endsAt} optionCount=${stored?.optionCount}`);
}

async function caseP2References(ctx) {
  const { voter2 } = ctx;
  console.log('\n--- p2. refersTo: a ghost poll (40120) and `choices` the JSON schema refuses ---');
  // voter2 holds no ballot on pollS yet, so no unique-index collision can fire first.
  await probeBallot(ctx, 'p2a a ballot on a nonexistent poll is rejected (40120)', REFERENCE_NOT_FOUND, voter2, ballotData(ctx.pollS, [0], { pollId: id32(ghostIdentity()) }));
  await probeBallot(ctx, 'p2b a ballot with an empty `choices` is refused (minItems 1: a withdrawal omits the field)', ANY_REFUSAL, voter2, ballotData(ctx.pollS, []));
  await probeBallot(ctx, 'p2c a ballot naming the same option twice is refused (uniqueItems)', ANY_REFUSAL, voter2, ballotData(ctx.pollM, [1, 1]));
}

async function caseP3SingleChoice(ctx) {
  const { creator, voter, voter2 } = ctx;
  const S = ctx.pollS;
  console.log('\n--- p3. single choice: one ballot, changed or withdrawn by replace ---');
  await probeBallot(ctx, 'p3a voter ballot for choice 0 accepted', null, voter, ballotData(S, [0]), 'S/voter');
  await probeBallot(ctx, 'p3b a SECOND create on the same (poll, voter) is rejected (40105)', DUPLICATE_UNIQUE, voter, ballotData(S, [1]));
  await probeEdit(ctx, 'p3c changing the vote to choice 1 by replace is accepted', null, voter, 'S/voter', ballotData(S, [1]));
  await probeEdit(ctx, 'p3d withdrawing (replace without choices) is accepted', null, voter, 'S/voter', ballotData(S, undefined));
  await probeEdit(ctx, 'p3e re-picking choice 2 after the withdrawal is accepted', null, voter, 'S/voter', ballotData(S, [2]));
  await probeBallot(ctx, 'p3f a second voter is unaffected (choice 1)', null, voter2, ballotData(S, [1]), 'S/voter2');
  await probeBallot(ctx, 'p3g the creator may vote on their own poll (choice 0)', null, creator, ballotData(S, [0]), 'S/creator');
  await probeEdit(ctx, 'p3h the creator withdraws and stays withdrawn (p5 must not count it)', null, creator, 'S/creator', ballotData(S, undefined));
  await probeEdit(ctx, 'p3i moving a ballot to another poll by replace is rejected (40128 — pollId is immutable)', IMMUTABLE_CHANGED, voter, 'S/voter', ballotData(ctx.pollZ, [2]));
  await probeEdit(ctx, "p3j another voter replacing someone else's ballot is rejected (40102)", OWNER_MISMATCH, voter2, 'S/voter', ballotData(S, [0]));
  await probeEdit(ctx, 'p3k replacing with two choices on a single-choice poll is rejected (10422 singleChoice)', constraintViolation('singleChoice'), voter2, 'S/voter2', ballotData(S, [0, 1]));
  await probeEdit(ctx, 'p3l replacing with the option past the last (3 of 3) is rejected (10422 choicesAreOptions)', constraintViolation('choicesAreOptions'), voter2, 'S/voter2', ballotData(S, [OPTIONS.length]));
  ctx.expectedSingle = new Map([[1, 1], [2, 1]]); // {1: voter2, 2: voter}; the creator's is withdrawn
}

async function caseP4MultiChoice(ctx) {
  const { battery, creator, voter, voter2 } = ctx;
  const M = ctx.pollM;
  console.log('\n--- p4. multi choice: ONE ballot holding several options, counted under each ---');
  await probeBallot(ctx, 'p4a voter picks options 0 and 2 in one ballot', null, voter, ballotData(M, [0, 2]), 'M/voter');
  await probeBallot(ctx, 'p4b a second create on the same (poll, voter) is rejected (40105)', DUPLICATE_UNIQUE, voter, ballotData(M, [1]));
  await probeEdit(ctx, 'p4c widening the selection to all three options by replace is accepted', null, voter, 'M/voter', ballotData(M, [0, 1, 2]));
  const wide = await tallyOf(ctx, M.id);
  battery.check('p4d one multi-choice ballot counts once under EACH of its choices: {0: 1, 1: 1, 2: 1}', sameTally(wide, new Map([[0, 1], [1, 1], [2, 1]])), `got=${showTally(wide)}`);
  await probeEdit(ctx, 'p4e narrowing the selection to option 1 only by replace is accepted', null, voter, 'M/voter', ballotData(M, [1]));
  await probeBallot(ctx, 'p4f a second voter picks options 1 and 2', null, voter2, ballotData(M, [1, 2]), 'M/voter2');
  await probeEdit(ctx, 'p4g replacing with [0, 3] (a valid option beside options.length) is rejected (10422 choicesAreOptions)', constraintViolation('choicesAreOptions'), voter2, 'M/voter2', ballotData(M, [0, OPTIONS.length]));
  await probeEdit(ctx, 'p4h replacing with option 7 (options + 4) is rejected (10422 choicesAreOptionsHigh)', constraintViolation('choicesAreOptionsHigh'), voter2, 'M/voter2', ballotData(M, [1, OPTIONS.length + 4]));
  await probeBallot(ctx, 'p4i the creator picks option 0', null, creator, ballotData(M, [0]), 'M/creator');
  await probeEdit(ctx, 'p4j the creator withdraws (replace without choices): a ballot that counts under no option', null, creator, 'M/creator', ballotData(M, undefined));
  ctx.expectedMulti = new Map([[1, 2], [2, 1]]); // {1: voter + voter2, 2: voter2}; the creator's is withdrawn
}

async function caseP5Tallies(ctx) {
  const { battery } = ctx;
  console.log('\n--- p5. per-option tallies off the byPollChoice element index, byPoll counts every ballot ---');
  const single = await tallyOf(ctx, ctx.pollS.id);
  battery.check('p5a single-choice grouped count (containsAny, groupBy choices) matches the ballots after the edits', ctx.expectedSingle.size > 0 && sameTally(single, ctx.expectedSingle), `got=${showTally(single)} want=${showTally(ctx.expectedSingle)}`);
  const multi = await tallyOf(ctx, ctx.pollM.id);
  battery.check('p5b multi-choice grouped count counts each selected option once per ballot', ctx.expectedMulti.size > 0 && sameTally(multi, ctx.expectedMulti), `got=${showTally(multi)} want=${showTally(ctx.expectedMulti)}`);
  const ballots = await ballotCount(ctx, ctx.pollS.id);
  const tallied = [...single.values()].reduce((total, count) => total + count, 0);
  battery.check('p5c a withdrawn ballot is a document that byPoll counts but no option does (3 ballots, 2 counted)', ballots === 3 && tallied === 2, `ballots=${ballots} tallied=${tallied}`);
  const multiBallots = await ballotCount(ctx, ctx.pollM.id);
  const multiTallied = [...multi.values()].reduce((total, count) => total + count, 0);
  battery.check('p5d multi-choice: 3 ballots (one withdrawn) hold 3 counted selections', multiBallots === 3 && multiTallied === 3, `ballots=${multiBallots} selections=${multiTallied}`);
  for (const [name, poll, expected] of [['single', ctx.pollS, ctx.expectedSingle], ['multi', ctx.pollM, ctx.expectedMulti]]) {
    const per = await Promise.all(ALL_CHOICES.map((choice) => countChoice(ctx, poll.id, choice)));
    battery.check(`p5e ${name}: per-option \`contains\` counts agree with the grouped count`, per.every((count, choice) => count === (expected.get(choice) ?? 0)), `counts=${JSON.stringify(per)}`);
    const rows = await battery.queryDocs('vote', { where: [['pollId', '==', poll.id]], orderBy: VOTER_ORDER });
    const scanned = new Map();
    for (const row of rows) for (const choice of choicesOf(row) ?? []) scanned.set(choice, (scanned.get(choice) ?? 0) + 1);
    battery.check(`p5f ${name}: a full scan of the ballots agrees with the count trees and byPoll`,
      rows.length === await ballotCount(ctx, poll.id) && sameTally(scanned, expected), `ballots=${rows.length} scanned=${showTally(scanned)}`);
  }
  const untouched = await tallyOf(ctx, ctx.pollZ.id);
  const untouchedBallots = await ballotCount(ctx, ctx.pollZ.id);
  battery.check('p5g a never-voted poll has no groups and no ballots (count trees do not materialise empty branches)', untouched.size === 0 && untouchedBallots === 0, `got=${showTally(untouched)} ballots=${untouchedBallots}`);
  battery.workingShapes.push({ label: 'poll tally (byPollChoice grouped count)', shape: { documentTypeName: 'vote', where: [['pollId', '==', '<pollId>'], ['choices', 'containsAny', ALL_CHOICES]], groupBy: ['choices'] } });
  battery.workingShapes.push({ label: 'one option\'s count (byPollChoice)', shape: { documentTypeName: 'vote', where: [['pollId', '==', '<pollId>'], ['choices', 'contains', '<option index>']] } });
}

async function caseP6MyBallot(ctx) {
  const { battery, voter } = ctx;
  console.log('\n--- p6. my ballot on a poll: byPollVoter (the client read) ---');
  const multi = showBallots(await myBallot(ctx, ctx.pollM, voter));
  battery.check('p6a my multi-choice ballot: one document, choices [1] at revision 3 (create, widen, narrow)', multi === '[1]@3', `ballot=${multi}`);
  const single = showBallots(await myBallot(ctx, ctx.pollS, voter));
  battery.check('p6b my single-choice ballot: one document, choices [2] at revision 4 (create, change, withdraw, re-pick)', single === '[2]@4', `ballot=${single}`);
  battery.workingShapes.push({ label: 'my ballot on one poll (byPollVoter)', shape: { documentTypeName: 'vote', where: [['pollId', '==', '<pollId>'], ['$ownerId', '==', '<me>']], orderBy: VOTER_ORDER } });
}

async function caseP7StaleRevision(ctx) {
  const { battery, voter2 } = ctx;
  const S = ctx.pollS;
  console.log('\n--- p7. a replace built on a stale revision is refused ---');
  // voter2's pollS ballot is at revision 1 (choice 1, p3f; p3k/p3l were refused). One
  // device moves it to revision 2; a second device still holding revision 1 tries the same.
  const moved = await probeEdit(ctx, 'p7a changing choice 1 → 0 at revision 2 is accepted', null, voter2, 'S/voter2', ballotData(S, [0]), 2n);
  if (!moved.ok) return;
  await probeEdit(ctx, 'p7b a second replace built on revision 1 (carrying revision 2 again) is rejected', STALE_REVISION, voter2, 'S/voter2', ballotData(S, [2]), 2n);
  const stored = await readBallot(ctx, idOf(ctx, 'S/voter2'));
  battery.check('p7c the ballot still holds the first replace (choice 0, revision 2)', stored !== null && sameBallot(stored, ballotData(S, [0])) && stored.$revision === 2n, `choices=${stored ? showChoices(stored) : '?'} revision=${stored?.$revision}`);
  ctx.expectedSingle = new Map([[0, 1], [2, 1]]);
  const tally = await tallyOf(ctx, S.id);
  battery.check('p7d the tally follows the replace: {0: 1, 2: 1}', sameTally(tally, ctx.expectedSingle), `got=${showTally(tally)}`);
}

/** A fresh single-choice poll for one delete case, open for a day. */
async function deleteFixture(ctx, key, label) {
  const endsAt = Date.now() + DAY_MS;
  const created = await ctx.battery.probeCreate(`${key} fixture poll created`, null, ctx.creator, 'poll', pollData({ question: `${label} ${ctx.run}?`, multiChoice: false, endsAt }));
  if (!created.ok) throw new Error(`the ${key} fixture poll is unavailable`);
  return { id: created.id, multiChoice: false, endsAt };
}

async function caseP8Deletes(ctx) {
  const { battery, creator, voter } = ctx;
  console.log('\n--- p8. deletes: never a ballot; a poll only by its owner, until its first ballot (40147 noBallots) ---');
  await battery.probeDelete('p8a deleting a ballot is rejected (canBeDeleted:false)', DELETE_FORBIDDEN, voter, 'vote', idOf(ctx, 'S/voter'));
  await battery.probeDelete('p8b deleting a poll with ballots (pollS) is rejected (40147 noBallots)', DELETE_CONSTRAINT, creator, 'poll', ctx.pollS.id);

  // No ballot: only the owner deletes it, and then a ballot can no longer name it.
  const empty = await deleteFixture(ctx, 'p8c', 'Deleted');
  battery.check('p8c a poll nobody voted on has no ballots (byPoll count 0)', (await ballotCount(ctx, empty.id)) === 0);
  await battery.probeDelete('p8d a stranger deleting it is rejected (40102)', OWNER_MISMATCH, voter, 'poll', empty.id);
  const removed = await battery.probeDelete('p8e the owner deletes a poll with no ballots', null, creator, 'poll', empty.id);
  if (removed.ok) await probeBallot(ctx, 'p8f a ballot on the deleted poll is rejected (40120)', REFERENCE_NOT_FOUND, voter, ballotData(empty, [0]));

  // One ballot: permanent.
  const voted = await deleteFixture(ctx, 'p8g', 'Voted');
  const cast = await probeBallot(ctx, 'p8g a ballot on the fresh poll is accepted', null, voter, ballotData(voted, [1]), 'V/voter');
  if (cast.ok) {
    await battery.probeDelete('p8h deleting it after one ballot is rejected (40147 noBallots)', DELETE_CONSTRAINT, creator, 'poll', voted.id);
    battery.check('p8i the poll still reads back after the refused delete', (await battery.fetchDocument('poll', voted.id)) !== null);
  }

  // One withdrawn ballot: it leaves the tally but still counts for noBallots.
  const withdrawn = await deleteFixture(ctx, 'p8j', 'Withdrawn');
  const first = await probeBallot(ctx, 'p8j a ballot on the fresh poll is accepted', null, voter, ballotData(withdrawn, [2]), 'W/voter');
  const pulled = first.ok && (await probeEdit(ctx, 'p8k withdrawing it (replace without choices) is accepted', null, voter, 'W/voter', ballotData(withdrawn, undefined))).ok;
  if (pulled) {
    const tally = await tallyOf(ctx, withdrawn.id);
    const ballots = await ballotCount(ctx, withdrawn.id);
    battery.check('p8l the withdrawn ballot leaves the tally but byPoll still counts it', tally.size === 0 && ballots === 1, `tally=${showTally(tally)} ballots=${ballots}`);
    await battery.probeDelete('p8m deleting a poll whose only ballot is withdrawn is rejected (40147 noBallots)', DELETE_CONSTRAINT, creator, 'poll', withdrawn.id);
  }
  battery.workingShapes.push({ label: 'ballots on a poll, withdrawn included (byPoll count)', shape: { documentTypeName: 'vote', where: [['pollId', '==', '<pollId>']] } });
}

async function caseP9CloseRule(ctx) {
  const { battery, voter, voter2 } = ctx;
  const C = ctx.pollC;
  console.log('\n--- p9. the close: after endsAt no ballot is created or replaced (40127, the pollId where endsAt >= $updatedAt) ---');
  const waitMs = C.endsAt + CLOSE_MARGIN_MS - Date.now();
  if (waitMs > 0) {
    console.log(`     waiting ${Math.ceil(waitMs / 1000)} s for the closing poll (endsAt ${new Date(C.endsAt).toISOString()}) to close…`);
    await sleep(waitMs);
  }
  await probeBallot(ctx, 'p9a a new ballot after the close is rejected (40127)', PROPERTY_MISMATCH, voter2, ballotData(C, [0]));
  await probeEdit(ctx, 'p9b changing a ballot after the close is rejected (40127)', PROPERTY_MISMATCH, voter, 'C/voter', ballotData(C, [2]));
  await probeEdit(ctx, 'p9c withdrawing a ballot after the close is rejected (40127)', PROPERTY_MISMATCH, voter, 'C/voter', ballotData(C, undefined));
  const stored = await readBallot(ctx, idOf(ctx, 'C/voter'));
  battery.check('p9d the ballot cast before the close reads back unchanged (choices [1], revision 1)', stored !== null && sameBallot(stored, ballotData(C, [1])) && stored.$revision === 1n, `choices=${stored ? showChoices(stored) : '?'} revision=${stored?.$revision}`);
  const tally = await tallyOf(ctx, C.id);
  battery.check('p9e the closed poll\'s tally is final: {1: 1}', sameTally(tally, new Map([[1, 1]])), `got=${showTally(tally)}`);
}

/** A fresh poll of the shape a vote case's `options.referenced.pollId` asks for (option count and mode), one per shape. */
async function refPoll(ctx, { options, multiChoice }) {
  const key = `${options.length}/${multiChoice}`;
  if (!ctx.refPolls.has(key)) {
    const endsAt = Date.now() + DAY_MS;
    const created = await ctx.battery.probeCreate(`p10 fixture: a ${options.length}-option ${multiChoice ? 'multi' : 'single'}-choice poll created`, null, ctx.creator, 'poll',
      pollData({ question: `Rules ${key} ${ctx.run}?`, options, multiChoice, endsAt }));
    if (!created.ok) throw new Error(`the ${key} rules poll is unavailable`);
    ctx.refPolls.set(key, { id: created.id, multiChoice, endsAt });
  }
  return ctx.refPolls.get(key);
}

async function caseP10PropertyConstraints(ctx) {
  const { creator, run } = ctx;
  console.log('\n--- p10. propertyConstraints: the refused create cases, live (10422) ---');
  // The poll cases' endsAt is anchored to CASE_NOW (this process's start): the
  // born-closed one a second before it, so it still breaks exactly its own rule here.
  for (const [label, data, rule] of refusedCreates(CONTRACT_FILE, 'poll')) {
    await ctx.battery.probeCreate(`p10 ${label} is refused (10422 ${rule})`, constraintViolation(rule), creator, 'poll', { ...data, question: `${data.question} ${run}` });
  }
  // Every vote rule reads the poll, so each refused case runs against a real poll of
  // the option count and mode it names (`options.referenced.pollId`), its pollId
  // substituted. The creator holds no ballot on any of them (every case here is
  // refused), so no 40105 can fire first. The close is p9's, on a poll that really closed.
  for (const [label, data, rule, options] of refusedCreates(CONTRACT_FILE, 'vote')) {
    const poll = await refPoll(ctx, options.referenced.pollId);
    await probeBallot(ctx, `p10 ${label} is refused (10422 ${rule})`, constraintViolation(rule), creator, { ...data, pollId: id32(poll.id) });
  }
}

const CASES = new Map([
  ['p1', caseP1Fixtures], ['p2', caseP2References], ['p3', caseP3SingleChoice], ['p4', caseP4MultiChoice],
  ['p5', caseP5Tallies], ['p6', caseP6MyBallot], ['p7', caseP7StaleRevision], ['p8', caseP8Deletes],
  ['p9', caseP9CloseRule], ['p10', caseP10PropertyConstraints],
]);

/** runBattery's cleanup: on the published contract, the creator's polls without a ballot go; the test contract keeps its polls. */
async function cleanUpRun(ctx, { since }) {
  if (!ctx.liveContract) { console.log('the pollr-test contract keeps its polls: the app never reads it'); return; }
  printReport(await cleanPollr({ battery: ctx.battery, owners: [ctx.creator], since, live: true }));
}

await runBattery({
  label: 'pollr',
  contract: {
    env: 'POLLR_CONTRACT_ID',
    test: { name: 'pollr', file: CONTRACT_FILE, registrar: 'creator', deployedEnv: 'NEXT_PUBLIC_POLLR_CONTRACT_ID', cost: 'about 19×10⁹ credits, ≈1,150¢' },
  },
  cleanup: cleanUpRun,
  cases: CASES,
  actors: { creator: 230, voter: 231, voter2: 232 },
  flags: { 'close-in': 180_000 },
  validate: (args) => {
    if (!Number.isFinite(args['close-in']) || args['close-in'] < 60_000 || args['close-in'] > DAY_MS) {
      throw new Error('--close-in takes milliseconds between 60000 (two writes must land before the close) and 86400000');
    }
  },
  // p9: the close where. p3i: the frozen pollId. p3k/p3l/p4g/p4h/p10: the rules.
  // p8: the poll's delete rule.
  selfTest: () => {
    const declared = selfTest(CONTRACT_FILE, {
      poll: {
        constraints: DECLARED_RULES[CONTRACT_FILE].poll,
        deleteConstraints: { noBallots: { equal: [{ countOf: ['vote', { pollId: '$id' }] }, 0] } },
      },
      vote: {
        where: { pollId: { endsAt: { greaterThanOrEqual: '$updatedAt' } } },
        immutable: ['pollId'],
        constraints: DECLARED_RULES[CONTRACT_FILE].vote,
      },
    });
    // What else the cases rely on: the poll is deletable at all, ballots may refer to
    // a deletable poll, noBallots has its plain countable index to count off, a voter
    // has one ballot per poll, byPollChoice counts the elements of `choices`, and
    // the poll no longer carries an optionCount.
    const { poll, vote } = JSON.parse(readFileSync(new URL(`../contracts/${CONTRACT_FILE}`, import.meta.url), 'utf8')).documentSchemas;
    const index = (name) => vote.indices.find((entry) => entry.name === name);
    const byPoll = index('byPoll');
    const byPollVoter = index('byPollVoter');
    const byPollChoice = index('byPollChoice');
    const choices = vote.properties.choices ?? {};
    const shape = reportSelfTest(`contracts/${CONTRACT_FILE} (v8 shapes)`, [
      ['poll is immutable and canBeDeleted is true', poll.documentsMutable === false && poll.canBeDeleted === true],
      // v8: nothing lists polls (the app opens one by id), so poll declares no index at all.
      ['poll declares no indexes (v8)', poll.indices === undefined || poll.indices.length === 0],
      ['poll carries options and multiChoice but no optionCount',
        poll.properties.options !== undefined && poll.properties.multiChoice !== undefined && poll.properties.optionCount === undefined
        && !poll.required.includes('optionCount')],
      ['vote is mutable and cannot be deleted', vote.documentsMutable === true && vote.canBeDeleted === false],
      ['vote.pollId is a deletableDocument reference to poll', vote.properties.pollId.refersTo?.type === 'deletableDocument' && vote.properties.pollId.refersTo?.documentType === 'poll'],
      ['vote requires $updatedAt (the close compares it) and pollId, and has no slot or copied fields',
        vote.required.includes('$updatedAt') && vote.required.includes('pollId') && !vote.required.includes('choices')
        && ['slot', 'choice', 'pollOptionCount', 'pollMultiChoice', 'pollEndsAt'].every((name) => vote.properties[name] === undefined)],
      ['vote.choices is an array of 1-10 distinct integers 0-9',
        choices.type === 'array' && choices.minItems === 1 && choices.maxItems === 10 && choices.uniqueItems === true
        && choices.items?.type === 'integer' && choices.items?.minimum === 0 && choices.items?.maximum === 9],
      ['vote.byPoll is a plain countable [pollId] index', JSON.stringify(byPoll?.properties) === '[{"pollId":"asc"}]' && byPoll?.countable === 'countable' && !byPoll?.unique],
      ['vote.byPollVoter is unique on [pollId, $ownerId]', JSON.stringify(byPollVoter?.properties) === '[{"pollId":"asc"},{"$ownerId":"asc"}]' && byPollVoter?.unique === true],
      ['vote.byPollChoice is a countable [pollId, choices] index', JSON.stringify(byPollChoice?.properties) === '[{"pollId":"asc"},{"choices":"asc"}]' && byPollChoice?.countable === 'countable'],
    ]);
    return declared || shape;
  },
  setup: () => ({ ids: new Map(), refPolls: new Map(), expectedSingle: new Map(), expectedMulti: new Map() }),
  summary: (ctx) => `pollS=${ctx.pollS?.id} pollM=${ctx.pollM?.id} pollZ=${ctx.pollZ?.id} pollC=${ctx.pollC?.id}`,
});
