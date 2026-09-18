/**
 * Registration-day battery for **Pollr contract v4**
 * (`contracts/pollr-contract-v4.json`, docs/POLLR_V4.md). Runs live against a
 * freshly registered contract on a beta.1+ devnet; there is no default contract
 * id (`--contract` or `POLLR_V4_CONTRACT_ID`).
 *
 * Actors are seed-ledger personas: a CREATOR (who owns the polls and pays for
 * the preallocated ballot trees) and two VOTERS. Ballots are free — v4 declares
 * no `tokenCost` — so no YAPP is needed.
 *
 * Ballots are indexOnly: they have no id-addressable row, so every acceptance
 * is decided by a VALUE query (`entryExists` below, the `pollId`+`choice`+
 * `$ownerId` probe that lowers onto `byPollChoice`), never by the SDK's
 * throw/no-throw — `documents.create()` can throw post-broadcast for an
 * indexOnly type whose write landed.
 *
 * Cases:
 *   p1  fixtures: a single-choice poll, a multi-choice poll, a never-voted
 *       control poll, and the documented gap that a poll whose `author` is not
 *       its `$ownerId` still lands (propertyAgreement cannot bind `$ownerId`)
 *   p2  references: a ballot on a ghost pollId is rejected (40120); a ballot
 *       carrying the wrong `pollOwnerId` is rejected (40127) — both doctypes
 *   p3  single-choice is STRUCTURAL: the first ballot lands, a second ballot by
 *       the same voter is rejected (40105) whether it repeats the choice or
 *       changes it, and other voters are unaffected
 *   p4  multi-choice: a second DIFFERENT choice by the same voter lands, the
 *       same (poll, voter, choice) twice is rejected (40105)
 *   p5  tallies: the grouped count on `byPollChoice` matches the ballots cast,
 *       per doctype; a never-voted poll has no groups
 *   p6  ranked winner: `groupBy choice, aggregate count, where pollId == P,
 *       limit 1` names the winning option; the full page carries exact counts
 *   p7  preallocation: creating a v4 poll costs measurably more than creating
 *       the same poll on the v3 clone — the creator pays for the ballot trees
 *       `vote.byPoll` / `vote.byPollOwner` up front (`--v3 <id>`, skipped when
 *       no v3 contract is given)
 *   p8  unvote: the delete tuple is recovered from a query alone (v4 keeps NO
 *       `$createdAt`, so the tuple is just the three properties), the
 *       delete-by-values lands, the count decrements, and the re-vote is
 *       accepted (structural uniqueness cleared)
 *   p9  deleting someone else's ballot is refused and the entry survives
 *   p10 read surfaces: "my votes" via `byVoterChoice`, the per-poll choice read
 *       via `byPollChoice` (`choice in [...]` + `$ownerId ==`), and "votes on
 *       my polls" via `byPollOwner`
 *   p11 permanence: the poll cannot be deleted (canBeDeleted:false)
 *
 * Run:
 *   NETWORK=devnet node scripts/verify-pollr-v4.mjs --contract <id> \
 *     [--creator 230] [--voter 231] [--voter2 232] [--v3 <v3 contract id>] [--only p3,p6]
 */
import { ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import {
  DELETE_FORBIDDEN,
  DUPLICATE_UNIQUE,
  PROPERTY_MISMATCH,
  REFERENCE_NOT_FOUND,
  FOREIGN_SIGNATURE,
  createBattery,
  id32,
  parseOnly,
  runCases,
} from './battery-lib.mjs';
import {
  buildDocument,
  createSdkHandle,
  describeErr,
  randomEntropy,
  socialContractId,
} from './seed/seed-lib.mjs';

/** Option labels the fixture polls carry, in order. */
const OPTIONS = ['alpha', 'bravo', 'charlie'];

/**
 * `isDuplicateVoteError` in lib/services/pollr-vote-service.ts, copied verbatim.
 * Keep the two in step: the client's whole duplicate/landed classification
 * hangs off this predicate matching what consensus actually says.
 */
const CLIENT_DUPLICATE_PREDICATE = /duplicate unique properties|\b40105\b/i;

/**
 * Floor for the extra credits a v4 poll create pays over a v3 one (p7). Well
 * above what v4's extra 32-byte `author` property could account for on its own,
 * so the check cannot pass on payload size alone; measured delta is ~18M.
 */
const PREALLOCATION_FLOOR = 5_000_000n;

// ---- Document shapes --------------------------------------------------------

const pollData = ({ run, label, author, multiChoice }) => ({
  question: `${label} ${run}?`,
  ...Object.fromEntries(OPTIONS.map((option, index) => [`option${index}`, option])),
  ...(multiChoice ? { multiChoice: true } : {}),
  author,
});

const ballotData = ({ pollId, pollOwnerId, choice }) => ({ pollId, pollOwnerId, choice });

/**
 * Integer group keys come back in two forms, and both are live here:
 * `documents.count({groupBy})` keys by the HEX of the platform-encoded byte
 * (0x80 + value, same as storefront v2's rating distribution), while
 * `documents.ranked` hands back the decoded number. Anything else stays `null`
 * so a mismatch fails a check instead of reading as choice 0.
 */
function decodeChoiceKey(key) {
  if (typeof key === 'number') return key;
  if (typeof key === 'bigint') return Number(key);
  if (typeof key !== 'string' || !/^[0-9a-f]+$/i.test(key)) return null;
  return parseInt(key, 16) - 0x80;
}

/** Every valid choice index for the fixture polls — the `in` clause's value set. */
const ALL_CHOICES = OPTIONS.map((_, index) => index);

/**
 * An `in` (or range) clause on an indexOnly prefix property REQUIRES an explicit
 * orderBy on that property; without it the router refuses the query
 * ("missing order by for range error"). Equality-only reads need none.
 */
const CHOICE_IN = [['choice', 'in', ALL_CHOICES]];
const CHOICE_ORDER = [['choice', 'asc']];

// ---- Cases ------------------------------------------------------------------

/** The indexOnly acceptance probe: does this voter's entry for (poll, choice) exist? */
async function entryExists(ctx, docType, pollId, who, choice) {
  const entries = await ctx.battery.queryDocs(docType, {
    where: [
      ['pollId', '==', pollId],
      ['choice', '==', choice],
      ['$ownerId', '==', who.ownerId],
    ],
  });
  return entries.length > 0;
}

/** Casts a ballot, deciding acceptance by readback on `byPollChoice`. */
function castBallot(ctx, docType, who, pollId, choice, { pollOwnerId, accepted } = {}) {
  return ctx.battery.attemptCreate(
    who,
    docType,
    ballotData({
      pollId: id32(pollId),
      pollOwnerId: id32(pollOwnerId ?? ctx.creator.ownerId),
      choice,
    }),
    { accepted: accepted ?? (() => entryExists(ctx, docType, pollId, who, choice)) }
  );
}

/**
 * Re-casts a ballot the voter has ALREADY cast verbatim. Entry-existence cannot
 * decide this one — the first ballot's entry is already there — so acceptance
 * means "a SECOND entry appeared", i.e. the (poll, choice) entry count grew.
 * Under structural uniqueness it never can, so this reads the rejection
 * instead. Sound only because the battery is the sole writer of these fixture
 * polls: a concurrent voter on the same option would look like acceptance.
 */
async function recastIdenticalBallot(ctx, docType, who, pollId, choice) {
  const entries = async () => {
    const docs = await ctx.battery.queryDocs(docType, {
      where: [['pollId', '==', pollId], ['choice', '==', choice]],
    });
    return docs.length;
  };
  const before = await entries();
  return castBallot(ctx, docType, who, pollId, choice, { accepted: async () => (await entries()) > before });
}

async function caseP1Fixtures(ctx) {
  const { battery, creator, voter } = ctx;
  console.log('\n--- p1. fixtures: single-choice, multi-choice and never-voted polls ---');
  const author = id32(creator.ownerId);
  for (const [key, label, multiChoice] of [
    ['pollS', 'Single', false],
    ['pollM', 'Multi', true],
    ['pollZ', 'Untouched', false],
  ]) {
    const created = battery.expectAccepted(
      `p1 ${key} created (author == $ownerId)`,
      await battery.attemptCreate(creator, 'poll', pollData({ run: ctx.run, label, author, multiChoice }))
    );
    ctx[key] = created.ok ? created.id : null;
  }
  if (!ctx.pollS || !ctx.pollM || !ctx.pollZ) throw new Error('fixture polls unavailable');

  // Documented gap: propertyAgreement binds user properties, never $ownerId, so
  // a poll can name someone else as its author. It lands; the app rejects it by
  // comparing author with $ownerId, exactly like storefront v2's buyerId.
  const spoofed = await battery.attemptCreate(
    voter,
    'poll',
    pollData({ run: ctx.run, label: 'Spoofed', author, multiChoice: false })
  );
  battery.check(
    'p1d a poll whose author != $ownerId LANDS (documented gap: agreement cannot bind $ownerId)',
    spoofed.ok,
    spoofed.ok ? `id=${spoofed.id} — the client must check author == $ownerId` : `rejected: ${(spoofed.error ?? '').slice(0, 160)}`
  );
  ctx.pollSpoofed = spoofed.ok ? spoofed.id : null;
}

async function caseP2References(ctx) {
  const { battery, voter, voter2 } = ctx;
  console.log('\n--- p2. refersTo: ghost polls (40120) and forged pollOwnerId (40127) ---');
  const ghost = bs58.encode(randomEntropy());

  // Both probes target a (poll, voter, choice) the signer has NOT already used:
  // the structural-duplicate probe fires before the reference checks.
  battery.expectRejected(
    'p2a vote on a nonexistent poll is rejected (40120)',
    await castBallot(ctx, 'vote', voter, ghost, 0),
    REFERENCE_NOT_FOUND
  );
  battery.expectRejected(
    'p2b multiVote on a nonexistent poll is rejected (40120)',
    await castBallot(ctx, 'multiVote', voter, ghost, 0),
    REFERENCE_NOT_FOUND
  );
  battery.expectRejected(
    'p2c vote carrying the WRONG pollOwnerId is rejected (40127)',
    await castBallot(ctx, 'vote', voter2, ctx.pollS, 2, { pollOwnerId: voter2.ownerId }),
    PROPERTY_MISMATCH
  );
  battery.expectRejected(
    'p2d multiVote carrying the WRONG pollOwnerId is rejected (40127)',
    await castBallot(ctx, 'multiVote', voter2, ctx.pollM, 2, { pollOwnerId: voter2.ownerId }),
    PROPERTY_MISMATCH
  );
}

async function caseP3SingleChoice(ctx) {
  const { battery, creator, voter, voter2 } = ctx;
  console.log('\n--- p3. single choice is structural: one entry per (poll, voter) ---');
  battery.expectAccepted('p3a voter ballot for choice 0 accepted', await castBallot(ctx, 'vote', voter, ctx.pollS, 0));
  const changed = battery.expectRejected(
    'p3b the SAME voter changing to choice 1 is rejected (40105 — byPoll admits one entry per voter)',
    await castBallot(ctx, 'vote', voter, ctx.pollS, 1),
    DUPLICATE_UNIQUE
  );
  // The client routes this rejection by TEXT, and everything downstream depends
  // on it: a duplicate that reads as an ordinary error is handed to the landed
  // probe, which finds the voter's earlier entry and calls the rejected write a
  // cast ballot. Pin the wording the structural rule actually produces.
  battery.check(
    "p3b' the rejection matches pollrVoteService.isDuplicateVoteError's predicate verbatim",
    CLIENT_DUPLICATE_PREDICATE.test(changed.error ?? ''),
    (changed.error ?? '').slice(0, 160)
  );
  battery.expectRejected(
    'p3c the same voter repeating choice 0 verbatim is rejected (40105)',
    await recastIdenticalBallot(ctx, 'vote', voter, ctx.pollS, 0),
    DUPLICATE_UNIQUE
  );
  battery.expectAccepted('p3d a SECOND voter is unaffected (choice 1)', await castBallot(ctx, 'vote', voter2, ctx.pollS, 1));
  battery.expectAccepted('p3e the creator may vote on their own poll (choice 1)', await castBallot(ctx, 'vote', creator, ctx.pollS, 1));
  // Expected single-choice tally: {0: voter, 1: voter2 + creator}.
  ctx.expectedSingle = new Map([[0, 1], [1, 2]]);
}

async function caseP4MultiChoice(ctx) {
  const { battery, voter, voter2 } = ctx;
  console.log('\n--- p4. multi choice: one entry per (poll, voter, choice) ---');
  battery.expectAccepted('p4a voter selects choice 0', await castBallot(ctx, 'multiVote', voter, ctx.pollM, 0));
  battery.expectAccepted('p4b the SAME voter adds choice 2 (accepted — the entry differs)', await castBallot(ctx, 'multiVote', voter, ctx.pollM, 2));
  battery.expectRejected(
    'p4c repeating choice 0 is rejected (40105)',
    await recastIdenticalBallot(ctx, 'multiVote', voter, ctx.pollM, 0),
    DUPLICATE_UNIQUE
  );
  battery.expectAccepted('p4d a second voter selects choice 2', await castBallot(ctx, 'multiVote', voter2, ctx.pollM, 2));
  // Expected multi tally: {0: voter, 2: voter + voter2}.
  ctx.expectedMulti = new Map([[0, 1], [2, 2]]);
}

async function tallyOf(ctx, docType, pollId) {
  return ctx.battery.groupedCount(docType, [['pollId', '==', pollId], ...CHOICE_IN], ['choice'], decodeChoiceKey);
}

const sumOf = (tally) => [...tally.values()].reduce((total, count) => total + count, 0);

const sameTally = (got, want) =>
  got.size === want.size && [...want].every(([choice, count]) => got.get(choice) === count);

const showTally = (tally) => JSON.stringify(Object.fromEntries([...tally].sort(([a], [b]) => a - b)));

async function caseP5Tallies(ctx) {
  const { battery } = ctx;
  console.log('\n--- p5. per-choice tallies off the count tree ---');
  const single = await tallyOf(ctx, 'vote', ctx.pollS);
  battery.check('p5a single-choice grouped count matches the ballots cast', sameTally(single, ctx.expectedSingle),
    `got=${showTally(single)} want=${showTally(ctx.expectedSingle)}`);

  const multi = await tallyOf(ctx, 'multiVote', ctx.pollM);
  battery.check('p5b multi-choice grouped count matches the selections cast', sameTally(multi, ctx.expectedMulti),
    `got=${showTally(multi)} want=${showTally(ctx.expectedMulti)}`);

  const singleTotal = sumOf(single);
  battery.check('p5c the single-choice grouped total is the VOTER count (one ballot each)',
    singleTotal === 3, `total=${singleTotal}`);

  const untouched = await tallyOf(ctx, 'vote', ctx.pollZ);
  battery.check('p5d a never-voted poll has no groups (count trees do not materialise empty branches)',
    untouched.size === 0, `got=${showTally(untouched)}`);

  // A count keyed on `pollId` ALONE is a prefix count, and `rangeCountable`
  // alone does not provide one: the boolean `rankedCountable` puts the count
  // tree at the `choice` level only, so the `pollId` level is a plain grouping
  // tree. (Social v5 gets prefix counts from the `rankedCountable: {at}` form,
  // which `vote` cannot use — `byPoll` terminates at exactly that level and the
  // prefix-exclusivity rule refuses it.) Both doctypes refuse it; the client
  // sums the grouped tally, which it needs for the bars anyway.
  for (const [label, docType, pollId] of [['p5e `vote`', 'vote', ctx.pollS], ['p5f multiVote', 'multiVote', ctx.pollM]]) {
    let outcome = 'accepted';
    try {
      await battery.countBy(docType, [['pollId', '==', pollId]]);
    } catch (e) {
      outcome = describeErr(e);
    }
    battery.check(`${label} refuses a bare prefix count on pollId (the count tree lives at the choice level)`,
      /countable/i.test(outcome), outcome.slice(0, 150));
  }
}

async function caseP6RankedWinner(ctx) {
  const { battery } = ctx;
  console.log('\n--- p6. ranked winner: groupBy choice with the poll pinned ---');
  const winner = await battery.ranked('vote', 'choice', { type: 'count' }, { where: [['pollId', '==', ctx.pollS]], limit: 1 });
  const top = winner.page.entries?.[0];
  const topChoice = decodeChoiceKey(top?.groupValue);
  battery.check('p6a the ranked top-1 group is the winning option (choice 1, two ballots)',
    topChoice === 1 && Number(top?.value) === 2,
    `groupValue=${JSON.stringify(top?.groupValue)} decoded=${topChoice} value=${top?.value}`);
  // decodeChoiceKey accepts both forms, so p6a alone cannot tell them apart —
  // but pollrVoteService.getWinner does a bare Number(), and docs/POLLR_V4.md
  // states ranked group values arrive decoded. Pin the form.
  battery.check('p6a\' ranked integer group values arrive DECODED, not as the 0x80-offset hex grouped counts use',
    typeof top?.groupValue === 'number', `typeof groupValue=${typeof top?.groupValue}`);
  battery.workingShapes.push({
    label: 'poll winner (ranked, byPollChoice terminal level)',
    shape: { documentTypeName: 'vote', groupBy: 'choice', aggregate: { type: 'count' }, where: [['pollId', '==', '<pollId>']], limit: 1 },
  });

  const full = await battery.ranked('vote', 'choice', { type: 'count' }, { where: [['pollId', '==', ctx.pollS]] });
  const page = new Map((full.page.entries ?? []).map((entry) => [decodeChoiceKey(entry.groupValue), Number(entry.value)]));
  battery.check('p6b the full ranked page carries every voted option with exact counts',
    // `every` over an empty expectation is vacuously true — require p3 to have run.
    ctx.expectedSingle.size > 0 && [...ctx.expectedSingle].every(([choice, count]) => page.get(choice) === count),
    `page=${showTally(page)} want=${showTally(ctx.expectedSingle)}`);

  const multi = await battery.ranked('multiVote', 'choice', { type: 'count' }, { where: [['pollId', '==', ctx.pollM]], limit: 1 });
  const multiTop = multi.page.entries?.[0];
  battery.check('p6c the multi-choice ranked top-1 group is choice 2 (two selections)',
    decodeChoiceKey(multiTop?.groupValue) === 2 && Number(multiTop?.value) === 2,
    `groupValue=${JSON.stringify(multiTop?.groupValue)} value=${multiTop?.value}`);
}

async function caseP7Preallocation(ctx) {
  const { battery, creator } = ctx;
  console.log('\n--- p7. preallocation: the poll creator pays for the ballot trees ---');
  if (!ctx.v3ContractId) {
    battery.check('p7 preallocation cost comparison', true, 'skipped — pass --v3 <v3 contract id> to measure');
    return;
  }
  const author = id32(creator.ownerId);
  const costOf = async (contract, label) => {
    const before = await battery.balanceOf(creator.ownerId);
    const created = await battery.attemptCreate(
      creator,
      'poll',
      // The v3 schema has no `author`; sending it there would fail additionalProperties.
      contract === ctx.v3ContractId
        ? { question: `Cost ${label} ${ctx.run}?`, option0: OPTIONS[0], option1: OPTIONS[1] }
        : { question: `Cost ${label} ${ctx.run}?`, option0: OPTIONS[0], option1: OPTIONS[1], author },
      { contract }
    );
    if (!created.ok) throw new Error(`${label} poll create failed: ${(created.error ?? '').slice(0, 160)}`);
    const after = await battery.balanceOf(creator.ownerId);
    return before - after;
  };
  const v3Cost = await costOf(ctx.v3ContractId, 'v3');
  const v4Cost = await costOf(ctx.contractId, 'v4');
  battery.check(
    `p7a a v4 poll create costs at least ${PREALLOCATION_FLOOR} credits more than the same v3 poll — the preallocated vote.byPoll / vote.byPollOwner trees are billed to the creator, far beyond v4's extra 32-byte author field`,
    v4Cost - v3Cost >= PREALLOCATION_FLOOR,
    `v3=${v3Cost} credits, v4=${v4Cost} credits, delta=${v4Cost - v3Cost}`
  );
}

async function caseP8Unvote(ctx) {
  const { battery, voter } = ctx;
  console.log('\n--- p8. unvote: query-recovered tuple, delete-by-values, re-vote ---');
  // NOTHING from the create call is reused: the create-returned Document is
  // unreliable for indexOnly types. An indexOnly projection only carries what
  // ITS OWN index path holds, so `byPollChoice` yields pollId + choice and
  // NOT pollOwnerId — that one comes off the referenced poll's `author`, the
  // same place the write took it from (social v6 recovers hashtag/postAuthor
  // off the post the same way). With no `$createdAt` in v4 there is nothing
  // else to recover.
  const mine = await battery.queryDocs('vote', {
    where: [['pollId', '==', ctx.pollS], ...CHOICE_IN, ['$ownerId', '==', voter.ownerId]],
    orderBy: CHOICE_ORDER,
  });
  const choice = mine[0] === undefined ? null : Number(mine[0].choice);
  const poll = await battery.fetchDocument('poll', ctx.pollS);
  const pollOwner = poll?.toObject()?.author ? battery.b58(poll.toObject().author) : null;
  battery.check('p8a the delete tuple recovers: choice from the byPollChoice projection, pollOwnerId from the poll',
    choice === 0 && pollOwner === ctx.creator.ownerId,
    `choice=${choice} pollOwnerId=${pollOwner} entries=${mine.length} (projection keys: ${Object.keys(mine[0] ?? {}).join(',')})`);
  if (choice === null || pollOwner === null) return;

  const before = await tallyOf(ctx, 'vote', ctx.pollS);
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'vote',
    ownerId: voter.ownerId,
    data: ballotData({ pollId: id32(ctx.pollS), pollOwnerId: id32(pollOwner), choice }),
    entropy: randomEntropy(),
  });
  const deleted = await battery.attemptDeleteByValues(voter, document,
    async () => !(await entryExists(ctx, 'vote', ctx.pollS, voter, choice)));
  battery.expectAccepted('p8b delete-by-values with the query-recovered tuple is accepted (no $createdAt needed)', deleted);
  if (!deleted.ok) return;

  const after = await tallyOf(ctx, 'vote', ctx.pollS);
  battery.check('p8c the count tree decrements after the unvote',
    (before.get(choice) ?? 0) - (after.get(choice) ?? 0) === 1,
    `before=${showTally(before)} after=${showTally(after)}`);

  battery.expectAccepted('p8d re-voting after the unvote is accepted (structural uniqueness cleared)',
    await castBallot(ctx, 'vote', voter, ctx.pollS, choice));
}

