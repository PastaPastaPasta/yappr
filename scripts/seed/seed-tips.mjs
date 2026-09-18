/**
 * Seeds realistic YAPP **tips** on a devnet, so post pages and profiles on the
 * deployed app show proved tips instead of an empty strip.
 *
 * A tip is not a Yappr document: it is a YAPP token transfer whose `publicNote`
 * says which post it was for (`lib/tip-note.ts`, docs/TIPS_YAPP.md). The proof
 * is the `transfer` document Platform writes into the SYSTEM token-history
 * contract because YAPP sets `keepsTransferHistory` — which is also what the
 * app reads back (`lib/services/tip-history-service.ts`). This seeder therefore
 * confirms every tip exactly the way `scripts/verify-tips.mjs` does: by finding
 * the transfer row on the recipient's `to` index, never by trusting the SDK's
 * throw/no-throw (DAPI 504s on confirmation waits for transfers that landed).
 *
 * Shape of a run:
 *   1. PLAN  — discover the busiest real authors on the social contract, read
 *      their newest posts and replies off the same `byOwner` index the app
 *      uses, and lay out every tip (target, amount, message, sender) with a
 *      seeded PRNG. The plan is written to `.seed-tips.local.json` and reused,
 *      so a resumed run tips the same posts the same way.
 *   2. SEND  — per sender sequentially (identity nonce), senders in parallel.
 *      A tip is marked done only once its transfer row is readable.
 *   3. VERIFY — re-derive per-post tips with the app's own read and print the
 *      most-tipped posts.
 *
 * Senders are seed-ledger personas holding YAPP; token transfers need their
 * CRITICAL auth key. No sender is ever spent below `MIN_SENDER_BALANCE`, and a
 * sender is never a recipient (the app refuses self-tips).
 *
 * Run:
 *   NETWORK=devnet node scripts/seed/seed-tips.mjs --dry-run
 *   NETWORK=devnet node scripts/seed/seed-tips.mjs
 *   NETWORK=devnet node scripts/seed/seed-tips.mjs --verify-only
 */
import { IdentitySigner, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  CRITICAL_AUTH_KEY_ID,
  POST_LINK_BASE,
  REPO_ROOT,
  WAIT_MAYBE_LANDED,
  YAPP_TOKEN_POSITION,
  createSdkHandle,
  describeErr,
  ledgerEntry,
  loadLedger,
  network,
  profileContractId,
  readback as readbackWith,
  sleep,
  socialContractId,
  wifFromHex,
} from './seed-lib.mjs';

// ---- Constants ---------------------------------------------------------------

/** The system token-history contract — identical on every chain. */
const TOKEN_HISTORY_CONTRACT_ID = '43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF';
/** Same page cap the app reads with (`TIP_PAGE_LIMIT`); totals are "over the newest N". */
const TIP_PAGE_LIMIT = 100;
/** A sender is never spent below this, so its tips always look like a funded account's. */
const MIN_SENDER_BALANCE = 5n;
/** Seconds to let a transfer settle before looking for its proof. */
const SETTLE_MS = 3000;
/** How many times to re-read the `to` index before calling a tip unconfirmed. */
const CONFIRM_ATTEMPTS = 5;

const STATE_FILE = join(REPO_ROOT, '.seed-tips.local.json');

// Mirrors lib/tip-note.ts. Kept literal (like verify-tips.mjs does) so the
// seeder writes the encoding the app parses, not a re-export of the app's copy.
const TIP_NOTE_PREFIX = 'yappr:tip:v1:';

function encodeTipNote(kind, targetId, message) {
  const header = `${TIP_NOTE_PREFIX}${kind}:${targetId}`;
  const trimmed = (message ?? '').trim();
  return trimmed ? `${header}\n${trimmed}` : header;
}

function parseTipNote(note) {
  if (typeof note !== 'string' || !note.startsWith(TIP_NOTE_PREFIX)) return null;
  const newline = note.indexOf('\n');
  const header = newline === -1 ? note : note.slice(0, newline);
  const rest = header.slice(TIP_NOTE_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator === -1) return null;
  const kind = rest.slice(0, separator);
  const targetId = rest.slice(separator + 1);
  if (kind !== 'post' && kind !== 'reply') return null;
  try {
    if (bs58.decode(targetId).length !== 32) return null;
  } catch {
    return null;
  }
  return { kind, targetId, message: newline === -1 ? '' : note.slice(newline + 1).trim() };
}

// ---- Deterministic randomness -------------------------------------------------

/** mulberry32 seeded from a text seed: same seed, same plan, every run. */
function makeRandom(seedText) {
  const digest = sha256(Buffer.from(String(seedText), 'utf8'));
  let state = (digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3];
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, items) => items[Math.floor(random() * items.length)];

/** Draws from `[value, weight]` pairs. */
function weightedPick(random, entries) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1][0];
}

