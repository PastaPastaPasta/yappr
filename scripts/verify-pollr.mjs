/**
 * Registration-day battery for the **Pollr contract**
 * (`contracts/pollr-contract.json`, docs/NON_SOCIAL_CONTRACTS.md), run live on a
 * beta.1+ devnet. Actors are seed-ledger personas: a CREATOR (who owns the polls
 * and pays for the preallocated ballot trees) and two VOTERS. Ballots are free.
 *
 * Ballots are indexOnly: no id-addressable row, so every acceptance is decided by
 * a VALUE query on `byPollChoice`, never by the SDK's throw/no-throw —
 * `documents.create()` can throw post-broadcast for a write that landed.
 *
 *   NETWORK=devnet node scripts/verify-pollr.mjs --contract <id> \
 *     [--creator 230] [--voter 231] [--voter2 232] [--v3 <v3 contract id>] [--only p3,p6]
 *   node scripts/verify-pollr.mjs --self-test   # offline: contract declares what the cases assert
 */
import {
  DELETE_FORBIDDEN, DUPLICATE_UNIQUE, FOREIGN_SIGNATURE, PROPERTY_MISMATCH, REFERENCE_NOT_FOUND,
  decodeIntGroupKey, ghostIdentity, id32, runBattery, selfTest,
} from './battery-lib.mjs';
import { buildDocument, describeErr, randomEntropy } from './seed/seed-lib.mjs';

/** Option labels the fixture polls carry, in order; the indices are the choices. */
const OPTIONS = ['alpha', 'bravo', 'charlie'];
const ALL_CHOICES = OPTIONS.map((_, index) => index);
// An `in` (or range) clause on an indexOnly prefix property REQUIRES an explicit
// orderBy on it ("missing order by for range error"); equality-only reads do not.
const CHOICE_IN = [['choice', 'in', ALL_CHOICES]];
const CHOICE_ORDER = [['choice', 'asc']];
// `isDuplicateVoteError` in lib/services/pollr-vote-service.ts, verbatim. Keep the
// two in step: the client's duplicate/landed routing hangs off this predicate.
const CLIENT_DUPLICATE_PREDICATE = /duplicate unique properties|\b40105\b/i;
// Floor for the extra credits a poll create pays over a byte-identical v3 one (p7):
// the whole delta is the preallocated ballot trees. Measured delta is ~18M.
const PREALLOCATION_FLOOR = 5_000_000n;

const pollData = ({ run, label, multiChoice }) => ({ question: `${label} ${run}?`, ...Object.fromEntries(OPTIONS.map((option, index) => [`option${index}`, option])), ...(multiChoice ? { multiChoice: true } : {}) });
const ballotData = ({ pollId, pollOwnerId, choice }) => ({ pollId, pollOwnerId, choice });

// ---- Ballot helpers ----------------------------------------------------------

/** The indexOnly acceptance probe: this voter's entry for (poll, choice). */
const entryWhere = (pollId, who, choice) => [['pollId', '==', pollId], ['choice', '==', choice], ['$ownerId', '==', who.ownerId]];
const entryExists = (ctx, docType, pollId, who, choice) => ctx.battery.entryExists(docType, entryWhere(pollId, who, choice));

/** Casts a ballot, deciding acceptance by readback on `byPollChoice`. */
function castBallot(ctx, docType, who, pollId, choice, { pollOwnerId, accepted } = {}) {
  const data = ballotData({ pollId: id32(pollId), pollOwnerId: id32(pollOwnerId ?? ctx.creator.ownerId), choice });
  return ctx.battery.attemptCreateByValues(who, docType, data, entryWhere(pollId, who, choice), { accepted });
}

/** A ballot and its verdict in one line; `expect` is null when it must land. */
async function probeBallot(ctx, label, expect, docType, who, pollId, choice, options) {
  const outcome = await castBallot(ctx, docType, who, pollId, choice, options);
  return expect ? ctx.battery.expectRejected(label, outcome, expect) : ctx.battery.expectAccepted(label, outcome);
}

