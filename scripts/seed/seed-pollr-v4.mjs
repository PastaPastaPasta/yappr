/**
 * Seeds realistic FAKE poll content onto the **Pollr v4 contract** and the
 * devnet social contract, so the /devnet deployment's feed has lived-in polls.
 *
 * What it writes, per planned poll (the same three steps the compose flow
 * performs — see components/compose/compose-modal.tsx):
 *   1. a `poll` on the Pollr contract, carrying the poster-attested `author`
 *      (v4 binds every ballot's `pollOwnerId` to it) — credits only, no YAPP,
 *      but pricey (~57M credits: the creator pays up front for the
 *      preallocated `vote.byPoll` / `vote.byPollOwner` ballot trees);
 *   2. a `post` on the SOCIAL contract by the same author whose
 *      `embedContractId` / `embedDocType` / `embedId` triple points at the poll
 *      (lib/poll-embed.ts `buildPollEmbed`) — 10 YAPP;
 *   3. the ballots: `vote` for single-choice polls, `multiVote` for
 *      multi-choice ones. Both are indexOnly and free.
 *
 * Determinism. The plan is a fixed question bank plus a seeded PRNG (one
 * substream per poll, so editing the bank never reshuffles the others), and
 * every document's entropy is `sha256(seed | contract | opKey)` — the `$id` of
 * a poll or post is therefore recomputable from the plan alone. That is what
 * makes the run resumable without trusting the checkpoint: a re-run can ask the
 * chain "is this exact document already there?" before writing anything.
 *
 * Idempotence / resume. `.seed-pollr.local.json` caches what landed; anything
 * not in it is probed on chain first (get-by-id for poll/post, an
 * entry-existence query for the indexOnly ballots — `documents.get` can never
 * confirm those, there is no row under the id) and only then written. A
 * structural-duplicate rejection on a ballot (40105) means the voter already
 * voted, which is the end state we wanted.
 *
 * Scheduling. Strictly sequential per actor (one state transition per identity
 * — the identity contract nonce forbids more), parallel across actors behind a
 * global in-flight cap. Polls and their posts go first (the post embeds an id
 * that must exist), ballots second.
 *
 * Devnet quirks handled, from run-seeder.mjs / verify-pollr-v4.mjs: a DAPI 504
 * on the confirmation wait is not a rejection (readback decides), indexOnly
 * creates can throw post-broadcast even when they landed, quorum rotation kills
 * the SDK (full reconnect), nonce desync needs a fresh SDK.
 *
 * Run:
 *   NETWORK=devnet node scripts/seed/seed-pollr-v4.mjs --dry-run
 *   NETWORK=devnet node scripts/seed/seed-pollr-v4.mjs [--contract <id>] [--concurrency 6]
 *   NETWORK=devnet node scripts/seed/seed-pollr-v4.mjs --verify-only
 *
 * Personas: the three poll personas already in the seed ledger (230-232) plus
 * scripts/seed/personas.polls.json (300-307), provisioned by
 * provision-seed-identities.mjs (`--yapp 150` covers the embedding posts).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdentitySigner, ensureInitialized } from '@dashevo/evo-sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import {
  CRITICAL_AUTH_KEY_ID,
  DUPLICATE_UNIQUE,
  NONCE_DESYNC,
  REPO_ROOT,
  RETRYABLE,
  TOKEN_COST,
  TRANSPORT_COLLAPSE,
  WAIT_MAYBE_LANDED,
  YAPP_TOKEN_POSITION,
  buildDocument,
  createSdkHandle,
  describeErr,
  ledgerEntry,
  loadLedger,
  network,
  paymentInfo,
  readEnvFile,
  readback,
  sleep,
  socialContractId,
  stateRank,
  wifFromHex,
} from './seed-lib.mjs';

const STATE_FILE = join(REPO_ROOT, '.seed-pollr.local.json');
const SDK_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const SETTLE_MS = 3_000;
const SETTLE_POLLS = 3;
const DEFAULT_SEED = 20260917;
const DAY_MS = 86_400_000;
/** Grouped integer count keys arrive as the hex of 0x80 + value (docs/POLLR_V4.md). */
const CHOICE_KEY_OFFSET = 0x80;

// ---- The plan ---------------------------------------------------------------
//
// Hand-written questions (a PRNG cannot write a funny poll), hand-assigned
// creators, and a `pattern` that tells the vote generator what the result
// should look like. `endsAt` is expressed in whole days relative to the run's
// UTC midnight: negative = already closed (the app hides the ballot UI and
// shows results), positive = closing later, absent = open forever.

/** Every persona that takes part, in ledger order. Creators are drawn from the same set. */
const PERSONAS = [230, 231, 232, 300, 301, 302, 303, 304, 305, 306, 307];

