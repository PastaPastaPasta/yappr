/**
 * Registration-day battery for the **Pollr v6 contract**
 * (`contracts/pollr-contract.json`, docs/NON_SOCIAL_CONTRACTS.md), run live on a
 * devnet. Actors are seed-ledger personas: a CREATOR (who owns the polls) and two
 * VOTERS. Ballots are free.
 *
 * v6 is v5 plus the owner's delete of a poll until its first ballot: the poll's
 * `noBallots` deleteConstraints rule counts every ballot naming it (withdrawn
 * ones included) off `vote.byPoll`, and a delete that breaks it is a paid 40147.
 * Ballots refer to the poll as a deletableDocument, so one cast after the delete
 * is a 40120 (p8).
 *
 * It has ONE stored, mutable, undeletable ballot doctype, `vote`: a single-choice
 * voter holds one ballot (slot 0) whose `choice` changes or is dropped (withdrawn);
 * a multi-choice voter holds one ballot per option (slot = option), ticked
 * (choice = slot) or unticked (choice dropped). `pollId` binds the copied
 * pollOptionCount / pollMultiChoice / pollEndsAt to the poll, and every create AND
 * replace must land by the poll's close (`writtenBeforeClose`). Acceptance is
 * decided by reading the ballot back (by its byPollVoter key for a create, by id
 * for a replace), never by the SDK's throw/no-throw.
 *
 *   NETWORK=devnet node scripts/verify-pollr.mjs --contract <id> \
 *     [--creator 230] [--voter 231] [--voter2 232] [--close-in 180000] [--only p3,p6]
 *   node scripts/verify-pollr.mjs --self-test   # offline: contract declares what the cases assert
 *
 * `--close-in` (ms, default 3 minutes) is the window of the closing poll p1 opens
 * and p9 waits out to prove the close rule live.
 */
import {
  DELETE_CONSTRAINT, DELETE_FORBIDDEN, DUPLICATE_UNIQUE, IMMUTABLE_CHANGED, PROPERTY_MISMATCH, REFERENCE_NOT_FOUND,
  decodeIntGroupKey, ghostIdentity, id32, normalizeId, runBattery, selfTest,
} from './battery-lib.mjs';
import { buildDocument, sleep } from './seed/seed-lib.mjs';
import { DECLARED_RULES, constraintViolation, refusedCreates } from './property-constraint-cases.mjs';

const CONTRACT_FILE = 'pollr-contract.json';

/** Option labels the fixture polls carry, in order; the indices are the choices. */
const OPTIONS = ['alpha', 'bravo', 'charlie'];
const ALL_CHOICES = OPTIONS.map((_, index) => index);
const DAY_MS = 86_400_000;
/** InvalidDocumentRevisionError: a replace built on a revision that is no longer current. */
const STALE_REVISION = /\b40106\b|has invalid revision/i;
/** p9 waits this long past the close, so the block time stamped into $updatedAt is past it too. */
const CLOSE_MARGIN_MS = 30_000;
/** The read the client uses for "my ballots on this poll": byPollVoter, in slot order. */
const VOTER_ORDER = [['pollId', 'asc'], ['$ownerId', 'asc'], ['slot', 'asc']];
const BALLOT_FIELDS = ['pollId', 'slot', 'choice', 'pollOptionCount', 'pollMultiChoice', 'pollEndsAt'];

const pollData = ({ question, multiChoice, endsAt }) => ({ question, options: OPTIONS, optionCount: OPTIONS.length, multiChoice, endsAt });
/** What a ballot copies off its poll; a mismatch is 40127. */
const copied = (poll) => ({ pollOptionCount: OPTIONS.length, pollMultiChoice: poll.multiChoice, pollEndsAt: poll.endsAt });
/** A ballot on `poll`; `choice` undefined = withdrawn / unticked. */
const ballotData = (poll, slot, choice, overrides = {}) => ({
  pollId: id32(poll.id), slot, ...(choice === undefined ? {} : { choice }), ...copied(poll), ...overrides,
});

// ---- Ballot helpers ----------------------------------------------------------

function sameValue(stored, value) {
  if (value instanceof Uint8Array) return normalizeId(stored) === normalizeId(value);
  if (typeof value === 'number') return stored !== undefined && stored !== null && Number(stored) === value;
  return stored === value;
}

