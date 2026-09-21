/**
 * Pollr: per bank entry a `poll` (credits only, but pricey — the creator pays up front for the preallocated ballot
 * trees), an embedding `post` on the SOCIAL contract (10 YAPP, the `embedContractId`/`embedDocType`/`embedId` triple
 * lib/poll-embed.ts builds), and the ballots — `vote` for single-choice polls, `multiVote` for multi-choice. Both
 * ballot types are indexOnly and free. An indexOnly ballot has NO row under its `$id`, so `documents.get` can never
 * confirm one: acceptance is an index-entry query. A 40105 means the voter already voted, which is this op's end
 * state — but only when the exact entry is on chain, otherwise they voted differently and recording it corrupts the
 * tally.
 */
import bs58 from 'bs58';
import { decodeIntGroupKey, reportSelfTest } from '../../battery-lib.mjs';
import { PREFER_CONTRACT_OWNER, TOKEN_COST, actionFeeFor, defaultTopology, feeAgreementFor, paymentInfo, readback } from '../seed-lib.mjs';
import {
  actorsFor, bar, counts, createDocWriter, createRecorder, ensureTokens, entropySource, envValue, loadCheckpoint,
  network, phaseRunner, printTable, randInt, rngFrom, shuffled, socialPost, sum,
} from '../feature-seed-lib.mjs';

const DAY_MS = 86_400_000;
/** Every persona that takes part, in ledger order; creators are drawn from the same set. */
const PERSONAS = [230, 231, 232, 300, 301, 302, 303, 304, 305, 306, 307];

// Hand-written questions (a PRNG cannot write a funny poll), hand-assigned
// creators, and a `pattern` telling the vote generator what the result should
// look like. `endsAt` is whole days from the run's UTC midnight: negative =
// already closed, positive = closing later, absent = open forever.
const POLL_BANK = [
  { key: 'editor', creator: 301, pattern: 'landslide', hashtag: 'devtools',
    question: 'Which editor are you actually using day to day in 2026? Not the one in your bio — the one that is open right now.',
    options: ['Neovim', 'VS Code', 'Zed', 'A JetBrains IDE', 'Helix'],
    caption: 'settling this the only honest way. the one thats open RIGHT NOW, not the one in your bio #devtools' },
  { key: 'ci-wait', creator: 306, pattern: 'close', hashtag: 'ci',
    question: 'How long can CI take before you context-switch and lose the afternoon?',
    options: ['Under 2 minutes', '2 to 5 minutes', '5 to 15 minutes', 'I have made peace with 40'],
    caption: 'our pipeline is at 17 minutes and i am no longer a functioning engineer #ci' },
  { key: 'flaky', creator: 230, pattern: 'landslide', endsAt: -4, hashtag: 'testing',
    question: 'A test fails once in every twenty runs. What actually happens to it on your team?',
    options: ['Someone fixes it properly', 'Retry twice, move on', 'Deleted, no notes', 'Quarantined forever'],
    caption: 'closed now but the results made me sad. be honest with yourselves out there #testing' },
  { key: 'noodles', creator: 302, pattern: 'close', hashtag: 'food',
    question: 'Desert island noodle. You get exactly one for the rest of your life. Choose carefully.',
    options: ['Ramen', 'Pho', 'Hand-pulled lamian', 'Pad thai', 'Laksa', 'Plain spaghetti'],
    caption: 'the hardest question I have ever asked anyone. no sauces, no sides, just the noodle #food' },
  { key: 'pineapple', creator: 302, pattern: 'landslide', endsAt: -11, hashtag: 'pizza',
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
  { key: 'survey-sins', creator: 300, pattern: 'multi', multiChoice: true, endsAt: -2, hashtag: 'research',
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
    const voters = shuffled(rng, PERSONAS).slice(0, unvoted ? 0 : randInt(rng, 6, PERSONAS.length));
    const ballots = [];
    if (entry.multiChoice) {
      // One entry per (poll, voter, choice): 2-3 DISTINCT options each, sampled
      // without replacement so no ballot is a 40105 duplicate of its sibling.
      for (const voter of voters) {
        const remaining = [...weights];
        for (let i = 0; i < Math.min(randInt(rng, 2, 3), optionCount); i++) {
          const choice = weightedIndex(rng, remaining);
          if (choice < 0) break;
          remaining[choice] = 0;
          ballots.push({ voter, choice });
        }
      }
    } else {
      // Exactly one ballot per voter — structural on this contract (vote.byPoll
      // terminates at $ownerId) — so the shape is decided first and voters dealt in.
      const deck = shuffled(rng, apportion(weights, voters.length).flatMap((count, choice) => new Array(count).fill(choice)));
      ballots.push(...voters.map((voter, index) => ({ voter, choice: deck[index] })));
    }
    ballots.sort((a, b) => a.voter - b.voter || a.choice - b.choice);
    const expected = new Array(optionCount).fill(0);
    for (const ballot of ballots) expected[ballot.choice] += 1;
    return {
      ...entry,
      docType: entry.multiChoice ? 'multiVote' : 'vote',
      multiChoice: Boolean(entry.multiChoice),
      endsAtMs: entry.endsAt === undefined ? undefined : midnight + entry.endsAt * DAY_MS,
      closed: entry.endsAt !== undefined && entry.endsAt < 0,
      voters, ballots, expected,
    };
  });
}