const POLL_BANK = [
  {
    key: 'editor',
    creator: 301,
    question: 'Which editor are you actually using day to day in 2026? Not the one in your bio — the one that is open right now.',
    options: ['Neovim', 'VS Code', 'Zed', 'A JetBrains IDE', 'Helix'],
    pattern: 'landslide',
    caption: 'settling this the only honest way. the one thats open RIGHT NOW, not the one in your bio #devtools',
    hashtag: 'devtools',
  },
  {
    key: 'ci-wait',
    creator: 306,
    question: 'How long can CI take before you context-switch and lose the afternoon?',
    options: ['Under 2 minutes', '2 to 5 minutes', '5 to 15 minutes', 'I have made peace with 40'],
    pattern: 'close',
    caption: 'our pipeline is at 17 minutes and i am no longer a functioning engineer #ci',
    hashtag: 'ci',
  },
  {
    key: 'flaky',
    creator: 230,
    question: 'A test fails once in every twenty runs. What actually happens to it on your team?',
    options: ['Someone fixes it properly', 'Retry twice, move on', 'Deleted, no notes', 'Quarantined forever'],
    pattern: 'landslide',
    endsAt: -4,
    caption: 'closed now but the results made me sad. be honest with yourselves out there #testing',
    hashtag: 'testing',
  },
  {
    key: 'noodles',
    creator: 302,
    question: 'Desert island noodle. You get exactly one for the rest of your life. Choose carefully.',
    options: ['Ramen', 'Pho', 'Hand-pulled lamian', 'Pad thai', 'Laksa', 'Plain spaghetti'],
    pattern: 'close',
    caption: 'the hardest question I have ever asked anyone. no sauces, no sides, just the noodle #food',
    hashtag: 'food',
  },
  {
    key: 'pineapple',
    creator: 302,
    question: 'Pineapple on pizza: final answer?',
    options: ['Yes, obviously', 'Absolutely not', 'Only with chilli and good ham'],
    pattern: 'landslide',
    endsAt: -11,
    caption: 'poll closed. the people have spoken and I am afraid I agree with them #pizza',
    hashtag: 'pizza',
  },
  {
    key: 'breakfast',
    creator: 307,
    question: 'What is actually in you before a long run? Not what the magazine says. What you actually eat.',
    options: ['Nothing, just coffee', 'Toast and honey', 'Oats', 'Eggs and bacon, somehow', 'A gel and regret'],
    pattern: 'split',
    caption: '5am. 32km. the fuelling discourse never ends, so lets take a census #running',
    hashtag: 'running',
  },
  {
    key: 'dash-use',
    creator: 303,
    question: 'What do you mainly use Dash for right now, in this actual month?',
    options: ['Everyday payments', 'Savings', 'Running a masternode', 'Building on Platform', 'Watching the charts'],
    pattern: 'split',
    caption: 'genuinely curious how this splits in 2026. no wrong answer, including the last one #dash',
    hashtag: 'dash',
  },
  {
    key: 'dash-feature',
    creator: 303,
    question: 'Which Dash Platform features are you most excited to build on? Pick as many as you mean.',
    options: ['Token contracts', 'Groups', 'Encrypted documents', 'Ranked indexes', 'DPNS names', 'Withdrawals'],
    multiChoice: true,
    pattern: 'multi',
    endsAt: 21,
    caption: 'multi-select, because nobody building on this stack has only one favourite #platform',
    hashtag: 'platform',
  },
  {
    key: 'yappr-next',
    creator: 232,
    question: 'What should Yappr ship next?',
    options: ['Proper search', 'Lists', 'Scheduled posts', 'Better DMs', 'Nothing, fix the bugs'],
    pattern: 'close',
    caption: 'asking the timeline instead of the roadmap for once #yappr',
    hashtag: 'yappr',
  },
  {
    key: 'poll-length',
    creator: 300,
    question: 'Methodology question: how long should a poll stay open by default before the result stops meaning anything?',
    options: ['1 hour', '1 day', '3 days', '1 week'],
    pattern: 'zero',
    caption: 'posted this at 3am my time and I fear it shows. methodology nerds, where are you #research',
    hashtag: 'research',
  },
  {
    key: 'survey-sins',
    creator: 300,
    question: 'Which survey sins annoy you most? They never come alone, so pick all that apply.',
    options: ['Leading questions', 'No "none of the above"', 'Mandatory 5-star scale', 'Ten pages, no progress bar'],
    multiChoice: true,
    pattern: 'multi',
    endsAt: -2,
    caption: 'results are in and honestly you are all correct about every single one of these #research',
    hashtag: 'research',
  },
  {
    key: 'football',
    creator: 304,
    question: 'One world-class striker, nothing else in the squad. Which shape do you actually pick?',
    options: ['4-4-2', '4-3-3', '3-5-2', '5-4-1 and pray'],
    pattern: 'close',
    caption: 'the eternal argument, now with a sample size. show your working in the replies #football',
    hashtag: 'football',
  },
  {
    key: 'homelab',
    creator: 305,
    question: 'Be honest about what the homelab is FOR. Pick everything that is true.',
    options: ['Media server', 'Backups', 'Learning kubernetes', 'One DNS blocker', 'Heating the garage'],
    multiChoice: true,
    pattern: 'multi',
    caption: '42U of regret in the garage and I want to know I am not alone in this #homelab',
    hashtag: 'homelab',
  },
  {
    key: 'coffee',
    creator: 231,
    question: 'Which coffee method has genuinely earned its counter space?',
    options: ['Aeropress', 'V60', 'Moka pot', 'Espresso machine', 'French press', 'Instant, honestly'],
    pattern: 'split',
    endsAt: 5,
    caption: 'counter space is finite and I am doing an audit this weekend #coffee',
    hashtag: 'coffee',
  },
];