/** Fisher-Yates against the seeded PRNG (never mutates the input). */
function shuffled(random, items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---- Content bank -------------------------------------------------------------

/** Tip sizes: heavily skewed small, with the occasional headline amount. */
const AMOUNT_WEIGHTS = [[1n, 34], [2n, 24], [5n, 24], [10n, 10], [25n, 6], [100n, 2]];
/** Share of tips that carry a message. */
const MESSAGE_RATE = 0.6;

const MESSAGES = {
  post: [
    'this saved me an afternoon',
    'best thing on my timeline today',
    'thank you for writing it down',
    'more of this please',
    'sending this to the rest of my team',
    'have a coffee on me',
    'i have been looking for this explanation for weeks',
    'the photos made it click',
    'worth more than a like',
    'came back to this twice already',
    'you are right and you should say it louder',
    'for the effort, not just the take',
    'this is the post that got me to stop lurking',
    'clean writeup, no fluff',
    'i tried it and it actually worked',
    'small thanks for a big help',
    'bookmarked, printed, taped to the wall',
    'the last paragraph is the whole thing',
  ],
  reply: [
    'this reply is better than most posts',
    'thanks for taking the time to answer',
    'exactly the nudge i needed',
    'you answered the question i was too embarrassed to ask',
    'correct and kind, rare combination',
    'fixed my problem in one line',
  ],
  profile: [
    'no post in particular, just all of it',
    'been reading you for months, finally paying up',
    'for the archive you have built',
    'keep going',
    'thanks for showing up every day',
    'the timeline is better with you on it',
  ],
};

// ---- Plan ---------------------------------------------------------------------

/**
 * Lays out every tip. Pure: given the same authors, senders and seed it
 * produces the same plan, so the persisted plan and a re-plan agree.
 *
 * @param authors  [{ id, label, posts: [id], replies: [id] }]
 * @param senders  [{ personaIdx, ownerId, handle, budget }] budget = YAPP on hand
 */
function buildPlan({ authors, senders, seed, postTips, replyTips, profileTips, postsPerAuthor }) {
  const random = makeRandom(seed);
  const tips = [];

  // 1. Targets: `postsPerAuthor` posts from each author, newest-first list
  //    sampled so the tipped posts are spread over their recent history.
  const targets = [];
  for (const author of authors) {
    for (const postId of shuffled(random, author.posts).slice(0, postsPerAuthor)) {
      targets.push({ kind: 'post', targetId: postId, to: author.id, label: author.label });
    }
  }

  // 2. Tip counts per post. A few posts are "hot" (the strip is only
  //    interesting when some post has several tippers on it); the rest get one
  //    to three, drawn until the budget of post tips is used up.
  const ordered = shuffled(random, targets);
  const counts = new Map(ordered.map((target) => [target, 0]));
  let remaining = postTips;
  for (const [index, hot] of [8, 6, 5].entries()) {
    if (!ordered[index] || remaining < hot) break;
    counts.set(ordered[index], hot);
    remaining -= hot;
  }
  for (const target of ordered.slice(3)) {
    if (remaining <= 0) break;
    const want = Number(weightedPick(random, [[1, 45], [2, 32], [3, 23]]));
    const take = Math.min(want, remaining);
    counts.set(target, take);
    remaining -= take;
  }
  // Anything left over (fewer targets than tips) goes back onto the hot posts.
  for (let i = 0; remaining > 0; i = (i + 1) % ordered.length) {
    counts.set(ordered[i], counts.get(ordered[i]) + 1);
    remaining -= 1;
  }

  for (const target of ordered) {
    for (let i = 0; i < counts.get(target); i++) tips.push({ ...target });
  }

  // 3. Replies — the same note codec with kind `reply`, spread one per author.
  const replyPool = shuffled(random, authors.flatMap((author) =>
    author.replies.map((replyId) => ({ kind: 'reply', targetId: replyId, to: author.id, label: author.label }))
  ));
  const seenAuthors = new Set();
  for (const candidate of replyPool) {
    if (tips.filter((tip) => tip.kind === 'reply').length >= replyTips) break;
    if (seenAuthors.has(candidate.to)) continue;
    seenAuthors.add(candidate.to);
    tips.push(candidate);
  }

  // 4. Profile tips — a bare message, no target: a transfer that is NOT a tip
  //    note, which is exactly how the app distinguishes "YAPP received" from
  //    "tips on this post" (docs/TIPS_YAPP.md).
  for (const author of shuffled(random, authors).slice(0, profileTips)) {
    tips.push({ kind: 'profile', targetId: null, to: author.id, label: author.label });
  }

  // 5. Amount + message, then the note the sender signs. The (sender, recipient,
  //    amount, note) tuple has to be unique across the plan: it is the only
  //    thing a readback can match a specific tip by, and two identical tips
  //    would confirm each other.
  const used = new Set();
  const hottestPostId = ordered[0]?.targetId ?? null;
  tips.forEach((tip, index) => {
    tip.seq = index;
    tip.amount = weightedPick(random, AMOUNT_WEIGHTS);
    tip.message = (random() < MESSAGE_RATE || tip.kind === 'profile') ? pick(random, MESSAGES[tip.kind]) : '';
  });

  // 6. Senders. Weighted by remaining budget so the richest personas carry the
  //    most tips, and never below the reserve. A sender is never a recipient:
  //    the app refuses a literal self-tip.
  const pool = senders.map((sender) => ({ ...sender, remaining: sender.budget - MIN_SENDER_BALANCE }));
  const firstTipperOfPost = new Map();
  const unfunded = [];
  for (const tip of tips) {
    // The hottest post's SECOND tip is deliberately pinned to whoever sent its
    // first, so that strip reads "N YAPP by M people" with fewer people than
    // rows — the case where a single tipper tipped twice.
    const pinned = tip.kind === 'post' && tip.targetId === hottestPostId
      ? firstTipperOfPost.get(tip.targetId)
      : undefined;
    const affordable = pool.filter((sender) => sender.ownerId !== tip.to && sender.remaining >= tip.amount);
    const pinnedChoice = affordable.filter((sender) => sender.personaIdx === pinned);
    const candidates = pinnedChoice.length > 0 ? pinnedChoice : affordable;
    if (candidates.length === 0) {
      unfunded.push(tip.seq);
      continue;
    }
    const chosen = weightedPick(random, candidates.map((sender) => [sender, Number(sender.remaining)]));
    chosen.remaining -= tip.amount;
    tip.sender = chosen.personaIdx;
    tip.senderId = chosen.ownerId;
    // Only the first tip on a post records its tipper: the pin above then
    // applies to exactly one follow-up tip, not to the whole thread of them.
    if (tip.kind === 'post' && !firstTipperOfPost.has(tip.targetId)) {
      firstTipperOfPost.set(tip.targetId, chosen.personaIdx);
    } else if (tip.kind === 'post') {
      firstTipperOfPost.set(tip.targetId, null);
    }

    // Uniqueness: (sender, recipient, amount, note) is the only handle a
    // readback has on a specific tip, so two identical ones would confirm each
    // other. Re-draw the message, then the amount, until the tuple is new.
    let unique = false;
    for (let attempt = 0; attempt < 64 && !unique; attempt++) {
      tip.note = tip.kind === 'profile' ? tip.message : encodeTipNote(tip.kind, tip.targetId, tip.message);
      const key = `${tip.senderId}|${tip.to}|${tip.amount}|${tip.note}`;
      if (!used.has(key)) {
        used.add(key);
        unique = true;
        break;
      }
      tip.message = pick(random, MESSAGES[tip.kind]);
      if (attempt > 8) {
        chosen.remaining += tip.amount;
        tip.amount = weightedPick(random, AMOUNT_WEIGHTS);
        chosen.remaining -= tip.amount;
      }
    }
    if (!unique) throw new Error(`could not make tip ${tip.seq} unique against the rest of the plan`);
  }

  return {
    tips: tips.filter((tip) => tip.senderId !== undefined),
    unfunded,
    budgets: pool.map(({ personaIdx, handle, remaining }) => ({ personaIdx, handle, remaining })),
  };
}

// ---- State (resume) -----------------------------------------------------------

function loadState(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function saveState(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Plans carry bigint amounts; JSON does not. */
const planToJson = (tips) => tips.map((tip) => ({ ...tip, amount: tip.amount.toString() }));
const planFromJson = (tips) => tips.map((tip) => ({ ...tip, amount: BigInt(tip.amount) }));

// ---- Chain reads --------------------------------------------------------------

const b58 = (value) => (typeof value === 'string' ? value : bs58.encode(Uint8Array.from(value)));

function createChain(handle) {
  const sdk = handle.sdk;
  const readback = (fn) => readbackWith(handle, fn);

  async function query(contractId, documentTypeName, shape) {
    return readback(async () => {
      const result = await sdk.documents.query({ dataContractId: contractId, documentTypeName, ...shape });
      return [...result.values()].map((doc) => doc.toObject());
    });
  }

  /**
   * One page of `transfer` documents off a token-history index, newest first —
   * the exact shape `tip-history-service.ts` reads with.
   */
  async function transfersTo(tokenId, identityId) {
    const rows = await query(TOKEN_HISTORY_CONTRACT_ID, 'transfer', {
      where: [['tokenId', '==', tokenId], ['toIdentityId', '==', identityId]],
      orderBy: [['tokenId', 'asc'], ['toIdentityId', 'asc'], ['$createdAt', 'desc']],
      limit: TIP_PAGE_LIMIT,
    });
    return rows.map((row) => ({
      id: b58(row.$id),
      from: b58(row.$ownerId),
      to: b58(row.toIdentityId),
      amount: BigInt(row.amount ?? 0),
      note: typeof row.publicNote === 'string' ? row.publicNote : '',
      createdAt: Number(row.$createdAt ?? 0),
    }));
  }

  async function transfersFrom(tokenId, identityId) {
    const rows = await query(TOKEN_HISTORY_CONTRACT_ID, 'transfer', {
      where: [['tokenId', '==', tokenId], ['$ownerId', '==', identityId]],
      orderBy: [['tokenId', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: TIP_PAGE_LIMIT,
    });
    return rows.map((row) => ({
      id: b58(row.$id),
      to: b58(row.toIdentityId),
      amount: BigInt(row.amount ?? 0),
      note: typeof row.publicNote === 'string' ? row.publicNote : '',
    }));
  }

  async function yappBalances(identityIds, tokenId) {
    const balances = new Map();
    for (let i = 0; i < identityIds.length; i += 100) {
      const chunk = identityIds.slice(i, i + 100);
      const result = await readback(() => sdk.tokens.balances(chunk, tokenId));
      for (const id of chunk) balances.set(id, (result instanceof Map ? result.get(id) : result?.[id]) ?? 0n);
    }
    return balances;
  }

  /** The app's own author feed read (`post-service.ts` getUserPosts). */
  async function docsByOwner(contractId, documentTypeName, ownerId, limit) {
    const rows = await query(contractId, documentTypeName, {
      where: [['$ownerId', '==', ownerId], ['$createdAt', '>', 0]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit,
    });
    return rows.map((row) => b58(row.$id));
  }

  return { sdk, readback, query, transfersTo, transfersFrom, yappBalances, docsByOwner };
}

/**
 * The busiest real authors on the social contract.
 *
 * There is no "posts per author" aggregate on this contract, so this walks the
 * `languageTimeline` index forward in time (the only index that pages the whole
 * corpus) and tallies owners. Ties break on the identity id, so the ranking is
 * stable for a fixed chain state.
 */
async function discoverAuthors(chain, contractId, { pages, want, language }) {
  const tally = new Map();
  let cursor = 0;
  for (let page = 0; page < pages; page++) {
    const rows = await chain.query(contractId, 'post', {
      where: [['language', '==', language], ['$createdAt', '>', cursor]],
      orderBy: [['language', 'asc'], ['$createdAt', 'asc']],
      limit: 100,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const owner = b58(row.$ownerId);
      tally.set(owner, (tally.get(owner) ?? 0) + 1);
    }
    cursor = Number(rows[rows.length - 1].$createdAt);
    if (rows.length < 100) break;
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, want)
    .map(([id, posts]) => ({ id, posts }));
}

/** Display names for the report (and to prove the tipped identities are real profiles). */
async function authorLabels(chain, identityIds) {
  const labels = new Map();
  for (const id of identityIds) {
    const rows = await chain.query(profileContractId(), 'profile', {
      where: [['$ownerId', '==', id]],
      orderBy: [['$ownerId', 'asc']],
      limit: 1,
    });
    labels.set(id, rows[0]?.displayName || id.slice(0, 8));
  }
  return labels;
}

// ---- Senders ------------------------------------------------------------------

/** A seed-ledger persona that can sign a token transfer (CRITICAL auth key). */
async function tipperActor(chain, personaIdx) {
  const entry = ledgerEntry(loadLedger(), personaIdx);
  if (!entry) throw new Error(`persona ${personaIdx} is not in the seed ledger`);
  const identity = await chain.readback(() => chain.sdk.identities.fetch(entry.identityId));
  if (!identity) throw new Error(`identity ${entry.identityId} (persona ${personaIdx}) is not on this network`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  const authKey = entry.identityKeys.find((key) => key.keyId === CRITICAL_AUTH_KEY_ID);
  if (!identityKey || !authKey) throw new Error(`persona ${personaIdx} has no CRITICAL auth key (id ${CRITICAL_AUTH_KEY_ID})`);
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wifFromHex(authKey.privateKeyHex));
  return { personaIdx, ownerId: entry.identityId, handle: entry.handle, identityKey, signer };
}

// ---- Send ---------------------------------------------------------------------

/**
 * Sends one tip and decides its outcome by READING THE PROOF BACK, the way
 * scripts/verify-tips.mjs case t2 does: the transfer row must be on the
 * recipient's `to` index carrying this sender, this amount and this note.
 */
async function sendTip(chain, { socialId, tokenId, actor, tip }) {
  let reported = null;
  try {
    await chain.sdk.tokens.transfer({
      dataContractId: socialId,
      tokenPosition: YAPP_TOKEN_POSITION,
      senderId: actor.ownerId,
      recipientId: tip.to,
      amount: tip.amount,
      publicNote: tip.note,
      identityKey: actor.identityKey,
      signer: actor.signer,
    });
  } catch (error) {
    // A 504 on the confirmation wait does not mean the transfer was refused.
    reported = describeErr(error);
    if (!WAIT_MAYBE_LANDED.test(reported)) {
      // Anything else still gets the readback — but it is worth seeing.
      console.log(`     tip ${tip.seq}: transfer reported "${reported.slice(0, 120)}"`);
    }
  }

  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
    await sleep(SETTLE_MS);
    const rows = await chain.transfersTo(tokenId, tip.to);
    const proof = rows.find(
      (row) => row.note === tip.note && row.from === actor.ownerId && row.amount === tip.amount
    );
    if (proof) return { ok: true, transferId: proof.id };
  }
  return { ok: false, error: reported ?? 'the SDK reported no error, but no transfer row carries this note' };
}

// ---- Verify -------------------------------------------------------------------

/**
 * Re-derives per-target tips with the app's own logic: one page of the author's
 * newest incoming transfers, filtered by the note's target
 * (`tip-history-service.ts` getTipsForPost).
 */
async function verifyTips(chain, tokenId, authors, labels) {
  const byTarget = new Map();
  const perAuthor = [];
  for (const author of authors) {
    const rows = await chain.transfersTo(tokenId, author.id);
    let received = 0n;
    let noted = 0;
    for (const row of rows) {
      received += row.amount;
      const note = parseTipNote(row.note);
      if (!note) continue;
      noted += 1;
      const entry = byTarget.get(note.targetId) ?? {
        kind: note.kind, author: author.id, total: 0n, tips: 0, tippers: new Set(),
      };
      entry.total += row.amount;
      entry.tips += 1;
      entry.tippers.add(row.from);
      byTarget.set(note.targetId, entry);
    }
    perAuthor.push({
      id: author.id,
      label: labels.get(author.id) ?? author.id.slice(0, 8),
      rows: rows.length,
      received,
      noted,
    });
  }
  return { byTarget, perAuthor };
}

// ---- Self-test (pure, no network) ---------------------------------------------

/** Asserts the invariants the planner has to hold, against synthetic inputs. */
function selfTest() {
  const assert = (condition, message) => {
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
    if (!condition) process.exitCode = 1;
  };

  const fakeId = (text) => bs58.encode(sha256(Buffer.from(text, 'utf8')));
  const authors = Array.from({ length: 10 }, (_, a) => ({
    id: fakeId(`author-${a}`),
    label: `Author ${a}`,
    posts: Array.from({ length: 20 }, (_, p) => fakeId(`post-${a}-${p}`)),
    replies: Array.from({ length: 20 }, (_, r) => fakeId(`reply-${a}-${r}`)),
  }));
  const senders = [
    { personaIdx: 240, ownerId: fakeId('s240'), handle: 'tip-a', budget: 135n },
    { personaIdx: 241, ownerId: fakeId('s241'), handle: 'tip-b', budget: 265n },
    ...Array.from({ length: 6 }, (_, i) => ({
      personaIdx: 310 + i, ownerId: fakeId(`s${310 + i}`), handle: `tip-${i}`, budget: 400n,
    })),
  ];
  const options = { authors, senders, seed: 'self-test', postTips: 100, replyTips: 10, profileTips: 10, postsPerAuthor: 4 };

  const plan = buildPlan(options);
  const kinds = plan.tips.reduce((acc, tip) => ({ ...acc, [tip.kind]: (acc[tip.kind] ?? 0) + 1 }), {});
  assert(plan.tips.length === 120, `plans 120 tips (${plan.tips.length})`);
  assert(kinds.post === 100 && kinds.reply === 10 && kinds.profile === 10, `100 post / 10 reply / 10 profile (${JSON.stringify(kinds)})`);
  assert(plan.unfunded.length === 0, `every tip has a funded sender (${plan.unfunded.length} unfunded)`);

  assert(plan.tips.every((tip) => tip.senderId !== tip.to), 'no tip is a self-tip');
  const keys = new Set(plan.tips.map((tip) => `${tip.senderId}|${tip.to}|${tip.amount}|${tip.note}`));
  assert(keys.size === plan.tips.length, `every (sender, recipient, amount, note) tuple is unique (${keys.size})`);

  const notes = plan.tips.filter((tip) => tip.kind !== 'profile').map((tip) => parseTipNote(tip.note));
  assert(notes.every((note) => note !== null), 'every targeted tip note parses as a v1 tip note');
  assert(
    plan.tips.filter((tip) => tip.kind !== 'profile').every((tip, i) => notes[i].targetId === tip.targetId && notes[i].kind === tip.kind),
    'every note names its own target'
  );
  assert(plan.tips.filter((tip) => tip.kind === 'profile').every((tip) => parseTipNote(tip.note) === null), 'profile tips carry a bare message, not a tip note');

  const spend = new Map();
  for (const tip of plan.tips) spend.set(tip.sender, (spend.get(tip.sender) ?? 0n) + tip.amount);
  const overspent = senders.filter((sender) => (spend.get(sender.personaIdx) ?? 0n) > sender.budget - MIN_SENDER_BALANCE);
  assert(overspent.length === 0, `no sender is planned below ${MIN_SENDER_BALANCE} YAPP (${overspent.map((s) => s.personaIdx).join(',')})`);

  const perTarget = new Map();
  for (const tip of plan.tips.filter((tip) => tip.kind === 'post')) {
    const entry = perTarget.get(tip.targetId) ?? { tips: 0, senders: new Set() };
    entry.tips += 1;
    entry.senders.add(tip.sender);
    perTarget.set(tip.targetId, entry);
  }
  const busiest = [...perTarget.values()].sort((a, b) => b.tips - a.tips)[0];
  assert(busiest.tips >= 5, `at least one post carries 5+ tips (${busiest.tips})`);
  assert([...perTarget.values()].some((entry) => entry.senders.size < entry.tips), 'some post is tipped twice by one sender');
  assert(perTarget.size <= 40, `tips are spread over at most 40 posts (${perTarget.size})`);

  const perAuthor = new Map();
  for (const tip of plan.tips) perAuthor.set(tip.to, (perAuthor.get(tip.to) ?? 0) + 1);
  assert(
    [...perAuthor.values()].every((count) => count < TIP_PAGE_LIMIT / 2),
    `no author receives enough tips to push older ones off the ${TIP_PAGE_LIMIT}-row page (max ${Math.max(...perAuthor.values())})`
  );

  const amounts = plan.tips.map((tip) => Number(tip.amount));
  const small = amounts.filter((amount) => amount <= 5).length;
  assert(small / amounts.length > 0.7, `amounts skew small (${small}/${amounts.length} are <= 5 YAPP)`);
  assert(amounts.some((amount) => amount >= 25), 'some tips are headline-sized');
  const withMessage = plan.tips.filter((tip) => tip.message).length;
  assert(withMessage / plan.tips.length > 0.5, `most tips carry a message (${withMessage}/${plan.tips.length})`);

  const again = buildPlan(options);
  assert(
    JSON.stringify(planToJson(again.tips)) === JSON.stringify(planToJson(plan.tips)),
    'the same seed plans exactly the same tips'
  );
  const other = buildPlan({ ...options, seed: 'self-test-2' });
  assert(JSON.stringify(planToJson(other.tips)) !== JSON.stringify(planToJson(plan.tips)), 'a different seed plans different tips');

  console.log(process.exitCode ? '\nSELF-TEST FAILED' : '\nself-test passed');
  process.exit(process.exitCode ?? 0);
}

// ---- CLI ----------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    dryRun: false, verifyOnly: false, replan: false, selfTest: false,
    state: STATE_FILE, seed: 'yappr-tips-v1',
    senders: [240, 241, 310, 311, 312, 313, 314, 315],
    // 80 pages covers the whole seeded corpus today, so the ranking is the real
    // busiest-author list rather than the busiest of an arbitrary prefix.
    authors: null, authorCount: 12, scanPages: 80, language: 'en',
    postTips: 100, replyTips: 10, profileTips: 10, postsPerAuthor: 4,
    maxTips: Infinity,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': args.dryRun = true; break;
      case '--self-test': args.selfTest = true; break;
      case '--verify-only': args.verifyOnly = true; break;
      case '--replan': args.replan = true; break;
      case '--state': args.state = argv[++i]; break;
      case '--seed': args.seed = argv[++i]; break;
      case '--senders': args.senders = argv[++i].split(',').map((s) => Number(s.trim())); break;
      case '--authors': args.authors = argv[++i].split(',').map((s) => s.trim()); break;
      case '--author-count': args.authorCount = Number(argv[++i]); break;
      case '--scan-pages': args.scanPages = Number(argv[++i]); break;
      case '--post-tips': args.postTips = Number(argv[++i]); break;
      case '--reply-tips': args.replyTips = Number(argv[++i]); break;
      case '--profile-tips': args.profileTips = Number(argv[++i]); break;
      case '--posts-per-author': args.postsPerAuthor = Number(argv[++i]); break;
      case '--max-tips': args.maxTips = Number(argv[++i]); break;
      default: throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return args;
}

// ---- Main ---------------------------------------------------------------------

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: NETWORK=devnet node scripts/seed/seed-tips.mjs [--dry-run] [--verify-only] [--replan]');
  console.error('       node scripts/seed/seed-tips.mjs --self-test   (pure planner checks, no network)');
  console.error('         [--seed <text>] [--senders 240,241,...] [--authors <id,id>] [--author-count 12]');
  console.error('         [--post-tips 100] [--reply-tips 10] [--profile-tips 10] [--max-tips N]');
  process.exit(1);
}

if (args.selfTest) {
  selfTest();
}

if (network() === 'mainnet') {
  console.error('This seeder writes fake tips. Refusing to run against mainnet.');
  process.exit(1);
}

try {
  await ensureInitialized();
  const socialId = socialContractId();
  const handle = createSdkHandle({
    contractIds: [socialId, profileContractId(), TOKEN_HISTORY_CONTRACT_ID],
    log: (msg) => console.log(`  ${msg}`),
  });
  const { protocolVersion } = await handle.connect();
  const chain = createChain(handle);
  const tokenId = await chain.readback(() => chain.sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));
  console.log(`connected (PV${protocolVersion ?? '?'}) — social ${socialId}, YAPP ${tokenId}`);

  let state = args.replan ? null : loadState(args.state);
  if (state && (state.socialContractId !== socialId || state.tokenId !== tokenId)) {
    throw new Error(`${args.state} was written for a different contract/token — re-run with --replan`);
  }

  // ---- PLAN ------------------------------------------------------------------
  if (!state) {
    console.log('\nPhase PLAN');
    const discovered = args.authors
      ? args.authors.map((id) => ({ id, posts: 0 }))
      : await discoverAuthors(chain, socialId, { pages: args.scanPages, want: args.authorCount, language: args.language });
    if (discovered.length === 0) throw new Error('no authors found on the social contract');
    const labels = await authorLabels(chain, discovered.map((author) => author.id));

    const authors = [];
    for (const author of discovered) {
      const [posts, replies] = await Promise.all([
        chain.docsByOwner(socialId, 'post', author.id, 20),
        chain.docsByOwner(socialId, 'reply', author.id, 20),
      ]);
      if (posts.length === 0) {
        console.log(`  skipping ${author.id} — no posts on the byOwner index`);
        continue;
      }
      authors.push({ id: author.id, label: labels.get(author.id), posts, replies });
      console.log(`  ${labels.get(author.id)} (${author.id}) — ${posts.length} posts, ${replies.length} replies`);
    }

    const actors = await Promise.all(args.senders.map((idx) => tipperActor(chain, idx)));
    const balances = await chain.yappBalances(actors.map((actor) => actor.ownerId), tokenId);
    const senders = actors.map((actor) => ({
      personaIdx: actor.personaIdx, ownerId: actor.ownerId, handle: actor.handle,
      budget: balances.get(actor.ownerId) ?? 0n,
    }));
    for (const sender of senders) console.log(`  sender ${sender.handle}(${sender.personaIdx}) holds ${sender.budget} YAPP`);

    const plan = buildPlan({
      authors, senders, seed: args.seed,
      postTips: args.postTips, replyTips: args.replyTips,
      profileTips: args.profileTips, postsPerAuthor: args.postsPerAuthor,
    });
    if (plan.unfunded.length > 0) {
      console.log(`  ${plan.unfunded.length} tip(s) dropped: no sender has the budget for them`);
    }

    state = {
      network: network(),
      socialContractId: socialId,
      tokenId,
      seed: args.seed,
      createdAt: new Date().toISOString(),
      authors: authors.map(({ id, label }) => ({ id, label })),
      plan: planToJson(plan.tips),
      done: {},
      failed: {},
    };
    if (!args.dryRun) saveState(args.state, state);
  }

  state.done ??= {};
  state.failed ??= {};
  const plan = planFromJson(state.plan);
  const authors = state.authors;
  const labels = new Map(authors.map((author) => [author.id, author.label]));

  const planned = { total: plan.length, yapp: plan.reduce((sum, tip) => sum + tip.amount, 0n) };
  const byKind = plan.reduce((acc, tip) => ({ ...acc, [tip.kind]: (acc[tip.kind] ?? 0) + 1 }), {});
  console.log(
    `\nplan: ${planned.total} tips (${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(', ')}) ` +
    `moving ${planned.yapp} YAPP across ${authors.length} authors`
  );
  console.log(`      already confirmed: ${Object.keys(state.done).length}`);

  if (args.dryRun) {
    for (const tip of plan.slice(0, 15)) {
      console.log(`  [${tip.seq}] ${tip.sender} -> ${labels.get(tip.to)} ${tip.amount} YAPP ${tip.kind}` +
        `${tip.targetId ? ` ${tip.targetId.slice(0, 10)}…` : ''}${tip.message ? ` "${tip.message}"` : ''}`);
    }
    console.log(`  … ${Math.max(0, plan.length - 15)} more (dry run: nothing broadcast)`);
    process.exit(0);
  }

  // ---- SEND ------------------------------------------------------------------
  if (!args.verifyOnly) {
    console.log('\nPhase SEND');
    const actors = new Map();
    for (const personaIdx of [...new Set(plan.map((tip) => tip.sender))]) {
      actors.set(personaIdx, await tipperActor(chain, personaIdx));
    }
    const balances = await chain.yappBalances([...actors.values()].map((actor) => actor.ownerId), tokenId);

    // Resume: a tip whose transfer is already on the sender's `from` index was
    // broadcast by an earlier run that died before it could record it.
    for (const actor of actors.values()) {
      const sent = await chain.transfersFrom(tokenId, actor.ownerId);
      for (const tip of plan) {
        if (tip.sender !== actor.personaIdx || state.done[tip.seq]) continue;
        const proof = sent.find((row) => row.note === tip.note && row.to === tip.to && row.amount === tip.amount);
        if (proof) state.done[tip.seq] = { transferId: proof.id, at: new Date().toISOString(), resumed: true };
      }
    }
    saveState(args.state, state);

    let sentThisRun = 0;
    let movedThisRun = 0n;
    const budgetSkips = [];

    const runSender = async (personaIdx) => {
      const actor = actors.get(personaIdx);
      let balance = balances.get(actor.ownerId) ?? 0n;
      for (const tip of plan.filter((item) => item.sender === personaIdx)) {
        if (state.done[tip.seq]) continue;
        if (sentThisRun >= args.maxTips) return;
        if (balance - tip.amount < MIN_SENDER_BALANCE) {
          budgetSkips.push({ seq: tip.seq, handle: actor.handle, amount: tip.amount, balance });
          continue;
        }
        const outcome = await sendTip(chain, { socialId, tokenId, actor, tip });
        if (outcome.ok) {
          balance -= tip.amount;
          sentThisRun += 1;
          movedThisRun += tip.amount;
          state.done[tip.seq] = { transferId: outcome.transferId, at: new Date().toISOString() };
          delete state.failed[tip.seq];
          console.log(`  [${tip.seq}] ${actor.handle} -> ${labels.get(tip.to)} ${tip.amount} YAPP ` +
            `${tip.kind}${tip.targetId ? ` ${tip.targetId.slice(0, 8)}…` : ''} confirmed`);
        } else {
          const previous = state.failed[tip.seq]?.attempts ?? 0;
          state.failed[tip.seq] = { attempts: previous + 1, error: outcome.error.slice(0, 300) };
          console.log(`  [${tip.seq}] ${actor.handle} -> ${labels.get(tip.to)} ${tip.amount} YAPP UNCONFIRMED: ${outcome.error.slice(0, 140)}`);
          // The balance may have moved anyway; re-read rather than guess.
          const refreshed = await chain.yappBalances([actor.ownerId], tokenId);
          balance = refreshed.get(actor.ownerId) ?? balance;
        }
        saveState(args.state, state);
      }
    };

    // Sequential per sender (identity nonce), parallel across senders.
    await Promise.all([...actors.keys()].map((personaIdx) => runSender(personaIdx)));

    console.log(`\n  ${sentThisRun} tip(s) confirmed this run, ${movedThisRun} YAPP moved`);
    if (budgetSkips.length > 0) {
      console.log(`  ${budgetSkips.length} tip(s) skipped to keep senders above ${MIN_SENDER_BALANCE} YAPP:`);
      for (const skip of budgetSkips.slice(0, 10)) {
        console.log(`    [${skip.seq}] ${skip.handle} had ${skip.balance} YAPP, tip was ${skip.amount}`);
      }
    }
  }

  // ---- VERIFY ----------------------------------------------------------------
  console.log('\nPhase VERIFY (the app\'s own read: newest 100 incoming transfers, filtered by note)');
  const { byTarget, perAuthor } = await verifyTips(chain, tokenId, authors, labels);

  const top = [...byTarget.entries()].sort((a, b) => Number(b[1].total - a[1].total) || b[1].tips - a[1].tips);
  console.log(`\n  ${byTarget.size} target(s) carry proved tips. Most tipped:`);
  for (const [targetId, entry] of top.slice(0, 12)) {
    console.log(`    ${entry.total} YAPP from ${entry.tippers.size} tipper(s) over ${entry.tips} tip(s) — ` +
      `${entry.kind} ${targetId} (${labels.get(entry.author) ?? entry.author.slice(0, 8)})`);
    if (entry.kind === 'post') console.log(`      ${POST_LINK_BASE}${targetId}`);
  }

  console.log('\n  per author (this is what the profile "YAPP received" reads):');
  for (const author of perAuthor.sort((a, b) => Number(b.received - a.received))) {
    console.log(`    ${author.label.padEnd(18)} ${String(author.received).padStart(6)} YAPP over ${author.rows} transfer(s), ${author.noted} tip-noted — /user?id=${author.id}`);
  }

  const senderIds = new Map(plan.map((tip) => [tip.senderId, tip.sender]));
  const finalBalances = await chain.yappBalances([...senderIds.keys()], tokenId);
  console.log('\n  sender balances now:');
  for (const [senderId, personaIdx] of [...senderIds].sort((a, b) => a[1] - b[1])) {
    const spent = plan
      .filter((tip) => tip.senderId === senderId && state.done[tip.seq])
      .reduce((sum, tip) => sum + tip.amount, 0n);
    console.log(`    persona ${personaIdx}: ${finalBalances.get(senderId)} YAPP left, ${spent} tipped`);
  }

  const confirmed = Object.keys(state.done).length;
  const outstanding = plan.length - confirmed;
  console.log(`\n${confirmed}/${plan.length} planned tips confirmed on chain` +
    `${outstanding > 0 ? `, ${outstanding} outstanding (re-run to resume)` : ''}`);
  process.exit(outstanding === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