async function caseP9ForeignDelete(ctx) {
  const { battery, voter, voter2 } = ctx;
  console.log("\n--- p9. deleting someone ELSE'S ballot is refused ---");
  // voter2's entry on pollS is choice 1 (p3d); voter signs a delete carrying it.
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'vote',
    ownerId: voter2.ownerId,
    data: ballotData({ pollId: id32(ctx.pollS), pollOwnerId: id32(ctx.creator.ownerId), choice: 1 }),
    entropy: randomEntropy(),
  });
  battery.expectRejected(
    "p9a deleting the other voter's ballot with our own signature is rejected",
    await battery.attemptDeleteByValues(voter, document,
      async () => !(await entryExists(ctx, 'vote', ctx.pollS, voter2, 1))),
    FOREIGN_SIGNATURE
  );
  battery.check('p9b the victim entry survives the attack', await entryExists(ctx, 'vote', ctx.pollS, voter2, 1));
}

async function caseP10ReadSurfaces(ctx) {
  const { battery, voter, creator } = ctx;
  console.log('\n--- p10. read surfaces: my votes, my choices on a poll, votes on my polls ---');

  const myVotes = await battery.queryDocs('vote', { where: [['$ownerId', '==', voter.ownerId]] });
  const votedPolls = myVotes.map((doc) => battery.b58(doc.pollId));
  battery.check('p10a byVoterChoice lists my single-choice ballots (poll id + choice)',
    votedPolls.includes(ctx.pollS), `polls=${votedPolls.length}`);
  battery.workingShapes.push({
    label: 'my votes (byVoterChoice)',
    shape: { documentTypeName: 'vote', where: [['$ownerId', '==', '<me>']] },
  });

  const myMulti = await battery.queryDocs('multiVote', { where: [['$ownerId', '==', voter.ownerId]] });
  const myMultiChoices = myMulti
    .filter((doc) => battery.b58(doc.pollId) === ctx.pollM)
    .map((doc) => Number(doc.choice))
    .sort((a, b) => a - b);
  battery.check('p10b byVoterChoice lists every multi-choice selection I cast', myMultiChoices.join(',') === '0,2',
    `choices=[${myMultiChoices.join(',')}]`);

  const onPoll = await battery.queryDocs('multiVote', {
    where: [['pollId', '==', ctx.pollM], ...CHOICE_IN, ['$ownerId', '==', voter.ownerId]],
    orderBy: CHOICE_ORDER,
  });
  const onPollChoices = onPoll.map((doc) => Number(doc.choice)).sort((a, b) => a - b);
  battery.check('p10c the per-poll choice read (pollId ==, choice in [...], $ownerId ==) returns exactly my selections',
    onPollChoices.join(',') === '0,2', `choices=[${onPollChoices.join(',')}]`);
  battery.workingShapes.push({
    label: 'my choices on one poll (byPollChoice)',
    shape: { documentTypeName: 'multiVote', where: [['pollId', '==', '<pollId>'], ['choice', 'in', [0, 1, 2]], ['$ownerId', '==', '<me>']], orderBy: [['choice', 'asc']] },
  });

  // Pinned to THIS run's poll: the creator persona is reused, so a bare
  // `length >= 3` would be satisfied by ballots from earlier runs even if this
  // run's byPollOwner entries never landed.
  const onMyPolls = await battery.queryDocs('vote', { where: [['pollOwnerId', '==', creator.ownerId]] });
  const onThisPoll = onMyPolls.filter((doc) => battery.b58(doc.pollId) === ctx.pollS);
  battery.check('p10d byPollOwner answers "votes on my polls", including every ballot on this run\'s poll',
    onThisPoll.length === 3, `thisPoll=${onThisPoll.length} allTime=${onMyPolls.length}`);
}