/**
 * Re-casts a ballot the voter has ALREADY cast verbatim. Entry existence cannot
 * decide this one — the first entry is already there — so acceptance means "a
 * SECOND entry appeared". Sound only because the battery is the sole writer of
 * these fixture polls: a concurrent voter on the same option would read as accepted.
 */
async function probeRecast(ctx, label, docType, who, pollId, choice) {
  const entries = async () => (await ctx.battery.queryDocs(docType, { where: [['pollId', '==', pollId], ['choice', '==', choice]] })).length;
  const before = await entries();
  const outcome = await castBallot(ctx, docType, who, pollId, choice, { accepted: async () => (await entries()) > before });
  return ctx.battery.expectRejected(label, outcome, DUPLICATE_UNIQUE);
}

const tallyOf = (ctx, docType, pollId) => ctx.battery.groupedCount(docType, [['pollId', '==', pollId], ...CHOICE_IN], ['choice'], decodeIntGroupKey);
const sameTally = (got, want) => got.size === want.size && [...want].every(([choice, count]) => got.get(choice) === count);
const showTally = (tally) => JSON.stringify(Object.fromEntries([...tally].sort(([a], [b]) => a - b)));

// ---- Cases ------------------------------------------------------------------

async function caseP1Fixtures(ctx) {
  const { battery, creator, run } = ctx;
  console.log('\n--- p1. fixtures: single-choice, multi-choice and never-voted polls ---');
  for (const [key, label, multiChoice] of [['pollS', 'Single', false], ['pollM', 'Multi', true], ['pollZ', 'Untouched', false]]) {
    const created = await battery.probeCreate(`p1 ${key} created`, null, creator, 'poll', pollData({ run, label, multiChoice }));
    ctx[key] = created.ok ? created.id : null;
  }
  if (!ctx.pollS || !ctx.pollM || !ctx.pollZ) throw new Error('fixture polls unavailable');
  // The "a poll may attest an author who is not its creator" gap is GONE: ballots
  // bind pollOwnerId to the poll's $ownerId, set from the signature. p2c/p2d prove it.
}

async function caseP2References(ctx) {
  const { voter, voter2 } = ctx;
  console.log('\n--- p2. refersTo: ghost polls (40120) and forged pollOwnerId (40127) ---');
  const ghost = ghostIdentity();
  const forged = { pollOwnerId: voter2.ownerId };
  // Every probe uses a (poll, voter, choice) the signer has NOT used: the structural
  // duplicate check fires before the reference checks.
  for (const [label, expect, docType, who, pollId, choice, options] of [
    ['p2a vote on a nonexistent poll is rejected (40120)', REFERENCE_NOT_FOUND, 'vote', voter, ghost, 0, undefined],
    ['p2b multiVote on a nonexistent poll is rejected (40120)', REFERENCE_NOT_FOUND, 'multiVote', voter, ghost, 0, undefined],
    ['p2c vote carrying the WRONG pollOwnerId is rejected (40127)', PROPERTY_MISMATCH, 'vote', voter2, ctx.pollS, 2, forged],
    ['p2d multiVote carrying the WRONG pollOwnerId is rejected (40127)', PROPERTY_MISMATCH, 'multiVote', voter2, ctx.pollM, 2, forged],
  ]) await probeBallot(ctx, label, expect, docType, who, pollId, choice, options);
}