const fieldsOf = (document) => (typeof document?.toObject === 'function' ? document.toObject() : document);

async function run({ args, handle, battery, socialId, contractId }) {
  const plan = buildPlan({ seed: args.seed, nowMs: args.nowMs });
  // The caption post lives on the SOCIAL contract, so on v8 it owes that
  // contract's action fee (40132 without) and may ask it to pay the gas. A poll
  // and its ballots are pollr's own doctypes: unpriced, unagreed, unchanged.
  const socialTopology = defaultTopology();
  const socialPays = actionFeeFor('post', socialTopology) ? PREFER_CONTRACT_OWNER : 0;
  const writer = createDocWriter({
    handle,
    contractId,
    entropyFor: entropySource(`yappr/pollr-seed/${args.seed}/${contractId}`),
    paymentInfo: (tokenCost) => paymentInfo(tokenCost, { gasFeesPaidBy: socialPays }),
    agreementFor: (docType, contract) => (contract === socialId ? feeAgreementFor(handle.sdk, docType, socialTopology) : undefined),
  });
  const actors = await actorsFor(battery, PERSONAS);
  console.log(`actors: ${[...actors.values()].map((a) => a.label).join(', ')}`);
  const state = loadCheckpoint(args.state, { network: network(), contractId, socialId, seed: args.seed },
    { docs: {}, docTypes: {} });
  const recorder = createRecorder({ writer, state, file: args.state });
  const phase = phaseRunner(args.concurrency);

  /** The only acceptance test an indexOnly ballot has: is its index entry there? */
  const ballotExists = (docType, pollId, ownerId, choice) => readback(handle, async () => (await handle.sdk.documents.query({
    dataContractId: contractId, documentTypeName: docType,
    where: [['pollId', '==', pollId], ['choice', '==', choice], ['$ownerId', '==', ownerId]], limit: 1,
  })).size > 0);

  if (!args.verifyOnly) {
    // The companion posts are token-priced, so buy their YAPP before writing any.
    const spend = new Map();
    for (const poll of plan) spend.set(poll.creator, (spend.get(poll.creator) ?? 0n) + BigInt(TOKEN_COST.post));
    await ensureTokens(battery, await battery.readback(() => battery.sdk.tokens.calculateId(socialId, 0)), actors, spend);

    // Phase 1: poll then embedding post, one chain per creator (the post embeds
    // an id that must already exist).
    await phase('polls and embedding posts', plan, (poll) => poll.creator, async (poll) => {
      const actor = actors.get(poll.creator);
      // A poll is immutable, so a bank entry whose multiChoice flag changed after
      // its poll landed can never be reconciled: the ballots would go to the other
      // doctype and every tally would read empty.
      const recorded = state.docTypes[poll.key];
      if (recorded && recorded !== poll.docType) {
        recorder.fail(`poll/${poll.key}`, 'poll', `the poll on chain is a ${recorded} poll but the bank now says `
          + `${poll.docType}; polls are immutable — give the edited entry a new key`);
        return;
      }
      const pollId = await recorder.createDoc(actor, 'poll', `poll/${poll.key}`, {
        question: poll.question,
        ...Object.fromEntries(poll.options.map((option, index) => [`option${index}`, option])),
        ...(poll.multiChoice ? { multiChoice: true } : {}),
        ...(poll.endsAtMs === undefined ? {} : { endsAt: poll.endsAtMs }),
      });
      if (!pollId) return;
      state.docTypes[poll.key] = poll.docType;
      await recorder.createDoc(actor, 'post', `post/${poll.key}`, socialPost({
        content: poll.caption, hashtag: poll.hashtag,
        embedContractId: bs58.decode(contractId), embedDocType: 'poll', embedId: bs58.decode(pollId),
      }), { tokenCost: TOKEN_COST.post, contract: socialId });
    });

    // Phase 2: every ballot, one chain per voter.
    const ballots = plan.flatMap((poll) => (recorder.id(`poll/${poll.key}`) ? poll.ballots.map((b) => ({ poll, ...b })) : []));
    await phase('ballots', ballots, (b) => b.voter, async ({ poll, voter, choice }) => {
      const actor = actors.get(voter);
      const pollId = recorder.id(`poll/${poll.key}`);
      await recorder.createDoc(actor, poll.docType, `ballot/${poll.key}/${voter}/${choice}`, {
        pollId: bs58.decode(pollId), pollOwnerId: bs58.decode(actors.get(poll.creator).ownerId), choice,
      }, { duplicateIsSuccess: true, accepted: () => ballotExists(poll.docType, pollId, actor.ownerId, choice) });
    });
  }

  // ---- Verification: the shapes the poll card itself uses.
  const bad = [];
  let onChain = 0;
  for (const poll of plan) {
    const pollId = recorder.id(`poll/${poll.key}`);
    if (!pollId) { console.log(`\n  ${poll.key}: no poll on chain`); bad.push(poll.key); continue; }
    const problems = [];
    const fields = fieldsOf(await battery.fetchDocument('poll', pollId));
    if (!fields) problems.push('the poll document does not read back');
    else {
      const endsAt = fields.endsAt === undefined || fields.endsAt === null ? undefined : Number(fields.endsAt);
      if (Boolean(fields.multiChoice) !== poll.multiChoice) problems.push(`multiChoice=${fields.multiChoice}, planned ${poll.multiChoice}`);
      if (endsAt !== poll.endsAtMs) problems.push(`endsAt=${endsAt}, planned ${poll.endsAtMs}`);
      const wrong = poll.options.filter((option, index) => fields[`option${index}`] !== option).length;
      if (wrong > 0) problems.push(`${wrong} option(s) differ from the plan`);
    }

    // Groups that decode to nothing mean the key encoding changed; zero-filling
    // there would send someone hunting a seeding bug. An EMPTY response is a
    // genuine "no votes yet" — count trees do not materialise empty branches.
    const raw = await battery.groupedCount(poll.docType,
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
    // Ranked pages hand integer group values back DECODED, unlike grouped counts.
    const { page } = await battery.ranked(poll.docType, 'choice', { type: 'count' }, { where: [['pollId', '==', pollId]], limit: 1 });
    const top = page?.entries?.[0];
    const winner = top && Number(top.value ?? 0) > 0 ? decodeIntGroupKey(top.groupValue) : null;
    const total = sum(tally);
    onChain += total;
    printTable([['#', 2], ['option', 26], ['votes', -5], ['share', -6], ['', 26]],
      poll.options.map((option, index) => [index, option, tally[index],
        `${total > 0 ? Math.round((tally[index] / total) * 100) : 0}%`,
        `${bar(tally[index], total)}${winner === index ? ' <- ranked winner' : ''}`]),
      `${poll.key} [${poll.docType}${poll.closed ? ', closed' : ''}] ${pollId} — ${poll.question} (${total} ballots)`);
    if (tally.join(',') !== poll.expected.join(',')) problems.push(`tally ${tally.join(',')} does not match the plan ${poll.expected.join(',')}`);

    const postId = recorder.id(`post/${poll.key}`);
    const embedded = postId ? fieldsOf(await battery.fetchDocument('post', postId, socialId))?.embedId : null;
    if (!embedded || bs58.encode(Uint8Array.from(embedded)) !== pollId) problems.push(`the post ${postId ?? '(missing)'} does not embed this poll`);
    if (problems.length > 0) { bad.push(poll.key); for (const problem of problems) console.log(`      PROBLEM: ${problem}`); }
  }

  console.log(`\nballots on chain across all polls: ${onChain}`);
  console.log(bad.length === 0 ? 'all polls seeded, embedded and tallying as planned' : `${bad.length} poll(s) do not match the plan: ${bad.join(', ')}`);
  return recorder.summary(`; checkpoint ${args.state}`) === 0 && bad.length === 0 ? 0 : 1;
}

function dryRun(plan, args) {
  const ballots = sum(plan.map((poll) => poll.ballots.length));
  const single = plan.filter((poll) => !poll.multiChoice).length;
  console.log(counts({ polls: plan.length, 'single-choice': single, 'multi-choice': plan.length - single, 'embedding posts': plan.length, ballots },
    ` — ${plan.length * TOKEN_COST.post} YAPP, seed ${args.seed}`));
  printTable([['poll', 14], ['creator', -7], ['type', 9], ['closes', 10], ['pattern', 9], ['voters', -6], ['planned tally', 20], ['question', 40]],
    plan.map((poll) => [poll.key, poll.creator, poll.docType,
      poll.endsAtMs === undefined ? 'open' : new Date(poll.endsAtMs).toISOString().slice(0, 10),
      poll.pattern, poll.voters.length, poll.expected.join(','), poll.question.slice(0, 40)]));
  return 0;
}

function selfTest(args) {
  const plan = buildPlan({ seed: args.seed, nowMs: args.nowMs });
  const close = plan.filter((p) => p.pattern === 'close');
  const json = (p) => JSON.stringify(p.map((poll) => poll.ballots));
  return reportSelfTest('the pollr plan', [
    [`14 polls (${plan.length})`, plan.length === 14],
    ['three multi-choice polls', plan.filter((p) => p.multiChoice).length === 3],
    ['every planned tally sums to its ballot count', plan.every((p) => p.ballots.length === sum(p.expected))],
    ['single-choice polls carry at most one ballot per voter',
      plan.every((p) => p.multiChoice || new Set(p.ballots.map((b) => b.voter)).size === p.ballots.length)],
    ['no (voter, choice) entry is planned twice',
      plan.every((p) => new Set(p.ballots.map((b) => `${b.voter}:${b.choice}`)).size === p.ballots.length)],
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
  defaults: { seed: '20260917', concurrency: 6, nowMs: Date.now() },
  flags: { '--now': ['nowMs', 'number'] },
  check() {
    // The ballot shapes here are indexOnly vote/multiVote: refuse a contract the
    // topology says is older.
    const topology = envValue('NEXT_PUBLIC_POLLR_TOPOLOGY');
    if (topology && topology !== 'v4') throw new Error(`this seeder writes v4 poll and ballot shapes, but NEXT_PUBLIC_POLLR_TOPOLOGY is ${topology}`);
  },
  plan: (args) => buildPlan({ seed: args.seed, nowMs: args.nowMs }),
  dryRun,
  selfTest,
  run,
};
