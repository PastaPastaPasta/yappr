/**
 * Pollr v5: per bank entry a `poll` (credits only; options[], optionCount, multiChoice always written, and a required
 * endsAt within 31 days of creation), an embedding `post` on the SOCIAL contract (10 YAPP, the
 * `embedContractId`/`embedDocType`/`embedId` triple lib/poll-embed.ts builds), and the ballots. Every ballot is a
 * stored, mutable `vote` copying the poll's optionCount / multiChoice / endsAt (the pollId reference refuses a
 * mismatch, 40127): a single-choice voter writes one ballot in slot 0, a multi-choice voter one per ticked option with
 * slot = choice. A few single-choice voters change their mind or withdraw, which is a REPLACE of the one ballot.
 *
 * A v5 poll cannot be created closed and nothing is written to it after its close (`writtenBeforeClose`), so the
 * "closed" bank entries are written LAST with a short window (`--close-in`, ms) and their ballots straight after: they
 * close a few minutes after the run, and later votes are refused.
 */
import bs58 from 'bs58';
import { decodeIntGroupKey, reportSelfTest } from '../../battery-lib.mjs';
import { PREFER_CONTRACT_OWNER, TOKEN_COST, asBase58, describeErr, feeAgreementFor, paymentInfo, readback, requireSeededTopology } from '../seed-lib.mjs';
import {
  actorsFor, bar, counts, createDocWriter, createRecorder, ensureTokens, entropySource, envValue, loadCheckpoint,
  network, phaseRunner, printTable, randInt, rngFrom, shuffled, socialPost, sum,
} from '../feature-seed-lib.mjs';

const DAY_MS = 86_400_000;
/** v5's endsWithin31Days. */
const MAX_POLL_MS = 31 * DAY_MS;
/** How long a bank entry with no `endsAt` stays open, in days from the run's UTC midnight. */
const DEFAULT_OPEN_DAYS = 30;
/** A ballot write this close to the poll's close is not attempted: it would land after it and be refused. */
const CLOSE_MARGIN_MS = 20_000;
/** Every persona that takes part, in ledger order; creators are drawn from the same set. */
const PERSONAS = [230, 231, 232, 300, 301, 302, 303, 304, 305, 306, 307];