async function caseP3SingleChoice(ctx) {
  const { battery, creator, voter, voter2 } = ctx;
  console.log('\n--- p3. single choice is structural: one entry per (poll, voter) ---');
  await probeBallot(ctx, 'p3a voter ballot for choice 0 accepted', null, 'vote', voter, ctx.pollS, 0);
  const changed = await probeBallot(ctx, 'p3b the SAME voter changing to choice 1 is rejected (40105 — byPoll admits one entry per voter)', DUPLICATE_UNIQUE, 'vote', voter, ctx.pollS, 1);
  // The client routes this rejection by TEXT: a duplicate that reads as an ordinary
  // error goes to the landed probe, which finds the EARLIER entry and calls the
  // rejected write a cast ballot. Pin the wording the structural rule produces.
  battery.check("p3b' the rejection matches pollrVoteService.isDuplicateVoteError's predicate verbatim", CLIENT_DUPLICATE_PREDICATE.test(changed.error ?? ''), (changed.error ?? '').slice(0, 160));
  await probeRecast(ctx, 'p3c the same voter repeating choice 0 verbatim is rejected (40105)', 'vote', voter, ctx.pollS, 0);
  await probeBallot(ctx, 'p3d a SECOND voter is unaffected (choice 1)', null, 'vote', voter2, ctx.pollS, 1);
  await probeBallot(ctx, 'p3e the creator may vote on their own poll (choice 1)', null, 'vote', creator, ctx.pollS, 1);
  ctx.expectedSingle = new Map([[0, 1], [1, 2]]); // {0: voter, 1: voter2 + creator}
}

async function caseP4MultiChoice(ctx) {
  const { voter, voter2 } = ctx;
  console.log('\n--- p4. multi choice: one entry per (poll, voter, choice) ---');
  await probeBallot(ctx, 'p4a voter selects choice 0', null, 'multiVote', voter, ctx.pollM, 0);
  await probeBallot(ctx, 'p4b the SAME voter adds choice 2 (accepted — the entry differs)', null, 'multiVote', voter, ctx.pollM, 2);
  await probeRecast(ctx, 'p4c repeating choice 0 is rejected (40105)', 'multiVote', voter, ctx.pollM, 0);
  await probeBallot(ctx, 'p4d a second voter selects choice 2', null, 'multiVote', voter2, ctx.pollM, 2);
  ctx.expectedMulti = new Map([[0, 1], [2, 2]]); // {0: voter, 2: voter + voter2}
}

async function caseP5Tallies(ctx) {
  const { battery } = ctx;
  console.log('\n--- p5. per-choice tallies off the count tree ---');
  const single = await tallyOf(ctx, 'vote', ctx.pollS);
  battery.check('p5a single-choice grouped count matches the ballots cast', sameTally(single, ctx.expectedSingle), `got=${showTally(single)} want=${showTally(ctx.expectedSingle)}`);
  const multi = await tallyOf(ctx, 'multiVote', ctx.pollM);
  battery.check('p5b multi-choice grouped count matches the selections cast', sameTally(multi, ctx.expectedMulti), `got=${showTally(multi)} want=${showTally(ctx.expectedMulti)}`);
  const total = [...single.values()].reduce((sum, count) => sum + count, 0);
  battery.check('p5c the single-choice grouped total is the VOTER count (one ballot each)', total === 3, `total=${total}`);
  const untouched = await tallyOf(ctx, 'vote', ctx.pollZ);
  battery.check('p5d a never-voted poll has no groups (count trees do not materialise empty branches)', untouched.size === 0, `got=${showTally(untouched)}`);
  // A count on `pollId` ALONE is a prefix count, which boolean `rankedCountable`
  // does not give: it puts the count tree at the `choice` level only. (The
  // `rankedCountable: {at}` form would, but `byPoll` terminates at exactly that
  // level and prefix-exclusivity refuses it.) The client sums the grouped tally.
  for (const [label, docType, pollId] of [['p5e `vote`', 'vote', ctx.pollS], ['p5f multiVote', 'multiVote', ctx.pollM]]) {
    let outcome = 'accepted';
    try { await battery.countBy(docType, [['pollId', '==', pollId]]); } catch (e) { outcome = describeErr(e); }
    battery.check(`${label} refuses a bare prefix count on pollId (the count tree lives at the choice level)`, /countable/i.test(outcome), outcome.slice(0, 150));
  }
}