/** A stored ballot holds exactly `data`: every field it names, and no `choice` when it names none. */
const sameBallot = (stored, data) => BALLOT_FIELDS.every((name) => (name in data
  ? sameValue(stored[name], data[name])
  : stored[name] === undefined || stored[name] === null));

const showBallots = (docs) => docs.map((doc) => `${Number(doc.slot)}:${doc.choice ?? '-'}@${doc.$revision}`).join(',');

/** The voter's ballot in one slot of a poll, by its unique byPollVoter key. */
async function ballotAt(ctx, pollId, who, slot) {
  const found = await ctx.battery.queryDocs('vote', { where: [['pollId', '==', pollId], ['$ownerId', '==', who.ownerId], ['slot', '==', slot]] });
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
 * Casts a ballot. Accepted = the voter's (poll, slot) ballot reads back holding
 * `data` under an id it did not have before the write, so a refused duplicate
 * cannot score the ballot it collided with as its own. `key` names the ballot
 * in `ctx.ids` for the cases that edit it later.
 */
async function probeBallot(ctx, label, expect, who, data, key) {
  const pollId = normalizeId(data.pollId);
  const before = normalizeId((await ballotAt(ctx, pollId, who, data.slot))?.$id);
  let id = null;
  const outcome = await ctx.battery.attemptCreate(who, 'vote', data, {
    accepted: async () => {
      const now = await ballotAt(ctx, pollId, who, data.slot);
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

const tallyOf = (ctx, pollId) => ctx.battery.groupedCount('vote', [['pollId', '==', pollId], ['choice', 'in', ALL_CHOICES]], ['choice'], decodeIntGroupKey);
const sameTally = (got, want) => got.size === want.size && [...want].every(([choice, count]) => got.get(choice) === count);
const showTally = (tally) => JSON.stringify(Object.fromEntries([...tally].sort(([a], [b]) => a - b)));
const myBallots = (ctx, poll, who) => ctx.battery.queryDocs('vote', { where: [['pollId', '==', poll.id], ['$ownerId', '==', who.ownerId]], orderBy: VOTER_ORDER });

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
  await probeBallot(ctx, 'p1e a ballot on the closing poll, cast before its close (choice 1)', null, voter, ballotData(ctx.pollC, 0, 1), 'C/voter');

  const stored = (await battery.fetchDocument('poll', ctx.pollS.id))?.toObject();
  battery.check('p1f the single-choice poll reads back with its options in order, optionCount, and multiChoice false WRITTEN (not absent)',
    JSON.stringify(stored?.options) === JSON.stringify(OPTIONS) && Number(stored?.optionCount) === OPTIONS.length && stored?.multiChoice === false && Number(stored?.endsAt) === ctx.pollS.endsAt,
    `options=${JSON.stringify(stored?.options)} optionCount=${stored?.optionCount} multiChoice=${stored?.multiChoice} endsAt=${stored?.endsAt}`);
}

async function caseP2References(ctx) {
  const { voter2 } = ctx;
  console.log('\n--- p2. refersTo: ghost polls (40120) and wrong copied poll fields (40127) ---');
  // voter2 holds no ballot on pollS yet, so no unique-index collision can fire first.
  for (const [label, expect, overrides] of [
    ['p2a a ballot on a nonexistent poll is rejected (40120)', REFERENCE_NOT_FOUND, { pollId: id32(ghostIdentity()) }],
    ['p2b a ballot copying the WRONG pollOptionCount is rejected (40127)', PROPERTY_MISMATCH, { pollOptionCount: OPTIONS.length + 1 }],
    ['p2c a ballot claiming pollMultiChoice true on a single-choice poll is rejected (40127)', PROPERTY_MISMATCH, { pollMultiChoice: true }],
    ['p2d a ballot copying a LATER pollEndsAt (voting past the close) is rejected (40127)', PROPERTY_MISMATCH, { pollEndsAt: ctx.pollS.endsAt + 60_000 }],
  ]) await probeBallot(ctx, label, expect, voter2, ballotData(ctx.pollS, 0, 0, overrides));
}

async function caseP3SingleChoice(ctx) {
  const { creator, voter, voter2 } = ctx;
  const S = ctx.pollS;
  console.log('\n--- p3. single choice: one ballot (slot 0), changed or withdrawn by replace ---');
  await probeBallot(ctx, 'p3a voter ballot for choice 0 accepted', null, voter, ballotData(S, 0, 0), 'S/voter');
  await probeBallot(ctx, 'p3b a SECOND create on the same (poll, voter, slot 0) is rejected (40105)', DUPLICATE_UNIQUE, voter, ballotData(S, 0, 1));
  await probeEdit(ctx, 'p3c changing the vote to choice 1 by replace is accepted', null, voter, 'S/voter', ballotData(S, 0, 1));
  await probeEdit(ctx, 'p3d withdrawing (replace without choice) is accepted', null, voter, 'S/voter', ballotData(S, 0, undefined));
  await probeEdit(ctx, 'p3e re-picking choice 2 after the withdrawal is accepted', null, voter, 'S/voter', ballotData(S, 0, 2));
  await probeBallot(ctx, 'p3f a second voter is unaffected (choice 1)', null, voter2, ballotData(S, 0, 1), 'S/voter2');
  await probeBallot(ctx, 'p3g the creator may vote on their own poll (choice 0)', null, creator, ballotData(S, 0, 0), 'S/creator');
  await probeEdit(ctx, 'p3h the creator withdraws and stays withdrawn (p5 must not count it)', null, creator, 'S/creator', ballotData(S, 0, undefined));
  await probeEdit(ctx, 'p3i moving a ballot to another poll by replace is rejected (40128 — pollId is immutable)', IMMUTABLE_CHANGED, voter, 'S/voter', ballotData(ctx.pollZ, 0, 2));
  await probeBallot(ctx, 'p3j a slot-1 ballot on a single-choice poll is rejected (10422 singleUsesSlotZero)', constraintViolation('singleUsesSlotZero'), voter2, ballotData(S, 1, 1));
  ctx.expectedSingle = new Map([[1, 1], [2, 1]]); // {1: voter2, 2: voter}; the creator's is withdrawn
}

async function caseP4MultiChoice(ctx) {
  const { voter, voter2 } = ctx;
  const M = ctx.pollM;
  console.log('\n--- p4. multi choice: one ballot per option (slot = option), ticked or unticked ---');
  await probeBallot(ctx, 'p4a voter ticks option 0 (slot 0)', null, voter, ballotData(M, 0, 0), 'M/voter/0');
  await probeBallot(ctx, 'p4b the SAME voter ticks option 2 (slot 2 — a separate ballot)', null, voter, ballotData(M, 2, 2), 'M/voter/2');
  await probeBallot(ctx, 'p4c ticking option 2 again with a second create is rejected (40105)', DUPLICATE_UNIQUE, voter, ballotData(M, 2, 2));
  await probeEdit(ctx, 'p4d unticking option 0 (replace without choice) is accepted', null, voter, 'M/voter/0', ballotData(M, 0, undefined));
  await probeBallot(ctx, 'p4e a second voter ticks option 2', null, voter2, ballotData(M, 2, 2), 'M/voter2/2');
  await probeBallot(ctx, 'p4f a slot-0 ballot holding choice 1 is rejected (10422 multiChoiceIsSlot)', constraintViolation('multiChoiceIsSlot'), voter2, ballotData(M, 0, 1));
  await probeEdit(ctx, 'p4g moving the unticked slot-0 ballot to slot 1 by replace is rejected (40128 — slot is immutable)', IMMUTABLE_CHANGED, voter, 'M/voter/0', ballotData(M, 1, undefined));
  ctx.expectedMulti = new Map([[2, 2]]); // {2: voter + voter2}; voter's option 0 is unticked
}

async function caseP5Tallies(ctx) {
  const { battery } = ctx;
  console.log('\n--- p5. per-choice tallies off the byPollChoice count tree (skipIfAbsent choice) ---');
  const single = await tallyOf(ctx, ctx.pollS.id);
  battery.check('p5a single-choice grouped count matches the ballots after the edits', ctx.expectedSingle.size > 0 && sameTally(single, ctx.expectedSingle), `got=${showTally(single)} want=${showTally(ctx.expectedSingle)}`);
  const multi = await tallyOf(ctx, ctx.pollM.id);
  battery.check('p5b multi-choice grouped count counts ticked options only', ctx.expectedMulti.size > 0 && sameTally(multi, ctx.expectedMulti), `got=${showTally(multi)} want=${showTally(ctx.expectedMulti)}`);
  const rows = await battery.queryDocs('vote', { where: [['pollId', '==', ctx.pollS.id]], orderBy: VOTER_ORDER });
  const tallied = [...single.values()].reduce((total, count) => total + count, 0);
  battery.check('p5c a withdrawn ballot is still a document but leaves the tally (3 ballots, 2 counted)', rows.length === 3 && tallied === 2, `ballots=${rows.length} tallied=${tallied}`);
  const equality = await Promise.all(ALL_CHOICES.map((choice) => battery.countBy('vote', [['pollId', '==', ctx.pollS.id], ['choice', '==', choice]])));
  battery.check('p5d per-choice equality counts agree with the grouped count', equality.every((count, choice) => count === (ctx.expectedSingle.get(choice) ?? 0)), `counts=${JSON.stringify(equality)}`);
  const untouched = await tallyOf(ctx, ctx.pollZ.id);
  battery.check('p5e a never-voted poll has no groups (count trees do not materialise empty branches)', untouched.size === 0, `got=${showTally(untouched)}`);
  battery.workingShapes.push({ label: 'poll tally (byPollChoice grouped count)', shape: { documentTypeName: 'vote', where: [['pollId', '==', '<pollId>'], ['choice', 'in', ALL_CHOICES]], groupBy: ['choice'] } });
}

async function caseP6MyBallots(ctx) {
  const { battery, voter } = ctx;
  console.log('\n--- p6. my ballots on a poll: byPollVoter, in slot order (the client read) ---');
  const multi = showBallots(await myBallots(ctx, ctx.pollM, voter));
  battery.check('p6a my multi-choice ballots: slot 0 unticked at revision 2, slot 2 ticked at revision 1', multi === '0:-@2,2:2@1', `ballots=${multi}`);
  const single = showBallots(await myBallots(ctx, ctx.pollS, voter));
  battery.check('p6b my single-choice ballot: slot 0 holding choice 2 at revision 4 (create, change, withdraw, re-pick)', single === '0:2@4', `ballots=${single}`);
  battery.workingShapes.push({ label: 'my ballots on one poll (byPollVoter)', shape: { documentTypeName: 'vote', where: [['pollId', '==', '<pollId>'], ['$ownerId', '==', '<me>']], orderBy: VOTER_ORDER } });
}

async function caseP7StaleRevision(ctx) {
  const { battery, voter2 } = ctx;
  const S = ctx.pollS;
  console.log('\n--- p7. a replace built on a stale revision is refused ---');
  // voter2's pollS ballot is at revision 1 (choice 1, p3f). One device moves it
  // to revision 2; a second device still holding revision 1 tries the same.
  const moved = await probeEdit(ctx, 'p7a changing choice 1 → 0 at revision 2 is accepted', null, voter2, 'S/voter2', ballotData(S, 0, 0), 2n);
  if (!moved.ok) return;
  await probeEdit(ctx, 'p7b a second replace built on revision 1 (carrying revision 2 again) is rejected', STALE_REVISION, voter2, 'S/voter2', ballotData(S, 0, 2), 2n);
  const stored = await readBallot(ctx, idOf(ctx, 'S/voter2'));
  battery.check('p7c the ballot still holds the first replace (choice 0, revision 2)', stored !== null && sameBallot(stored, ballotData(S, 0, 0)) && stored.$revision === 2n, `choice=${stored?.choice} revision=${stored?.$revision}`);
  ctx.expectedSingle = new Map([[0, 1], [2, 1]]);
}

/** A fresh single-choice poll for one delete case, open for a day. */
async function deleteFixture(ctx, key, label) {
  const endsAt = Date.now() + DAY_MS;
  const created = await ctx.battery.probeCreate(`${key} fixture poll created`, null, ctx.creator, 'poll', pollData({ question: `${label} ${ctx.run}?`, multiChoice: false, endsAt }));
  if (!created.ok) throw new Error(`the ${key} fixture poll is unavailable`);
  return { id: created.id, multiChoice: false, endsAt };
}

/** Every ballot on a poll, withdrawn ones included: the byPoll count the noBallots rule reads. */
const ballotCount = (ctx, pollId) => ctx.battery.countBy('vote', [['pollId', '==', pollId]]);

async function caseP8Deletes(ctx) {
  const { battery, creator, voter } = ctx;
  console.log('\n--- p8. deletes: never a ballot; a poll only by its owner, until its first ballot (40147 noBallots) ---');
  await battery.probeDelete('p8a deleting a ballot is rejected (canBeDeleted:false)', DELETE_FORBIDDEN, voter, 'vote', idOf(ctx, 'S/voter'));
  await battery.probeDelete('p8b deleting a poll with ballots (pollS) is rejected (40147 noBallots)', DELETE_CONSTRAINT, creator, 'poll', ctx.pollS.id);

  // No ballot: the owner deletes it, and a ballot can no longer name it.
  const empty = await deleteFixture(ctx, 'p8c', 'Deleted');
  battery.check('p8c a poll nobody voted on has no ballots (byPoll count 0)', (await ballotCount(ctx, empty.id)) === 0);
  const removed = await battery.probeDelete('p8d the owner deletes a poll with no ballots', null, creator, 'poll', empty.id);
  if (removed.ok) await probeBallot(ctx, 'p8e a ballot on the deleted poll is rejected (40120)', REFERENCE_NOT_FOUND, voter, ballotData(empty, 0, 0));

  // One ballot: permanent.
  const voted = await deleteFixture(ctx, 'p8f', 'Voted');
  const cast = await probeBallot(ctx, 'p8f a ballot on the fresh poll is accepted', null, voter, ballotData(voted, 0, 1), 'V/voter');
  if (cast.ok) {
    await battery.probeDelete('p8g deleting it after one ballot is rejected (40147 noBallots)', DELETE_CONSTRAINT, creator, 'poll', voted.id);
    battery.check('p8h the poll still reads back after the refused delete', (await battery.fetchDocument('poll', voted.id)) !== null);
  }

  // One withdrawn ballot: it leaves the tally but still counts for noBallots.
  const withdrawn = await deleteFixture(ctx, 'p8i', 'Withdrawn');
  const first = await probeBallot(ctx, 'p8i a ballot on the fresh poll is accepted', null, voter, ballotData(withdrawn, 0, 2), 'W/voter');
  const pulled = first.ok && (await probeEdit(ctx, 'p8j withdrawing it (replace without choice) is accepted', null, voter, 'W/voter', ballotData(withdrawn, 0, undefined))).ok;
  if (pulled) {
    const tally = await tallyOf(ctx, withdrawn.id);
    const ballots = await ballotCount(ctx, withdrawn.id);
    battery.check('p8k the withdrawn ballot leaves the tally but byPoll still counts it', tally.size === 0 && ballots === 1, `tally=${showTally(tally)} ballots=${ballots}`);
    await battery.probeDelete('p8l deleting a poll whose only ballot is withdrawn is rejected (40147 noBallots)', DELETE_CONSTRAINT, creator, 'poll', withdrawn.id);
  }
  battery.workingShapes.push({ label: 'ballots on a poll, withdrawn included (byPoll count)', shape: { documentTypeName: 'vote', where: [['pollId', '==', '<pollId>']] } });
}

async function caseP9CloseRule(ctx) {
  const { battery, voter, voter2 } = ctx;
  const C = ctx.pollC;
  console.log('\n--- p9. the close: after endsAt no ballot is created or changed (10422 writtenBeforeClose) ---');
  const waitMs = C.endsAt + CLOSE_MARGIN_MS - Date.now();
  if (waitMs > 0) {
    console.log(`     waiting ${Math.ceil(waitMs / 1000)} s for the closing poll (endsAt ${new Date(C.endsAt).toISOString()}) to close…`);
    await sleep(waitMs);
  }
  const closed = constraintViolation('writtenBeforeClose');
  await probeBallot(ctx, 'p9a a new ballot after the close is rejected', closed, voter2, ballotData(C, 0, 0));
  await probeEdit(ctx, 'p9b changing a ballot after the close is rejected', closed, voter, 'C/voter', ballotData(C, 0, 2));
  await probeEdit(ctx, 'p9c withdrawing a ballot after the close is rejected', closed, voter, 'C/voter', ballotData(C, 0, undefined));
  const stored = await readBallot(ctx, idOf(ctx, 'C/voter'));
  battery.check('p9d the ballot cast before the close reads back unchanged (choice 1, revision 1)', stored !== null && sameBallot(stored, ballotData(C, 0, 1)) && stored.$revision === 1n, `choice=${stored?.choice} revision=${stored?.$revision}`);
  const tally = await tallyOf(ctx, C.id);
  battery.check('p9e the closed poll\'s tally is final: {1: 1}', sameTally(tally, new Map([[1, 1]])), `got=${showTally(tally)}`);
}

async function caseP10PropertyConstraints(ctx) {
  const { creator, run } = ctx;
  console.log('\n--- p10. propertyConstraints: the refused create cases, live (10422) ---');
  // The poll cases' endsAt is anchored to CASE_NOW (this process's start): the
  // optionCountMatches case closes a day after it, the born-closed one a second
  // before it, so both still break exactly their own rule here.
  for (const [label, data, rule] of refusedCreates(CONTRACT_FILE, 'poll')) {
    await ctx.battery.probeCreate(`p10 ${label} is refused (10422 ${rule})`, constraintViolation(rule), creator, 'poll', { ...data, question: `${data.question} ${run}` });
  }
  // A ballot on a random pollId would be refused 40120 first, so each vote case
  // is re-pointed at a real fixture poll of its mode, with that poll's copied
  // fields; the creator holds no ballot on either, so no 40105 can fire.
  // writtenBeforeClose is p9's, on a poll that really closed.
  for (const [label, data, rule] of refusedCreates(CONTRACT_FILE, 'vote').filter(([, , refusedBy]) => refusedBy !== 'writtenBeforeClose')) {
    const poll = data.pollMultiChoice ? ctx.pollM : ctx.pollZ;
    await probeBallot(ctx, `p10 ${label} is refused (10422 ${rule})`, constraintViolation(rule), creator, { ...data, pollId: id32(poll.id), ...copied(poll) });
  }
}

const CASES = new Map([
  ['p1', caseP1Fixtures], ['p2', caseP2References], ['p3', caseP3SingleChoice], ['p4', caseP4MultiChoice],
  ['p5', caseP5Tallies], ['p6', caseP6MyBallots], ['p7', caseP7StaleRevision], ['p8', caseP8Deletes],
  ['p9', caseP9CloseRule], ['p10', caseP10PropertyConstraints],
]);

await runBattery({
  label: 'pollr',
  contract: { env: 'POLLR_CONTRACT_ID' },
  cases: CASES,
  actors: { creator: 230, voter: 231, voter2: 232 },
  flags: { 'close-in': 180_000 },
  validate: (args) => {
    if (!Number.isFinite(args['close-in']) || args['close-in'] < 60_000 || args['close-in'] > DAY_MS) {
      throw new Error('--close-in takes milliseconds between 60000 (two writes must land before the close) and 86400000');
    }
  },
  // p2: the copied poll fields. p3i/p4g: the frozen ballot fields. p3j/p4f/p9/p10: the rules.
  // p8: the poll's delete rule.
  selfTest: () => selfTest(CONTRACT_FILE, {
    poll: {
      constraints: DECLARED_RULES[CONTRACT_FILE].poll,
      deleteConstraints: { noBallots: { equal: [{ countOf: ['vote', { pollId: '$id' }] }, 0] } },
    },
    vote: {
      where: { pollId: { optionCount: 'pollOptionCount', multiChoice: 'pollMultiChoice', endsAt: 'pollEndsAt' } },
      immutable: ['pollId', 'slot'],
      constraints: DECLARED_RULES[CONTRACT_FILE].vote,
    },
  }),
  setup: () => ({ ids: new Map(), expectedSingle: new Map(), expectedMulti: new Map() }),
  summary: (ctx) => `pollS=${ctx.pollS?.id} pollM=${ctx.pollM?.id} pollZ=${ctx.pollZ?.id} pollC=${ctx.pollC?.id}`,
});