// Hand-written questions (a PRNG cannot write a funny poll), hand-assigned
// creators, and a `pattern` telling the vote generator what the result should
// look like. `endsAt` is whole days from the run's UTC midnight (default
// DEFAULT_OPEN_DAYS); `closesSoon` polls close `--close-in` after they are written.
const POLL_BANK = [
  { key: 'editor', creator: 301, pattern: 'landslide', hashtag: 'devtools',
    question: 'Which editor are you actually using day to day in 2026? Not the one in your bio — the one that is open right now.',
    options: ['Neovim', 'VS Code', 'Zed', 'A JetBrains IDE', 'Helix'],
    caption: 'settling this the only honest way. the one thats open RIGHT NOW, not the one in your bio #devtools' },
  { key: 'ci-wait', creator: 306, pattern: 'close', hashtag: 'ci',
    question: 'How long can CI take before you context-switch and lose the afternoon?',
    options: ['Under 2 minutes', '2 to 5 minutes', '5 to 15 minutes', 'I have made peace with 40'],
    caption: 'our pipeline is at 17 minutes and i am no longer a functioning engineer #ci' },
  { key: 'flaky', creator: 230, pattern: 'landslide', closesSoon: true, hashtag: 'testing',
    question: 'A test fails once in every twenty runs. What actually happens to it on your team?',
    options: ['Someone fixes it properly', 'Retry twice, move on', 'Deleted, no notes', 'Quarantined forever'],
    caption: 'closed now but the results made me sad. be honest with yourselves out there #testing' },
  { key: 'noodles', creator: 302, pattern: 'close', hashtag: 'food',
    question: 'Desert island noodle. You get exactly one for the rest of your life. Choose carefully.',
    options: ['Ramen', 'Pho', 'Hand-pulled lamian', 'Pad thai', 'Laksa', 'Plain spaghetti'],
    caption: 'the hardest question I have ever asked anyone. no sauces, no sides, just the noodle #food' },
  { key: 'pineapple', creator: 302, pattern: 'landslide', closesSoon: true, hashtag: 'pizza',
    question: 'Pineapple on pizza: final answer?',
    options: ['Yes, obviously', 'Absolutely not', 'Only with chilli and good ham'],
    caption: 'poll closed. the people have spoken and I am afraid I agree with them #pizza' },
  { key: 'breakfast', creator: 307, pattern: 'split', hashtag: 'running',
    question: 'What is actually in you before a long run? Not what the magazine says. What you actually eat.',
    options: ['Nothing, just coffee', 'Toast and honey', 'Oats', 'Eggs and bacon, somehow', 'A gel and regret'],
    caption: '5am. 32km. the fuelling discourse never ends, so lets take a census #running' },
  { key: 'dash-use', creator: 303, pattern: 'split', hashtag: 'dash',
    question: 'What do you mainly use Dash for right now, in this actual month?',
    options: ['Everyday payments', 'Savings', 'Running a masternode', 'Building on Platform', 'Watching the charts'],
    caption: 'genuinely curious how this splits in 2026. no wrong answer, including the last one #dash' },
  { key: 'dash-feature', creator: 303, pattern: 'multi', multiChoice: true, endsAt: 21, hashtag: 'platform',
    question: 'Which Dash Platform features are you most excited to build on? Pick as many as you mean.',
    options: ['Token contracts', 'Groups', 'Encrypted documents', 'Ranked indexes', 'DPNS names', 'Withdrawals'],
    caption: 'multi-select, because nobody building on this stack has only one favourite #platform' },
  { key: 'yappr-next', creator: 232, pattern: 'close', hashtag: 'yappr',
    question: 'What should Yappr ship next?',
    options: ['Proper search', 'Lists', 'Scheduled posts', 'Better DMs', 'Nothing, fix the bugs'],
    caption: 'asking the timeline instead of the roadmap for once #yappr' },
  { key: 'poll-length', creator: 300, pattern: 'zero', hashtag: 'research',
    question: 'Methodology question: how long should a poll stay open by default before the result stops meaning anything?',
    options: ['1 hour', '1 day', '3 days', '1 week'],
    caption: 'posted this at 3am my time and I fear it shows. methodology nerds, where are you #research' },
  { key: 'survey-sins', creator: 300, pattern: 'multi', multiChoice: true, closesSoon: true, hashtag: 'research',
    question: 'Which survey sins annoy you most? They never come alone, so pick all that apply.',
    options: ['Leading questions', 'No "none of the above"', 'Mandatory 5-star scale', 'Ten pages, no progress bar'],
    caption: 'results are in and honestly you are all correct about every single one of these #research' },
  { key: 'football', creator: 304, pattern: 'close', hashtag: 'football',
    question: 'One world-class striker, nothing else in the squad. Which shape do you actually pick?',
    options: ['4-4-2', '4-3-3', '3-5-2', '5-4-1 and pray'],
    caption: 'the eternal argument, now with a sample size. show your working in the replies #football' },
  { key: 'homelab', creator: 305, pattern: 'multi', multiChoice: true, hashtag: 'homelab',
    question: 'Be honest about what the homelab is FOR. Pick everything that is true.',
    options: ['Media server', 'Backups', 'Learning kubernetes', 'One DNS blocker', 'Heating the garage'],
    caption: '42U of regret in the garage and I want to know I am not alone in this #homelab' },
  { key: 'coffee', creator: 231, pattern: 'split', endsAt: 5, hashtag: 'coffee',
    question: 'Which coffee method has genuinely earned its counter space?',
    options: ['Aeropress', 'V60', 'Moka pot', 'Espresso machine', 'French press', 'Instant, honestly'],
    caption: 'counter space is finite and I am doing an audit this weekend #coffee' },
];

/** Per-option weights for a result shape; the leading option is drawn, not fixed at 0. */
function weightsFor(rng, pattern, optionCount) {
  const weights = new Array(optionCount).fill(1);
  const order = shuffled(rng, weights.map((_, index) => index));
  if (pattern === 'landslide') { weights[order[0]] = randInt(rng, 16, 22); weights[order[1]] = randInt(rng, 2, 4); }
  else if (pattern === 'close') { weights[order[0]] = randInt(rng, 10, 12); weights[order[1]] = randInt(rng, 8, 9); }
  else if (pattern === 'split' || pattern === 'multi') for (let i = 0; i < optionCount; i++) weights[i] = randInt(rng, 2, 12);
  else throw new Error(`unknown vote pattern ${pattern}`);
  return weights;
}