async function caseP6RankedWinner(ctx) {
  const { battery } = ctx;
  console.log('\n--- p6. ranked winner: groupBy choice with the poll pinned ---');
  const winner = await battery.ranked('vote', 'choice', { type: 'count' }, { where: [['pollId', '==', ctx.pollS]], limit: 1 });
  const top = winner.page.entries?.[0];
  battery.check('p6a the ranked top-1 group is the winning option (choice 1, two ballots)', decodeIntGroupKey(top?.groupValue) === 1 && Number(top?.value) === 2, `groupValue=${JSON.stringify(top?.groupValue)} value=${top?.value}`);
  // decodeIntGroupKey accepts both forms, but pollrVoteService.getWinner does a bare
  // Number(). Pin the form docs/NON_SOCIAL_CONTRACTS.md claims ranked values arrive in.
  battery.check("p6a' ranked integer group values arrive DECODED, not as the 0x80-offset hex grouped counts use", typeof top?.groupValue === 'number', `typeof groupValue=${typeof top?.groupValue}`);
  battery.workingShapes.push({ label: 'poll winner (ranked, byPollChoice terminal level)', shape: { ...winner.shape, dataContractId: '<contractId>', where: [['pollId', '==', '<pollId>']] } });

  const full = await battery.ranked('vote', 'choice', { type: 'count' }, { where: [['pollId', '==', ctx.pollS]] });
  const page = new Map((full.page.entries ?? []).map((entry) => [decodeIntGroupKey(entry.groupValue), Number(entry.value)]));
  // `every` over an empty expectation is vacuously true — require p3 to have run.
  battery.check('p6b the full ranked page carries every voted option with exact counts', ctx.expectedSingle.size > 0 && [...ctx.expectedSingle].every(([choice, count]) => page.get(choice) === count), `page=${showTally(page)} want=${showTally(ctx.expectedSingle)}`);

  const multi = await battery.ranked('multiVote', 'choice', { type: 'count' }, { where: [['pollId', '==', ctx.pollM]], limit: 1 });
  const multiTop = multi.page.entries?.[0];
  battery.check('p6c the multi-choice ranked top-1 group is choice 2 (two selections)', decodeIntGroupKey(multiTop?.groupValue) === 2 && Number(multiTop?.value) === 2, `groupValue=${JSON.stringify(multiTop?.groupValue)} value=${multiTop?.value}`);
}

async function caseP7Preallocation(ctx) {
  const { battery, creator } = ctx;
  console.log('\n--- p7. preallocation: the poll creator pays for the ballot trees ---');
  if (!ctx.args.v3) { battery.check('p7 preallocation cost comparison', true, 'skipped — pass --v3 <v3 contract id> to measure'); return; }
  const costOf = async (contract, label) => {
    const before = await battery.balanceOf(creator.ownerId);
    // Identical payloads on both contracts, so the delta is preallocation alone.
    const created = await battery.attemptCreate(creator, 'poll', { question: `Cost ${label} ${ctx.run}?`, option0: OPTIONS[0], option1: OPTIONS[1] }, { contract });
    if (!created.ok) throw new Error(`${label} poll create failed: ${(created.error ?? '').slice(0, 160)}`);
    return before - (await battery.balanceOf(creator.ownerId));
  };
  const v3Cost = await costOf(ctx.args.v3, 'v3');
  const cost = await costOf(ctx.contractId, 'current');
  battery.check(`p7a a poll create costs at least ${PREALLOCATION_FLOOR} credits more than the BYTE-IDENTICAL v3 poll — the preallocated vote.byPoll / vote.byPollOwner trees are billed to the creator`, cost - v3Cost >= PREALLOCATION_FLOOR, `v3=${v3Cost} credits, current=${cost} credits, delta=${cost - v3Cost}`);
}