// ---- Deterministic randomness -----------------------------------------------

/** 32-bit FNV-1a of a string — the substream selector for a poll's PRNG. */
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** mulberry32: small, fast, and identical on every Node version. */
function prngFor(seed, label) {
  let state = (seed + hashString(label)) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));

/** Fisher-Yates on a copy, driven by the poll's PRNG. */
function shuffled(rng, items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Largest-remainder apportionment of `total` ballots across `weights`.
 *
 * Single-choice tallies are apportioned rather than sampled: with a turnout of
 * ten, independent draws off a "two front-runners" weighting land on 6-1-1-2 as
 * often as on 4-4-1-1, and a poll labelled `close` that renders as a blowout
 * defeats the point of seeding a varied feed.
 */
function apportion(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (weight / sum) * total);
  const counts = exact.map(Math.floor);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  // `remaining` is strictly below the option count, so `order` always has a
  // next-largest remainder to hand the extra ballot to.
  let remaining = total - counts.reduce((a, b) => a + b, 0);
  for (let i = 0; remaining > 0; i++, remaining--) counts[order[i].index] += 1;
  return counts;
}

/** Index sampled from `weights` proportionally; -1 only when every weight is 0. */
function weightedPick(rng, weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return -1;
  let threshold = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    threshold -= weights[i];
    if (threshold <= 0) return i;
  }
  return weights.length - 1;
}

/** Document entropy that depends only on the plan — the id is recomputable on resume. */
function entropyFor(seed, contractId, opKey) {
  return sha256(Buffer.from(`${seed}|${contractId}|${opKey}`, 'utf8'));
}

// ---- Plan construction -------------------------------------------------------

/**
 * Per-option weights for a result shape. The leading option is chosen by the
 * PRNG rather than fixed at 0, so the bars are not all left-heavy.
 */
function weightsFor(rng, pattern, optionCount) {
  const weights = new Array(optionCount).fill(1);
  const order = shuffled(rng, weights.map((_, index) => index));
  switch (pattern) {
    case 'landslide': // one option takes ~three quarters of the room
      weights[order[0]] = randInt(rng, 16, 22);
      weights[order[1]] = randInt(rng, 2, 4);
      break;
    case 'close': // two front-runners a ballot or two apart
      weights[order[0]] = randInt(rng, 10, 12);
      weights[order[1]] = randInt(rng, 8, 9);
      break;
    case 'split':
    case 'multi': // no consensus: every option has a constituency
      for (let i = 0; i < optionCount; i++) weights[i] = randInt(rng, 2, 12);
      break;
    default:
      throw new Error(`unknown vote pattern ${pattern}`);
  }
  return weights;
}

/**
 * The full op plan: poll + embedding post per bank entry, then every ballot.
 *
 * A single-choice poll gets at most one ballot per voter — that is structural
 * on v4 (`vote.byPoll` terminates at `$ownerId`), so generating two would just
 * earn a 40105. Multi-choice voters pick 2-3 distinct options, which is exactly
 * what `multiVote` allows (one entry per poll+voter+choice).
 */
function buildPlan({ seed, nowMs }) {
  const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return POLL_BANK.map((entry) => {
    const rng = prngFor(seed, entry.key);
    const optionCount = entry.options.length;
    const weights = entry.pattern === 'zero' ? new Array(optionCount).fill(0) : weightsFor(rng, entry.pattern, optionCount);
    const turnout = entry.pattern === 'zero' ? 0 : randInt(rng, 6, PERSONAS.length);
    const voters = shuffled(rng, PERSONAS).slice(0, turnout);
    const docType = entry.multiChoice ? 'multiVote' : 'vote';

    const ballots = [];
    if (entry.multiChoice) {
      // One entry per (poll, voter, choice): each voter picks 2-3 DISTINCT
      // options, sampled without replacement so no ballot is a 40105 duplicate.
      for (const voter of voters) {
        const remaining = [...weights];
        const picks = Math.min(randInt(rng, 2, 3), optionCount);
        for (let i = 0; i < picks; i++) {
          const choice = weightedPick(rng, remaining);
          if (choice < 0) break;
          remaining[choice] = 0;
          ballots.push({ voter, choice });
        }
      }
    } else {
      // Exactly one ballot per voter — structural on v4, so the shape of the
      // result is decided up front and the voters are dealt into it.
      const perChoice = apportion(weights, voters.length);
      const deck = shuffled(rng, perChoice.flatMap((count, choice) => new Array(count).fill(choice)));
      voters.forEach((voter, index) => ballots.push({ voter, choice: deck[index] }));
    }
    ballots.sort((a, b) => a.voter - b.voter || a.choice - b.choice);

    const expected = new Array(optionCount).fill(0);
    for (const ballot of ballots) expected[ballot.choice] += 1;

    return {
      ...entry,
      docType,
      multiChoice: Boolean(entry.multiChoice),
      endsAtMs: entry.endsAt === undefined ? undefined : midnight + entry.endsAt * DAY_MS,
      closed: entry.endsAt !== undefined && entry.endsAt < 0,
      voters,
      ballots,
      expected,
    };
  });
}