/**
 * Largest-remainder apportionment. Single-choice tallies are apportioned rather than sampled: at a turnout of ten,
 * independent draws off a "two front-runners" weighting land on 6-1-1-2 as often as 4-4-1-1, and a poll labelled
 * `close` that renders as a blowout defeats the point of seeding a varied feed.
 */
function apportion(weights, total) {
  const totalWeight = sum(weights);
  if (totalWeight <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (weight / totalWeight) * total);
  const counted = exact.map(Math.floor);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  // Compute the shortfall ONCE: it shrinks as the loop assigns, which would end
  // the loop early and silently drop ballots.
  const remaining = total - sum(counted);
  for (let i = 0; i < remaining; i++) counted[order[i].index] += 1;
  return counted;
}

/** Index sampled from `weights` proportionally; -1 only when every weight is 0. */
function weightedIndex(rng, weights) {
  const total = sum(weights);
  if (total <= 0) return -1;
  let threshold = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    threshold -= weights[i];
    if (threshold <= 0) return i;
  }
  return weights.length - 1;
}

function buildPlan({ seed, nowMs }) {
  const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return POLL_BANK.map((entry) => {
    // One PRNG substream per poll, so editing the bank never reshuffles the others.
    const rng = rngFrom(`${seed}|${entry.key}`);
    const optionCount = entry.options.length;
    const unvoted = entry.pattern === 'zero';
    const weights = unvoted ? new Array(optionCount).fill(0) : weightsFor(rng, entry.pattern, optionCount);
    const shuffledPersonas = shuffled(rng, PERSONAS);
    const voters = shuffledPersonas.slice(0, unvoted ? 0 : randInt(rng, 6, PERSONAS.length));
    // A ballot is { voter, slot, initial, choice }: `initial` is what the create writes, `choice` where a later
    // replace leaves it (undefined = withdrawn). Only the closing polls skip the replaces: their window is short.
    const ballots = [];
    if (entry.multiChoice) {
      // One ballot per (poll, voter, option), slot = choice: 2-3 DISTINCT options
      // each, sampled without replacement so no ballot is a 40105 duplicate of its sibling.
      for (const voter of voters) {
        const remaining = [...weights];
        for (let i = 0; i < Math.min(randInt(rng, 2, 3), optionCount); i++) {
          const choice = weightedIndex(rng, remaining);
          if (choice < 0) break;
          remaining[choice] = 0;
          ballots.push({ voter, slot: choice, initial: choice, choice });
        }
      }
    } else {
      // Exactly one ballot per voter (slot 0; byPollVoter is unique on it), so the
      // final shape is decided first and voters dealt in. Some voters first pick
      // another option and change their mind by replace.
      const deck = shuffled(rng, apportion(weights, voters.length).flatMap((count, choice) => new Array(count).fill(choice)));
      for (const [index, voter] of voters.entries()) {
        const choice = deck[index];
        const changes = !entry.closesSoon && rng() < 0.25;
        ballots.push({ voter, slot: 0, initial: changes ? (choice + randInt(rng, 1, optionCount - 1)) % optionCount : choice, choice });
      }
      // And one persona who is not counted votes and then withdraws, which the tally must not see.
      const bystander = shuffledPersonas[voters.length];
      if (!unvoted && !entry.closesSoon && bystander !== undefined && rng() < 0.5) {
        ballots.push({ voter: bystander, slot: 0, initial: randInt(rng, 0, optionCount - 1), choice: undefined });
      }
    }
    ballots.sort((a, b) => a.voter - b.voter || a.slot - b.slot);
    const expected = new Array(optionCount).fill(0);
    for (const ballot of ballots) if (ballot.choice !== undefined) expected[ballot.choice] += 1;
    return {
      ...entry,
      multiChoice: Boolean(entry.multiChoice),
      closesSoon: Boolean(entry.closesSoon),
      // A closing poll's endsAt is taken when it is written (`--close-in` from then).
      endsAtMs: entry.closesSoon ? undefined : midnight + (entry.endsAt ?? DEFAULT_OPEN_DAYS) * DAY_MS,
      voters, ballots, expected,
    };
  });
}

const fieldsOf = (document) => (typeof document?.toObject === 'function' ? document.toObject() : document);