async function caseP8Unvote(ctx) {
  const { battery, voter } = ctx;
  console.log('\n--- p8. unvote: query-recovered tuple, delete-by-values, re-vote ---');
  // NOTHING from the create call is reused (its Document is unreliable for indexOnly
  // types). A projection carries only what ITS OWN index path holds, so byPollChoice
  // yields pollId + choice and NOT pollOwnerId — that comes off the poll's $ownerId,
  // where the write took it from. With no `$createdAt` there is nothing else.
  const mine = await battery.queryDocs('vote', { where: [['pollId', '==', ctx.pollS], ...CHOICE_IN, ['$ownerId', '==', voter.ownerId]], orderBy: CHOICE_ORDER });
  const choice = mine[0] === undefined ? null : Number(mine[0].choice);
  const pollFields = (await battery.fetchDocument('poll', ctx.pollS))?.toObject();
  const pollOwner = pollFields?.$ownerId ? battery.b58(pollFields.$ownerId) : null;
  battery.check("p8a the delete tuple recovers: choice from the byPollChoice projection, pollOwnerId from the poll's $ownerId", choice === 0 && pollOwner === ctx.creator.ownerId, `choice=${choice} pollOwnerId=${pollOwner} entries=${mine.length} (projection keys: ${Object.keys(mine[0] ?? {}).join(',')})`);
  if (choice === null || pollOwner === null) return;

  const before = await tallyOf(ctx, 'vote', ctx.pollS);
  const { document } = buildDocument({ contractId: ctx.contractId, docType: 'vote', ownerId: voter.ownerId, data: ballotData({ pollId: id32(ctx.pollS), pollOwnerId: id32(pollOwner), choice }), entropy: randomEntropy() });
  const deleted = battery.expectAccepted('p8b delete-by-values with the query-recovered tuple is accepted (no $createdAt needed)', await battery.attemptDeleteByValues(voter, document, async () => !(await entryExists(ctx, 'vote', ctx.pollS, voter, choice))));
  if (!deleted.ok) return;
  const after = await tallyOf(ctx, 'vote', ctx.pollS);
  battery.check('p8c the count tree decrements after the unvote', (before.get(choice) ?? 0) - (after.get(choice) ?? 0) === 1, `before=${showTally(before)} after=${showTally(after)}`);
  await probeBallot(ctx, 'p8d re-voting after the unvote is accepted (structural uniqueness cleared)', null, 'vote', voter, ctx.pollS, choice);
}

async function caseP9ForeignDelete(ctx) {
  const { battery, voter, voter2 } = ctx;
  console.log("\n--- p9. deleting someone ELSE'S ballot is refused ---");
  // voter2's entry on pollS is choice 1 (p3d); voter signs a delete carrying it.
  const { document } = buildDocument({ contractId: ctx.contractId, docType: 'vote', ownerId: voter2.ownerId, data: ballotData({ pollId: id32(ctx.pollS), pollOwnerId: id32(ctx.creator.ownerId), choice: 1 }), entropy: randomEntropy() });
  battery.expectRejected("p9a deleting the other voter's ballot with our own signature is rejected", await battery.attemptDeleteByValues(voter, document, async () => !(await entryExists(ctx, 'vote', ctx.pollS, voter2, 1))), FOREIGN_SIGNATURE);
  battery.check('p9b the victim entry survives the attack', await entryExists(ctx, 'vote', ctx.pollS, voter2, 1));
}