// ---- Checkpoint --------------------------------------------------------------

/**
 * Reads the checkpoint and REFUSES one that was written against different
 * wiring. Phase 1 skips a poll purely on a recorded id, so a checkpoint from
 * before a devnet wipe or a contract re-cut would report fourteen polls as
 * "already on chain", embed ghost ids in fourteen paid posts (`embedId` has no
 * refersTo, so those land and render as broken cards) and fire every ballot at
 * a nonexistent poll. `loadLedger` guards its own provenance the same way.
 */
function loadState(file, provenance) {
  if (!existsSync(file)) return { ...provenance, polls: {} };
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not readable JSON (${describeErr(error)}); move it aside to start over`);
  }
  if (!state || typeof state !== 'object') throw new Error(`${file} is not a checkpoint object; move it aside to start over`);
  for (const [key, expected] of Object.entries(provenance)) {
    const found = state[key];
    if (found !== undefined && found !== expected) {
      throw new Error(`${file} was written for ${key}=${found}, this run uses ${expected}. `
        + 'The recorded document ids do not exist under this wiring — move the file aside to re-seed.');
    }
  }
  return { ...provenance, ...state, polls: state.polls ?? {} };
}

function saveState(file, state) {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  renameSync(temp, file);
}

const ballotKey = (voter, choice) => `${voter}:${choice}`;

// ---- Actors ------------------------------------------------------------------

async function buildActors(handle, personaIndexes) {
  const ledger = loadLedger();
  const actors = new Map();
  for (const idx of personaIndexes) {
    const entry = ledgerEntry(ledger, idx);
    if (!entry || !entry.identityId || stateRank(entry.state) < stateRank('registered')) {
      throw new Error(`persona ${idx} is not provisioned (run provision-seed-identities.mjs first)`);
    }
    if (entry.state !== 'ready') {
      console.warn(`  warning: persona ${idx} (${entry.handle}) is in state "${entry.state}" — the embedding post may fail for want of YAPP`);
    }
    const identity = await readback(handle, () => handle.sdk.identities.fetch(entry.identityId));
    if (!identity) throw new Error(`identity ${entry.identityId} (persona ${idx}) not found on this devnet`);
    const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
    const authKey = entry.identityKeys?.find((key) => key.keyId === CRITICAL_AUTH_KEY_ID);
    if (!identityKey || !authKey) throw new Error(`persona ${idx} has no CRITICAL auth key`);
    const signer = new IdentitySigner();
    signer.addKeyFromWif(wifFromHex(authKey.privateKeyHex));
    actors.set(idx, { personaIdx: idx, ownerId: entry.identityId, handle: entry.handle, identityKey, signer });
  }
  return actors;
}

// ---- Writes ------------------------------------------------------------------

/** Does this voter's (poll, choice) entry exist? The only acceptance test an indexOnly ballot has. */
async function ballotExists(handle, contractId, docType, pollId, ownerId, choice) {
  return readback(handle, async () => {
    const result = await handle.sdk.documents.query({
      dataContractId: contractId,
      documentTypeName: docType,
      where: [
        ['pollId', '==', pollId],
        ['choice', '==', choice],
        ['$ownerId', '==', ownerId],
      ],
      limit: 1,
    });
    return result.size > 0;
  });
}

const documentExists = (handle, contractId, docType, id) =>
  readback(handle, async () => (await handle.sdk.documents.get(contractId, docType, id)) != null);

/**
 * Creates one document, deciding the outcome by READING THE CHAIN rather than
 * by the SDK's throw/no-throw: a 504 on the confirmation wait is not a
 * rejection, and an indexOnly create can throw after a successful broadcast.
 *
 * `accepted` is handed the document's `$id`, which is a pure function of the
 * plan (see `entropyFor`) — that is what lets a resumed run recognise its own
 * earlier write instead of duplicating it.
 */
async function createDocument(handle, { actor, contractId, docType, data, entropy, tokenCost, accepted, duplicateIsSuccess }) {
  const { document, id } = buildDocument({ contractId, docType, ownerId: actor.ownerId, data, entropy });
  const landed = () => accepted(id);
  if (await landed()) return { skipped: true, id };

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await handle.sdk.documents.create({
        document,
        identityKey: actor.identityKey,
        signer: actor.signer,
        ...paymentInfo(tokenCost),
      });
      if (await landed()) return { id };
      // A clean return with nothing on chain still means the write may be a
      // block behind; settle before spending another (duplicate-id) transition.
      for (let poll = 0; poll < SETTLE_POLLS; poll++) {
        await sleep(SETTLE_MS);
        if (await landed()) return { id };
      }
      lastError = new Error('create returned but the document is not on chain');
    } catch (error) {
      lastError = error;
      const text = describeErr(error);
      if (DUPLICATE_UNIQUE.test(text) && duplicateIsSuccess) {
        // A structural duplicate is only THIS op's end state when the entry on
        // chain is the one we tried to write: on a single-choice poll an
        // earlier ballot for a DIFFERENT choice raises the same 40105, and
        // recording it as this choice would corrupt the tally.
        if (await landed()) return { id };
        throw new Error(`rejected as a duplicate, but this exact entry is not on chain — the voter already voted differently: ${text.slice(0, 160)}`);
      }
      if (TRANSPORT_COLLAPSE.test(text) || NONCE_DESYNC.test(text)) {
        try { await handle.reconnect(text); } catch { /* the next attempt rebuilds */ }
      }
      for (let poll = 0; poll < SETTLE_POLLS; poll++) {
        await sleep(SETTLE_MS);
        try {
          if (await landed()) return { id };
        } catch (readError) {
          lastError = readError;
        }
      }
      const retryable = TRANSPORT_COLLAPSE.test(text) || NONCE_DESYNC.test(text) || RETRYABLE.test(text) || WAIT_MAYBE_LANDED.test(text);
      if (!retryable && (/code=4\d{4}/.test(text) || /consensus/i.test(text))) throw error; // Platform said no
    }
    await sleep(2_000 * attempt);
  }
  throw lastError ?? new Error(`${docType} create failed after ${MAX_ATTEMPTS} attempts`);
}

// ---- Scheduling --------------------------------------------------------------

/** Global in-flight cap; per-actor ordering comes from running each actor's ops in one chain. */
function semaphore(limit) {
  let active = 0;
  const queue = [];
  return async function run(fn) {
    while (active >= limit) await new Promise((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

/** Runs each actor's op list sequentially; actors run in parallel behind `limit`. */
async function runChains(chains, limit, runOp) {
  const gate = semaphore(limit);
  await Promise.all(
    [...chains.entries()].map(async ([actorIdx, ops]) => {
      // Sequential on purpose: one state transition per identity at a time.
      for (const op of ops) await gate(() => runOp(op, actorIdx));
    })
  );
}

// ---- Reads (the app's own shapes) --------------------------------------------

/**
 * A grouped count's integer key, in either form the SDK produces: the hex of
 * 0x80 + choice (`documents.count`) or the decoded number (`documents.ranked`).
 * `null` for anything else, so an encoding change fails loudly instead of
 * reading as choice 0 — verify-pollr-v4.mjs `decodeChoiceKey`.
 */
function decodeChoiceKey(key) {
  if (typeof key === 'number') return key;
  if (typeof key === 'bigint') return Number(key);
  if (typeof key !== 'string' || !/^[0-9a-f]+$/i.test(key)) return null;
  return parseInt(key, 16) - CHOICE_KEY_OFFSET;
}

/**
 * Per-option counts, exactly as pollrVoteService.countByChoiceGrouped asks for
 * them: grouped count over `[pollId, choice in <real options>]`.
 *
 * Returns null when the response carried groups that decoded to nothing — the
 * same guard the client uses. Zero-filling there would print as "the ballots
 * are missing" and send someone hunting a seeding bug that is really a key
 * encoding change. An EMPTY response is a genuine "no votes yet": count trees
 * do not materialise empty branches.
 */
async function tallyOf(handle, contractId, poll, pollId) {
  return readback(handle, async () => {
    const raw = await handle.sdk.documents.count({
      dataContractId: contractId,
      documentTypeName: poll.docType,
      where: [
        ['pollId', '==', pollId],
        ['choice', 'in', poll.options.map((_, index) => index)],
      ],
      groupBy: ['choice'],
    });
    const counts = new Array(poll.options.length).fill(0);
    const entries = raw instanceof Map ? [...raw.entries()] : Object.entries(raw ?? {});
    let matched = 0;
    for (const [key, value] of entries) {
      if (key === '') continue;
      const choice = decodeChoiceKey(key);
      if (choice === null || choice < 0 || choice >= counts.length) continue;
      counts[choice] = Number(value);
      matched += 1;
    }
    if (entries.length > 0 && matched === 0) return null;
    return counts;
  });
}

/** The leading option straight off the ranked secondary — pollrVoteService.getWinner. */
async function winnerOf(handle, contractId, poll, pollId) {
  return readback(handle, async () => {
    const page = await handle.sdk.documents.ranked({
      dataContractId: contractId,
      documentTypeName: poll.docType,
      groupBy: 'choice',
      aggregate: { type: 'count' },
      where: [['pollId', '==', pollId]],
      limit: 1,
    });
    const top = page?.entries?.[0];
    if (!top) return null;
    // Ranked pages hand integer group values back DECODED, unlike grouped counts.
    const choice = decodeChoiceKey(top.groupValue);
    const count = Number(top.value ?? 0);
    return count > 0 && choice !== null && choice >= 0 && choice < poll.options.length ? { choice, count } : null;
  });
}

/**
 * Re-reads the poll itself and confirms the fields nothing else would catch:
 * the attested `author` (a poll whose author is not its owner is the documented
 * v4 gap and the app distrusts it), the immutable `multiChoice` flag that
 * selects the ballot doctype, and `endsAt` — the only property here that no
 * other script in the repo writes.
 */
async function checkPollDocument(handle, contractId, poll, pollId, creatorOwnerId) {
  const document = await readback(handle, () => handle.sdk.documents.get(contractId, 'poll', pollId));
  const fields = typeof document?.toObject === 'function' ? document.toObject() : document;
  if (!fields) return ['the poll document does not read back'];
  const problems = [];
  const author = fields.author ? bs58.encode(Uint8Array.from(fields.author)) : null;
  if (author !== creatorOwnerId) problems.push(`author=${author} but the creator is ${creatorOwnerId}`);
  if (Boolean(fields.multiChoice) !== poll.multiChoice) problems.push(`multiChoice=${fields.multiChoice}, planned ${poll.multiChoice}`);
  const endsAt = fields.endsAt === undefined || fields.endsAt === null ? undefined : Number(fields.endsAt);
  if (endsAt !== poll.endsAtMs) problems.push(`endsAt=${endsAt}, planned ${poll.endsAtMs}`);
  const options = poll.options.filter((option, index) => fields[`option${index}`] !== option);
  if (options.length > 0) problems.push(`${options.length} option(s) differ from the plan`);
  return problems;
}

// ---- Reporting ---------------------------------------------------------------

const bar = (count, total) => '#'.repeat(total > 0 ? Math.round((count / total) * 24) : 0);

function printTally(poll, pollId, counts, winner) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const mismatch = counts.join(',') !== poll.expected.join(',');
  console.log(`\n  ${poll.key} [${poll.docType}${poll.closed ? ', closed' : ''}] ${pollId}`);
  console.log(`    ${poll.question}`);
  poll.options.forEach((option, index) => {
    const count = counts[index];
    const share = total > 0 ? Math.round((count / total) * 100) : 0;
    const lead = winner && winner.choice === index ? ' <- ranked winner' : '';
    console.log(`      ${index}. ${option.padEnd(26)} ${String(count).padStart(3)} ${String(share).padStart(3)}%  ${bar(count, total)}${lead}`);
  });
  console.log(`      total ${total}${mismatch ? `  MISMATCH: planned ${poll.expected.join(',')} got ${counts.join(',')}` : ''}`);
  return { total, mismatch };
}

// ---- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    contract: null,
    seed: DEFAULT_SEED,
    concurrency: 6,
    state: STATE_FILE,
    dryRun: false,
    verifyOnly: false,
    nowMs: Date.now(),
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--seed': args.seed = Number(argv[++i]); break;
      case '--concurrency': args.concurrency = Number(argv[++i]); break;
      case '--state': args.state = argv[++i]; break;
      case '--now': args.nowMs = Number(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
      case '--verify-only': args.verifyOnly = true; break;
      default: throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  if (!Number.isFinite(args.seed)) throw new Error('--seed must be a number');
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  if (!Number.isFinite(args.nowMs) || args.nowMs <= 0) throw new Error('--now must be a positive epoch in ms');
  if (!args.contract) {
    args.contract = process.env.NEXT_PUBLIC_POLLR_CONTRACT_ID
      || readEnvFile(join(REPO_ROOT, '.env.devnet')).NEXT_PUBLIC_POLLR_CONTRACT_ID;
  }
  if (!args.contract) throw new Error('Pass --contract <id> or set NEXT_PUBLIC_POLLR_CONTRACT_ID');
  // The poll shape here is v4-only: `author` is required, and v3's
  // additionalProperties:false would refuse all fourteen of them.
  const topology = process.env.NEXT_PUBLIC_POLLR_TOPOLOGY
    || readEnvFile(join(REPO_ROOT, '.env.devnet')).NEXT_PUBLIC_POLLR_TOPOLOGY;
  if (topology && topology !== 'v4') {
    throw new Error(`this seeder writes v4 poll and ballot shapes, but NEXT_PUBLIC_POLLR_TOPOLOGY is ${topology}`);
  }
  return args;
}

function printPlan(plan, socialId, contractId) {
  const ballots = plan.reduce((sum, poll) => sum + poll.ballots.length, 0);
  const single = plan.filter((poll) => !poll.multiChoice);
  console.log(`plan: ${plan.length} polls (${single.length} single-choice, ${plan.length - single.length} multi-choice), `
    + `${plan.length} embedding posts, ${ballots} ballots`);
  console.log(`  pollr contract ${contractId}`);
  console.log(`  social contract ${socialId} (posts cost ${TOKEN_COST.post} YAPP each = ${plan.length * TOKEN_COST.post} YAPP total)`);
  for (const poll of plan) {
    const closing = poll.endsAtMs === undefined
      ? 'open'
      : `${poll.closed ? 'CLOSED' : 'closes'} ${new Date(poll.endsAtMs).toISOString().slice(0, 10)}`;
    console.log(`\n  ${poll.key} — persona ${poll.creator}, ${poll.docType}, ${poll.options.length} options, ${closing}, pattern=${poll.pattern}`);
    console.log(`    Q: ${poll.question}`);
    console.log(`    caption: ${poll.caption}  [#${poll.hashtag}]`);
    console.log(`    options: ${poll.options.map((option, index) => `${index}=${option}`).join(' | ')}`);
    console.log(`    voters (${poll.voters.length}): ${poll.voters.join(', ') || 'none'}`);
    console.log(`    planned tally: ${poll.expected.join(', ')} (${poll.ballots.length} ballots)`);
  }
}