async function run({ args, handle, battery, socialId, contractId }) {
  const plan = buildPlan({ seed: args.seed, nowMs: args.nowMs });
  // The caption post lives on the SOCIAL contract, so it owes that contract's
  // action fee (40132 without) and may ask it to pay the gas. A poll and its
  // ballots are pollr's own doctypes: unpriced, unagreed, unchanged.
  requireSeededTopology();
  const writer = createDocWriter({
    handle,
    contractId,
    entropyFor: entropySource(`yappr/pollr-seed/${args.seed}/${contractId}`),
    paymentInfo: (tokenCost) => paymentInfo(tokenCost, { gasFeesPaidBy: PREFER_CONTRACT_OWNER }),
    agreementFor: (docType, contract) => (contract === socialId ? feeAgreementFor(handle.sdk, docType) : undefined),
  });
  const actors = await actorsFor(battery, PERSONAS);
  console.log(`actors: ${[...actors.values()].map((a) => a.label).join(', ')}`);
  const state = loadCheckpoint(args.state, { network: network(), contractId, socialId, seed: args.seed },
    { docs: {}, modes: {} });
  const recorder = createRecorder({ writer, state, file: args.state });
  const phase = phaseRunner(args.concurrency);

  /** The voter's ballot in one slot of a poll (byPollVoter is unique on it): its id, or null. */
  const ballotIdAt = (pollId, ownerId, slot) => readback(handle, async () => {
    const found = await handle.sdk.documents.query({
      dataContractId: contractId, documentTypeName: 'vote',
      where: [['pollId', '==', pollId], ['$ownerId', '==', ownerId], ['slot', '==', slot]], limit: 1,
    });
    const doc = [...found.values()][0];
    return doc ? asBase58(doc.id ?? fieldsOf(doc).$id) : null;
  });

  /**
   * What a ballot copies off its poll, read from the STORED poll once per poll: a resumed run's plan may compute a
   * different endsAt than the one written, and any disagreement is a 40127.
   */
  const pollRefs = new Map();
  const refsOf = (pollId) => {
    if (!pollRefs.has(pollId)) {
      pollRefs.set(pollId, battery.fetchDocument('poll', pollId).then((doc) => {
        const fields = fieldsOf(doc);
        if (!fields) throw new Error(`poll ${pollId} does not read back`);
        return { pollOptionCount: Number(fields.optionCount), pollMultiChoice: fields.multiChoice === true, pollEndsAt: Number(fields.endsAt) };
      }));
    }
    return pollRefs.get(pollId);
  };

  /** Each poll then its embedding post, one chain per creator (the post embeds an id that must already exist). */
  const writePolls = (label, polls, closesAt) => phase(label, polls, (poll) => poll.creator, async (poll) => {
    const actor = actors.get(poll.creator);
    // A poll is immutable, so a bank entry whose multiChoice flag changed after
    // its poll landed can never be reconciled: every ballot would copy the wrong
    // mode and be refused 40127.
    const mode = poll.multiChoice ? 'multi' : 'single';
    const recorded = state.modes[poll.key];
    if (recorded && recorded !== mode) {
      recorder.fail(`poll/${poll.key}`, 'poll', `the poll on chain is a ${recorded}-choice poll but the bank now says `
        + `${mode}; polls are immutable — give the edited entry a new key`);
      return;
    }
    const endsAt = poll.closesSoon ? closesAt : poll.endsAtMs;
    if (!recorder.id(`poll/${poll.key}`) && !(endsAt > Date.now() && endsAt - Date.now() <= MAX_POLL_MS)) {
      recorder.fail(`poll/${poll.key}`, 'poll', `endsAt ${new Date(endsAt).toISOString()} is not within the next 31 days (is --now stale?)`);
      return;
    }
    const pollId = await recorder.createDoc(actor, 'poll', `poll/${poll.key}`, {
      question: poll.question, options: poll.options, optionCount: poll.options.length, multiChoice: poll.multiChoice, endsAt,
    });
    if (!pollId) return;
    state.modes[poll.key] = mode;
    await recorder.createDoc(actor, 'post', `post/${poll.key}`, socialPost({
      content: poll.caption, hashtag: poll.hashtag,
      embedContractId: bs58.decode(contractId), embedDocType: 'poll', embedId: bs58.decode(pollId),
    }), { tokenCost: TOKEN_COST.post, contract: socialId });
  });

  /**
   * Every ballot of `polls`, one chain per voter: the create writes `initial`; when the plan's final `choice`
   * differs, a replace moves it there (or drops it: a withdrawal). A resumed run finds the ballot by its
   * (poll, voter, slot) key and only corrects what has drifted.
   */
  const castBallots = (label, polls) => {
    const ballots = polls.flatMap((poll) => (recorder.id(`poll/${poll.key}`) ? poll.ballots.map((b) => ({ poll, ...b })) : []));
    return phase(label, ballots, (b) => b.voter, async ({ poll, voter, slot, initial, choice }) => {
      const actor = actors.get(voter);
      const pollId = recorder.id(`poll/${poll.key}`);
      const key = `ballot/${poll.key}/${voter}/${slot}`;
      let refs;
      try {
        refs = await refsOf(pollId);
      } catch (error) {
        recorder.fail(key, 'vote', describeErr(error));
        return;
      }
      const ballot = (value) => ({ pollId: bs58.decode(pollId), slot, ...(value === undefined ? {} : { choice: value }), ...refs });
      const closed = () => Date.now() > refs.pollEndsAt - CLOSE_MARGIN_MS;
      const existing = () => ballotIdAt(pollId, actor.ownerId, slot);
      if (!recorder.id(key) && closed()) {
        recorder.fail(key, 'vote', `the poll closed at ${new Date(refs.pollEndsAt).toISOString()} before this ballot was cast`);
        return;
      }
      // A 40105 is the voter's slot already holding a ballot: whatever it holds, the replace below settles it.
      const created = await recorder.createDoc(actor, 'vote', key, ballot(initial), {
        duplicateIsSuccess: true, adopt: existing, accepted: async () => (await existing()) !== null,
      });
      // A create that landed behind a 504 comes back without its id (or reported as
      // failed); the (poll, voter, slot) key finds it either way.
      const id = created ?? await existing();
      if (!id) return;
      // Writes stop at the close. Only a planned change is then a failure; any
      // other drift can no longer be corrected, and the tally check reports it.
      if (closed()) {
        if (initial !== choice) recorder.fail(key, 'vote', `the poll closed at ${new Date(refs.pollEndsAt).toISOString()} before this ballot's change`);
        return;
      }
      // Every ballot, not only those with a planned change: a checkpointed or
      // adopted ballot may have been edited since (ballots are editable until
      // the close), and reconcileDoc writes only when it differs from the plan.
      try {
        if (await writer.reconcileDoc(actor, 'vote', id, ballot(choice))) console.log(`  ${choice === undefined ? 'withdrew' : 'changed'} ${key}`);
      } catch (error) {
        recorder.fail(key, 'vote', describeErr(error));
      }
    });
  };

  if (!args.verifyOnly) {
    // The companion posts are token-priced, so buy their YAPP before writing any.
    const spend = new Map();
    for (const poll of plan) spend.set(poll.creator, (spend.get(poll.creator) ?? 0n) + BigInt(TOKEN_COST.post));
    await ensureTokens(battery, await battery.readback(() => battery.sdk.tokens.calculateId(socialId, 0)), actors, spend);

    const open = plan.filter((poll) => !poll.closesSoon);
    const closing = plan.filter((poll) => poll.closesSoon);
    await writePolls('polls and embedding posts', open);
    await castBallots('ballots', open);
    // The closing polls go last, their ballots straight after, so their window
    // only has to cover these two phases. One close time for all of them.
    const closesAt = Date.now() + args.closeInMs;
    await writePolls(`closing polls and embedding posts (closing ${new Date(closesAt).toISOString()})`, closing, closesAt);
    await castBallots('ballots on the closing polls', closing);
  }

  // ---- Verification: the shapes the poll card itself uses.
  const bad = [];
  let onChain = 0;
  for (const poll of plan) {
    const pollId = recorder.id(`poll/${poll.key}`);
    if (!pollId) { console.log(`\n  ${poll.key}: no poll on chain`); bad.push(poll.key); continue; }
    const problems = [];
    const fields = fieldsOf(await battery.fetchDocument('poll', pollId));
    const endsAt = fields ? Number(fields.endsAt) : NaN;
    if (!fields) problems.push('the poll document does not read back');
    else {
      if (fields.multiChoice !== poll.multiChoice) problems.push(`multiChoice=${fields.multiChoice}, planned ${poll.multiChoice}`);
      if (JSON.stringify(fields.options) !== JSON.stringify(poll.options)) problems.push(`options ${JSON.stringify(fields.options)} differ from the plan`);
      if (Number(fields.optionCount) !== poll.options.length) problems.push(`optionCount=${fields.optionCount}, planned ${poll.options.length}`);
    }

    // Groups that decode to nothing mean the key encoding changed; zero-filling
    // there would send someone hunting a seeding bug. An EMPTY response is a
    // genuine "no votes yet" — count trees do not materialise empty branches.
    // byPollChoice skips a ballot with no choice, so a withdrawn or unticked one is not counted.
    const raw = await battery.groupedCount('vote',
      [['pollId', '==', pollId], ['choice', 'in', poll.options.map((_, i) => i)]], ['choice'], decodeIntGroupKey);
    const tally = new Array(poll.options.length).fill(0);
    let matched = 0;
    for (const [choice, value] of raw) {
      if (choice === null || choice < 0 || choice >= tally.length) continue;
      tally[choice] = Number(value);
      matched += 1;
    }
    if (raw.size > 0 && matched === 0) {
      console.log(`\n  ${poll.key}: the grouped tally decoded to nothing (key encoding changed?)`);
      bad.push(poll.key);
      continue;
    }
    const total = sum(tally);
    const top = Math.max(...tally);
    const leaders = tally.filter((count) => count === top).length;
    onChain += total;
    printTable([['#', 2], ['option', 26], ['votes', -5], ['share', -6], ['', 26]],
      poll.options.map((option, index) => [index, option, tally[index],
        `${total > 0 ? Math.round((tally[index] / total) * 100) : 0}%`,
        `${bar(tally[index], total)}${top > 0 && leaders === 1 && tally[index] === top ? ' <- leading' : ''}`]),
      `${poll.key} [${poll.multiChoice ? 'multi' : 'single'}, ${endsAt <= Date.now() ? 'closed' : 'closes'} ${Number.isFinite(endsAt) ? new Date(endsAt).toISOString() : '?'}] ${pollId} — ${poll.question} (${total} counted)`);
    if (tally.join(',') !== poll.expected.join(',')) problems.push(`tally ${tally.join(',')} does not match the plan ${poll.expected.join(',')}`);

    const postId = recorder.id(`post/${poll.key}`);
    const embedded = postId ? fieldsOf(await battery.fetchDocument('post', postId, socialId))?.embedId : null;
    if (!embedded || bs58.encode(Uint8Array.from(embedded)) !== pollId) problems.push(`the post ${postId ?? '(missing)'} does not embed this poll`);
    if (problems.length > 0) { bad.push(poll.key); for (const problem of problems) console.log(`      PROBLEM: ${problem}`); }
  }

  console.log(`\ncounted selections on chain across all polls: ${onChain}`);
  console.log(bad.length === 0 ? 'all polls seeded, embedded and tallying as planned' : `${bad.length} poll(s) do not match the plan: ${bad.join(', ')}`);
  return recorder.summary(`; checkpoint ${args.state}`) === 0 && bad.length === 0 ? 0 : 1;
}