async function caseP11Permanence(ctx) {
  const { battery, creator } = ctx;
  console.log('\n--- p11. the poll is permanent (a ballot can always resolve its reference) ---');
  battery.expectRejected('p11a deleting a poll is rejected (canBeDeleted:false)',
    await battery.attemptDelete(creator, 'poll', ctx.pollZ), DELETE_FORBIDDEN);
}

const CASES = new Map([
  ['p1', caseP1Fixtures], ['p2', caseP2References], ['p3', caseP3SingleChoice], ['p4', caseP4MultiChoice],
  ['p5', caseP5Tallies], ['p6', caseP6RankedWinner], ['p7', caseP7Preallocation], ['p8', caseP8Unvote],
  ['p9', caseP9ForeignDelete], ['p10', caseP10ReadSurfaces], ['p11', caseP11Permanence],
]);

function parseArgs(argv) {
  const args = {
    contract: process.env.POLLR_V4_CONTRACT_ID?.trim() || null,
    v3: process.env.POLLR_V3_CONTRACT_ID?.trim() || null,
    creator: 230, voter: 231, voter2: 232, only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--v3': args.v3 = argv[++i]; break;
      case '--creator': args.creator = Number(argv[++i]); break;
      case '--voter': args.voter = Number(argv[++i]); break;
      case '--voter2': args.voter2 = Number(argv[++i]); break;
      case '--only': args.only = parseOnly(argv[++i], CASES); break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contract) throw new Error('Pass --contract <id> or set POLLR_V4_CONTRACT_ID');
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  await ensureInitialized();
  const socialId = socialContractId();
  const handle = createSdkHandle({ contractIds: [socialId, args.contract, ...(args.v3 ? [args.v3] : [])] });
  const { protocolVersion } = await handle.connect();
  const battery = createBattery({ handle, contractId: args.contract, socialId });
  battery.balanceOf = async (ownerId) => {
    const balances = await battery.readback(() => battery.sdk.identities.balances([ownerId]));
    return (balances instanceof Map ? balances.get(ownerId) : undefined) ?? 0n;
  };
  console.log(`connected (PV${protocolVersion}); pollr v4 ${args.contract}${args.v3 ? `; v3 baseline ${args.v3}` : ''}`);
  const [creator, voter, voter2] = await Promise.all(
    [args.creator, args.voter, args.voter2].map((idx) => battery.personaActor(idx))
  );
  console.log(`creator=${creator.label} voter=${voter.label} voter2=${voter2.label}`);
  const ctx = {
    battery, contractId: args.contract, v3ContractId: args.v3, socialId,
    creator, voter, voter2, run: Date.now().toString(36),
    expectedSingle: new Map(), expectedMulti: new Map(),
  };
  await runCases(battery, CASES, args.only, ctx);
  const failures = battery.report(`pollS=${ctx.pollS} pollM=${ctx.pollM} pollZ=${ctx.pollZ}`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