async function caseP10ReadSurfaces(ctx) {
  const { battery, voter, creator } = ctx;
  console.log('\n--- p10. read surfaces: my votes, my choices on a poll, votes on my polls ---');
  const choicesOf = (docs) => docs.map((doc) => Number(doc.choice)).sort((a, b) => a - b).join(',');
  const myVotes = await battery.queryDocs('vote', { where: [['$ownerId', '==', voter.ownerId]] });
  battery.check('p10a byVoterChoice lists my single-choice ballots (poll id + choice)', myVotes.map((doc) => battery.b58(doc.pollId)).includes(ctx.pollS), `polls=${myVotes.length}`);
  battery.workingShapes.push({ label: 'my votes (byVoterChoice)', shape: { documentTypeName: 'vote', where: [['$ownerId', '==', '<me>']] } });

  const myMulti = await battery.queryDocs('multiVote', { where: [['$ownerId', '==', voter.ownerId]] });
  const mine = choicesOf(myMulti.filter((doc) => battery.b58(doc.pollId) === ctx.pollM));
  battery.check('p10b byVoterChoice lists every multi-choice selection I cast', mine === '0,2', `choices=[${mine}]`);

  const onPoll = await battery.queryDocs('multiVote', { where: [['pollId', '==', ctx.pollM], ...CHOICE_IN, ['$ownerId', '==', voter.ownerId]], orderBy: CHOICE_ORDER });
  battery.check('p10c the per-poll choice read (pollId ==, choice in [...], $ownerId ==) returns exactly my selections', choicesOf(onPoll) === '0,2', `choices=[${choicesOf(onPoll)}]`);
  battery.workingShapes.push({ label: 'my choices on one poll (byPollChoice)', shape: { documentTypeName: 'multiVote', where: [['pollId', '==', '<pollId>'], ['choice', 'in', ALL_CHOICES], ['$ownerId', '==', '<me>']], orderBy: CHOICE_ORDER } });

  // Pinned to THIS run's poll: the creator persona is reused, so a bare `length >= 3`
  // would be satisfied by earlier runs even if this run's entries never landed.
  const onMyPolls = await battery.queryDocs('vote', { where: [['pollOwnerId', '==', creator.ownerId]] });
  const onThisPoll = onMyPolls.filter((doc) => battery.b58(doc.pollId) === ctx.pollS);
  battery.check('p10d byPollOwner answers "votes on my polls", including every ballot on this run\'s poll', onThisPoll.length === 3, `thisPoll=${onThisPoll.length} allTime=${onMyPolls.length}`);
}

async function caseP11Permanence(ctx) {
  console.log('\n--- p11. the poll is permanent (a ballot can always resolve its reference) ---');
  await ctx.battery.probeDelete('p11a deleting a poll is rejected (canBeDeleted:false)', DELETE_FORBIDDEN, ctx.creator, 'poll', ctx.pollZ);
}

const CASES = new Map([
  ['p1', caseP1Fixtures], ['p2', caseP2References], ['p3', caseP3SingleChoice], ['p4', caseP4MultiChoice],
  ['p5', caseP5Tallies], ['p6', caseP6RankedWinner], ['p7', caseP7Preallocation], ['p8', caseP8Unvote],
  ['p9', caseP9ForeignDelete], ['p10', caseP10ReadSurfaces], ['p11', caseP11Permanence],
]);

await runBattery({
  label: 'pollr',
  contract: { env: 'POLLR_CONTRACT_ID' },
  cases: CASES,
  actors: { creator: 230, voter: 231, voter2: 232 },
  flags: { v3: process.env.POLLR_V3_CONTRACT_ID?.trim() || null },
  extraContracts: (args) => [args.v3],
  banner: ({ args }) => (args.v3 ? `; v3 baseline ${args.v3}` : ''),
  // p2c/p2d: a ballot can only ever name the poll's real creator.
  selfTest: () => selfTest('pollr-contract.json', { vote: { agreements: { pollId: { pollOwnerId: '$ownerId' } } }, multiVote: { agreements: { pollId: { pollOwnerId: '$ownerId' } } } }),
  setup: () => ({ expectedSingle: new Map(), expectedMulti: new Map() }),
  summary: (ctx) => `pollS=${ctx.pollS} pollM=${ctx.pollM} pollZ=${ctx.pollZ}`,
});