const replaced = (ballot) => ballot.initial !== ballot.choice;

function dryRun(plan, args) {
  const ballots = plan.flatMap((poll) => poll.ballots);
  const single = plan.filter((poll) => !poll.multiChoice).length;
  console.log(counts({
    polls: plan.length, 'single-choice': single, 'multi-choice': plan.length - single, 'closing soon': plan.filter((p) => p.closesSoon).length,
    'embedding posts': plan.length, ballots: ballots.length,
    'vote changes': ballots.filter((b) => replaced(b) && b.choice !== undefined).length, withdrawals: ballots.filter((b) => b.choice === undefined).length,
  }, ` — ${plan.length * TOKEN_COST.post} YAPP, seed ${args.seed}`));
  printTable([['poll', 14], ['creator', -7], ['type', 6], ['closes', 10], ['pattern', 9], ['voters', -6], ['planned tally', 20], ['question', 40]],
    plan.map((poll) => [poll.key, poll.creator, poll.multiChoice ? 'multi' : 'single',
      poll.closesSoon ? `+${Math.round(args.closeInMs / 60_000)} min` : new Date(poll.endsAtMs).toISOString().slice(0, 10),
      poll.pattern, poll.voters.length, poll.expected.join(','), poll.question.slice(0, 40)]));
  return 0;
}