// ---- Main --------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const socialId = socialContractId();
  const plan = buildPlan({ seed: args.seed, nowMs: args.nowMs });

  if (args.dryRun) {
    console.log(`DRY RUN — nothing is broadcast (network=${network()}, seed=${args.seed})\n`);
    printPlan(plan, socialId, args.contract);
    return 0;
  }

  await ensureInitialized();
  const handle = createSdkHandle({ contractIds: [socialId, args.contract], timeoutMs: SDK_TIMEOUT_MS });
  const { protocolVersion } = await handle.connect();
  console.log(`connected (PV${protocolVersion}); network=${network()}; pollr ${args.contract}; social ${socialId}`);

  const actors = await buildActors(handle, PERSONAS);
  console.log(`actors: ${[...actors.values()].map((actor) => `${actor.handle}(${actor.personaIdx})`).join(', ')}`);

  const state = loadState(args.state, {
    network: network(), contractId: args.contract, socialId, seed: args.seed,
  });

  const written = { poll: 0, post: 0, vote: 0, multiVote: 0 };
  const skipped = { poll: 0, post: 0, vote: 0, multiVote: 0 };
  const failures = [];

  if (!args.verifyOnly) {
    // --- phase 1: poll + its embedding post, one chain per creator ---
    const creatorChains = new Map();
    for (const poll of plan) {
      if (!creatorChains.has(poll.creator)) creatorChains.set(poll.creator, []);
      creatorChains.get(poll.creator).push(poll);
    }

    await runChains(creatorChains, args.concurrency, async (poll, actorIdx) => {
      const actor = actors.get(actorIdx);
      const record = (state.polls[poll.key] ??= { docType: poll.docType, votes: {} });
      try {
        // Polls are immutable, so a bank entry whose multiChoice flag changed
        // after its poll landed can never be reconciled — the ballots would go
        // to the other doctype and every tally would read empty.
        if (record.docType !== poll.docType) {
          throw new Error(`the poll on chain is a ${record.docType} poll but the bank now says ${poll.docType}; `
            + 'polls are immutable — give the edited entry a new key');
        }
        if (!record.pollId) {
          const entropy = entropyFor(args.seed, args.contract, `poll/${poll.key}`);
          const data = {
            question: poll.question,
            ...Object.fromEntries(poll.options.map((option, index) => [`option${index}`, option])),
            ...(poll.multiChoice ? { multiChoice: true } : {}),
            ...(poll.endsAtMs === undefined ? {} : { endsAt: poll.endsAtMs }),
            author: bs58.decode(actor.ownerId),
          };
          const outcome = await createDocument(handle, {
            actor,
            contractId: args.contract,
            docType: 'poll',
            data,
            entropy,
            accepted: (id) => documentExists(handle, args.contract, 'poll', id),
          });
          const id = outcome.id;
          record.pollId = id;
          saveState(args.state, state);
          if (outcome.skipped) skipped.poll += 1; else written.poll += 1;
          console.log(`  poll ${poll.key} ${outcome.skipped ? 'already on chain' : 'created'} by ${actor.handle}: ${id}`);
        } else {
          skipped.poll += 1;
        }

        if (!record.postId) {
          const entropy = entropyFor(args.seed, socialId, `post/${poll.key}`);
          const data = {
            content: poll.caption,
            language: 'en',
            author: bs58.decode(actor.ownerId),
            hashtag: poll.hashtag,
            embedContractId: bs58.decode(args.contract),
            embedDocType: 'poll',
            embedId: bs58.decode(record.pollId),
          };
          const outcome = await createDocument(handle, {
            actor,
            contractId: socialId,
            docType: 'post',
            data,
            entropy,
            tokenCost: TOKEN_COST.post,
            accepted: (id) => documentExists(handle, socialId, 'post', id),
          });
          const id = outcome.id;
          record.postId = id;
          saveState(args.state, state);
          if (outcome.skipped) skipped.post += 1; else written.post += 1;
          console.log(`  post ${poll.key} ${outcome.skipped ? 'already on chain' : 'created'} by ${actor.handle}: ${id}`);
        } else {
          skipped.post += 1;
        }
      } catch (error) {
        const message = describeErr(error);
        failures.push({ poll: poll.key, stage: record.pollId ? 'post' : 'poll', error: message });
        console.error(`  FAIL ${poll.key}: ${message.slice(0, 220)}`);
      }
    });

    // --- phase 2: ballots, one chain per voter ---
    const voterChains = new Map();
    for (const poll of plan) {
      const record = state.polls[poll.key];
      if (!record?.pollId) continue; // its poll never landed; nothing to vote on
      for (const ballot of poll.ballots) {
        if (!voterChains.has(ballot.voter)) voterChains.set(ballot.voter, []);
        voterChains.get(ballot.voter).push({ poll, record, choice: ballot.choice });
      }
    }

    await runChains(voterChains, args.concurrency, async ({ poll, record, choice }, actorIdx) => {
      const actor = actors.get(actorIdx);
      const key = ballotKey(actorIdx, choice);
      if (record.votes?.[key]) { skipped[poll.docType] += 1; return; }
      try {
        const outcome = await createDocument(handle, {
          actor,
          contractId: args.contract,
          docType: poll.docType,
          data: {
            pollId: bs58.decode(record.pollId),
            pollOwnerId: bs58.decode(actors.get(poll.creator).ownerId),
            choice,
          },
          entropy: entropyFor(args.seed, args.contract, `ballot/${poll.key}/${actorIdx}/${choice}`),
          // Structural uniqueness makes a repeat ballot a 40105; that means the
          // voter already voted, which is the end state this op wanted.
          duplicateIsSuccess: true,
          accepted: () => ballotExists(handle, args.contract, poll.docType, record.pollId, actor.ownerId, choice),
        });
        record.votes ??= {};
        record.votes[key] = true;
        saveState(args.state, state);
        if (outcome.skipped) skipped[poll.docType] += 1; else written[poll.docType] += 1;
      } catch (error) {
        const message = describeErr(error);
        failures.push({ poll: poll.key, stage: `${poll.docType} ${actorIdx}->${choice}`, error: message });
        console.error(`  FAIL ballot ${poll.key} ${actor.handle} choice ${choice}: ${message.slice(0, 200)}`);
      }
    });
  }

  // --- verification with the app's read shapes ---
  console.log('\n=== tallies (grouped count per choice + ranked winner, the shapes the poll card uses) ===');
  const badPolls = [];
  let ballotsOnChain = 0;
  for (const poll of plan) {
    const record = state.polls[poll.key];
    if (!record?.pollId) {
      console.log(`\n  ${poll.key}: no poll on chain`);
      badPolls.push(poll.key);
      continue;
    }
    const problems = await checkPollDocument(handle, args.contract, poll, record.pollId, actors.get(poll.creator).ownerId);
    const counts = await tallyOf(handle, args.contract, poll, record.pollId);
    if (!counts) {
      console.log(`\n  ${poll.key} [${poll.docType}] ${record.pollId}: the grouped tally decoded to nothing (key encoding changed?)`);
      badPolls.push(poll.key);
      continue;
    }
    const winner = await winnerOf(handle, args.contract, poll, record.pollId);
    const { total, mismatch } = printTally(poll, record.pollId, counts, winner);
    ballotsOnChain += total;
    if (mismatch) problems.push('the tally does not match the plan');

    const post = record.postId
      ? await readback(handle, () => handle.sdk.documents.get(socialId, 'post', record.postId))
      : null;
    const postFields = typeof post?.toObject === 'function' ? post.toObject() : post;
    const embedded = postFields?.embedId ? bs58.encode(Uint8Array.from(postFields.embedId)) : null;
    console.log(`      post ${record.postId ?? '(missing)'} embed ${embedded === record.pollId ? 'OK' : `BAD (${embedded})`}`);
    if (embedded !== record.pollId) problems.push(`the post does not embed this poll (${embedded})`);

    if (problems.length > 0) {
      badPolls.push(poll.key);
      for (const problem of problems) console.log(`      PROBLEM: ${problem}`);
    }
  }

  // --- balances left on the personas ---
  console.log('\n=== personas ===');
  const ids = [...actors.values()].map((actor) => actor.ownerId);
  const tokenId = await readback(handle, () => handle.sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));
  const credits = await readback(handle, () => handle.sdk.identities.balances(ids));
  const yapp = await readback(handle, () => handle.sdk.tokens.balances(ids, tokenId));
  for (const actor of actors.values()) {
    const creditBalance = (credits instanceof Map ? credits.get(actor.ownerId) : undefined) ?? 0n;
    const yappBalance = (yapp instanceof Map ? yapp.get(actor.ownerId) : undefined) ?? 0n;
    const created = plan.filter((poll) => poll.creator === actor.personaIdx).length;
    console.log(`  ${String(actor.personaIdx).padEnd(4)} ${actor.handle.padEnd(16)} ${actor.ownerId}  `
      + `credits=${(Number(creditBalance) / 1e9).toFixed(3)}G  YAPP=${yappBalance}  polls=${created}`);
  }

  console.log('\n=== summary ===');
  console.log(`  written: poll=${written.poll} post=${written.post} vote=${written.vote} multiVote=${written.multiVote}`);
  console.log(`  already present: poll=${skipped.poll} post=${skipped.post} vote=${skipped.vote} multiVote=${skipped.multiVote}`);
  console.log(`  ballots on chain across all polls: ${ballotsOnChain}`);
  console.log(`  checkpoint: ${args.state}`);
  if (failures.length > 0) {
    console.log(`  ${failures.length} FAILURE(S):`);
    for (const failure of failures) console.log(`    ${failure.poll} [${failure.stage}]: ${failure.error.slice(0, 200)}`);
  }
  console.log(badPolls.length === 0 && failures.length === 0
    ? '  all polls seeded, embedded and tallying as planned'
    : `  ${badPolls.length} poll(s) do not match the plan: ${badPolls.join(', ')}`);
  return failures.length === 0 && badPolls.length === 0 ? 0 : 1;
}

try {
  process.exit(await main());
} catch (error) {
  console.error('ERROR:', describeErr(error));
  process.exit(1);
}