function selfTest(args) {
  const plan = buildPlan({ seed: args.seed, nowMs: args.nowMs });
  const close = plan.filter((p) => p.pattern === 'close');
  const ballots = plan.flatMap((p) => p.ballots.map((b) => ({ poll: p, ...b })));
  const json = (p) => JSON.stringify(p.map((poll) => poll.ballots));
  return reportSelfTest('the pollr plan', [
    [`14 polls (${plan.length})`, plan.length === 14],
    ['three multi-choice polls', plan.filter((p) => p.multiChoice).length === 3],
    ['three closing polls, one of them multi-choice', plan.filter((p) => p.closesSoon).length === 3 && plan.some((p) => p.closesSoon && p.multiChoice)],
    ['every planned tally sums to its counted (not withdrawn) ballots', plan.every((p) => p.ballots.filter((b) => b.choice !== undefined).length === sum(p.expected))],
    ['every open poll closes after --now and within 31 days of it (endsWithin31Days)',
      plan.every((p) => p.closesSoon || (p.endsAtMs > args.nowMs && p.endsAtMs - args.nowMs <= MAX_POLL_MS))],
    ['single-choice ballots sit in slot 0, one per voter',
      plan.every((p) => p.multiChoice || (p.ballots.every((b) => b.slot === 0) && new Set(p.ballots.map((b) => b.voter)).size === p.ballots.length))],
    ['multi-choice ballots hold choice == slot and are never replaced (multiChoiceIsSlot)',
      ballots.every((b) => !b.poll.multiChoice || (b.choice === b.slot && !replaced(b)))],
    ['no (voter, slot) ballot is planned twice',
      plan.every((p) => new Set(p.ballots.map((b) => `${b.voter}:${b.slot}`)).size === p.ballots.length)],
    ["every written choice is one of the poll's options",
      ballots.every((b) => [b.initial, b.choice].every((c) => c === undefined || (Number.isInteger(c) && c >= 0 && c < b.poll.options.length)))],
    ['the closing polls plan no replace (their window covers one write per ballot)', ballots.every((b) => !b.poll.closesSoon || !replaced(b))],
    ['some single-choice votes change and some are withdrawn (the replace path is seeded)',
      ballots.some((b) => replaced(b) && b.choice !== undefined) && ballots.some((b) => b.choice === undefined)],
    ['the "zero" poll has no ballots', plan.find((p) => p.pattern === 'zero').ballots.length === 0],
    ['every "close" poll really is close (apportionment, not independent draws)',
      close.every((p) => { const s = [...p.expected].sort((a, b) => b - a); return s[0] - s[1] <= 2; })],
    ['every "landslide" poll has a majority option',
      plan.filter((p) => p.pattern === 'landslide').every((p) => Math.max(...p.expected) / sum(p.expected) > 0.5)],
    ['the same seed plans exactly the same ballots', json(buildPlan({ seed: args.seed, nowMs: args.nowMs })) === json(plan)],
    ['a different seed plans differently', json(buildPlan({ seed: `${args.seed}x`, nowMs: args.nowMs })) !== json(plan)],
  ]);
}

export default {
  name: 'pollr',
  state: '.seed-pollr.local.json',
  contractEnv: ['POLLR_CONTRACT_ID', 'NEXT_PUBLIC_POLLR_CONTRACT_ID'],
  defaults: { seed: '20260917', concurrency: 6, nowMs: Date.now(), closeInMs: 10 * 60_000 },
  flags: { '--now': ['nowMs', 'number'], '--close-in': ['closeInMs', 'number'] },
  check(args) {
    // The poll and ballot shapes here are v5's (options[], one stored `vote`
    // doctype with slot and the copied poll fields): refuse any other topology.
    const topology = envValue('NEXT_PUBLIC_POLLR_TOPOLOGY');
    if (topology && topology !== 'v5') throw new Error(`this seeder writes v5 poll and ballot shapes, but NEXT_PUBLIC_POLLR_TOPOLOGY is ${topology}`);
    if (!(args.closeInMs >= 60_000 && args.closeInMs <= MAX_POLL_MS)) throw new Error('--close-in takes milliseconds between 60000 and 31 days');
  },
  plan: (args) => buildPlan({ seed: args.seed, nowMs: args.nowMs }),
  dryRun,
  selfTest,
  run,
};
