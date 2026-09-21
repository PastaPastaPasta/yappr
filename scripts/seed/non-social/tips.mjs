/**
 * YAPP tips. A tip is not a Yappr document: it is a YAPP token transfer whose `publicNote` names the post (`lib/tip-
 * note.ts`). The proof is the `transfer` row Platform writes into the SYSTEM token-history contract because YAPP sets
 * `keepsTransferHistory` — which is what the app reads back, and how every tip here is confirmed: by finding that row
 * on the recipient's `to` index, never by trusting the SDK's throw/no-throw. Senders are seed-ledger personas holding
 * YAPP (transfers need their CRITICAL auth key), never spent below MIN_SENDER_BALANCE, and never a recipient — the
 * app refuses self-tips.
 */
import bs58 from 'bs58';
import { normalizeId, reportSelfTest } from '../../battery-lib.mjs';
import { POST_LINK_BASE, WAIT_MAYBE_LANDED, YAPP_TOKEN_POSITION, atLeastTopology, describeErr, profileContractId, readback, sleep, tokenCostFor } from '../seed-lib.mjs';
import {
  actorsFor, counts, createDocWriter, ensureTokens, entropySource, fakeId, loadCheckpoint, network, pick, printTable,
  rngFrom, saveCheckpoint, shuffled, weightedPick,
} from '../feature-seed-lib.mjs';

/**
 * On v9 and later a confirmed transfer is followed by a `tip` document CITING it,
 * which is what the app reads: the contract checks the citation's amount, sender
 * and payee against the transfer itself, so a seeded tip is a proved one rather
 * than a note the reader has to take on trust. Below v9 the transfer is all there
 * is, and the app shows no tips at all.
 */
const TIP_DOCTYPE = { post: 'tip', reply: 'tipReply' };

/** The system token-history contract — identical on every chain. */
const TOKEN_HISTORY_CONTRACT_ID = '43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF';
/** Same page cap the app reads with (`TIP_PAGE_LIMIT`); totals are "over the newest N". */
const TIP_PAGE_LIMIT = 100;
/** A sender is never spent below this, so its tips always look like a funded account's. */
const MIN_SENDER_BALANCE = 5n;
const SETTLE_MS = 3000;
const CONFIRM_ATTEMPTS = 5;

// Mirrors lib/tip-note.ts. Kept literal (as verify-tips.mjs does) so the seeder
// writes the encoding the app parses, not a re-export of the app's copy.
const TIP_NOTE_PREFIX = 'yappr:tip:v1:';
/** `publicNote` maxLength on the token-history `transfer` doctype. */
const TIP_NOTE_MAX_LENGTH = 2048;
/** Message cap the tip UI enforces. */
const TIP_MESSAGE_MAX_LENGTH = 280;

function encodeTipNote(kind, targetId, message) {
  const header = `${TIP_NOTE_PREFIX}${kind}:${targetId}`;
  const trimmed = (message ?? '').trim();
  if (!trimmed) return header;
  // Never sign a note the doctype would reject: the message is capped by the UI
  // limit and by the room the header leaves inside `maxLength`.
  const body = trimmed.slice(0, Math.min(TIP_MESSAGE_MAX_LENGTH, TIP_NOTE_MAX_LENGTH - header.length - 1)).trimEnd();
  return body ? `${header}\n${body}` : header;
}

function parseTipNote(note) {
  if (typeof note !== 'string' || !note.startsWith(TIP_NOTE_PREFIX)) return null;
  const newline = note.indexOf('\n');
  const rest = (newline === -1 ? note : note.slice(0, newline)).slice(TIP_NOTE_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator === -1) return null;
  const kind = rest.slice(0, separator);
  const targetId = rest.slice(separator + 1);
  if (kind !== 'post' && kind !== 'reply') return null;
  try {
    if (bs58.decode(targetId).length !== 32) return null;
  } catch { return null; }
  return { kind, targetId, message: newline === -1 ? '' : note.slice(newline + 1).trim() };
}

/** Tip sizes: heavily skewed small, with the occasional headline amount. */
const AMOUNT_WEIGHTS = [[1n, 34], [2n, 24], [5n, 24], [10n, 10], [25n, 6], [100n, 2]];
const MESSAGE_RATE = 0.6;
const MESSAGES = {
  post: ['this saved me an afternoon', 'best thing on my timeline today', 'thank you for writing it down',
    'more of this please', 'sending this to the rest of my team', 'have a coffee on me',
    'i have been looking for this explanation for weeks', 'the photos made it click', 'worth more than a like',
    'came back to this twice already', 'you are right and you should say it louder', 'for the effort, not just the take',
    'this is the post that got me to stop lurking', 'clean writeup, no fluff', 'i tried it and it actually worked',
    'small thanks for a big help', 'bookmarked, printed, taped to the wall', 'the last paragraph is the whole thing'],
  reply: ['this reply is better than most posts', 'thanks for taking the time to answer', 'exactly the nudge i needed',
    'you answered the question i was too embarrassed to ask', 'correct and kind, rare combination', 'fixed my problem in one line'],
  profile: ['no post in particular, just all of it', 'been reading you for months, finally paying up',
    'for the archive you have built', 'keep going', 'thanks for showing up every day', 'the timeline is better with you on it'],
};

/**
 * Lays out every tip. Pure: the same authors, senders and seed produce the same plan, so a persisted plan and a re-
 * plan agree. @param authors [{ id, label, posts: [id], replies: [id] }] @param senders [{ personaIdx, ownerId,
 * handle, budget }] budget = YAPP on hand
 */
function buildPlan({ authors, senders, seed, postTips, replyTips, profileTips, postsPerAuthor }) {
  if (authors.length === 0) throw new Error('no authors with posts to tip');
  if (senders.length === 0) throw new Error('no senders to tip from');
  const rng = rngFrom(seed);
  const tips = [];

  // 1. Targets: `postsPerAuthor` posts each, sampled so tipped posts spread over
  //    the author's recent history.
  const targets = authors.flatMap((author) => shuffled(rng, author.posts).slice(0, postsPerAuthor)
    .map((postId) => ({ kind: 'post', targetId: postId, to: author.id, label: author.label })));

  // 2. Tip counts per post. A few are "hot" (the strip is only interesting when
  //    some post has several tippers); the rest take one to three.
  const ordered = shuffled(rng, targets);
  const counts = new Map(ordered.map((target) => [target, 0]));
  let remaining = postTips;
  for (const [index, hot] of [8, 6, 5].entries()) {
    if (!ordered[index] || remaining < hot) break;
    counts.set(ordered[index], hot);
    remaining -= hot;
  }
  for (const target of ordered.slice(3)) {
    if (remaining <= 0) break;
    const take = Math.min(Number(weightedPick(rng, [[1, 45], [2, 32], [3, 23]])), remaining);
    counts.set(target, take);
    remaining -= take;
  }
  // Anything left over (fewer targets than tips) goes back onto the hot posts.
  for (let i = 0; remaining > 0; i = (i + 1) % ordered.length) {
    counts.set(ordered[i], counts.get(ordered[i]) + 1);
    remaining -= 1;
  }
  for (const target of ordered) for (let i = 0; i < counts.get(target); i++) tips.push({ ...target });

  // 3. Replies — the same note codec with kind `reply`, one per author.
  const seen = new Set();
  for (const candidate of shuffled(rng, authors.flatMap((author) => author.replies.map((replyId) =>
    ({ kind: 'reply', targetId: replyId, to: author.id, label: author.label }))))) {
    if (tips.filter((tip) => tip.kind === 'reply').length >= replyTips) break;
    if (seen.has(candidate.to)) continue;
    seen.add(candidate.to);
    tips.push(candidate);
  }

  // 4. Profile tips — a bare message, no target: a transfer that is NOT a tip
  //    note, which is how the app tells "YAPP received" from "tips on this post".
  for (const author of shuffled(rng, authors).slice(0, profileTips)) {
    tips.push({ kind: 'profile', targetId: null, to: author.id, label: author.label });
  }

  const hottestPostId = ordered[0]?.targetId ?? null;
  tips.forEach((tip, index) => {
    tip.seq = index;
    tip.amount = weightedPick(rng, AMOUNT_WEIGHTS);
    tip.message = (rng() < MESSAGE_RATE || tip.kind === 'profile') ? pick(rng, MESSAGES[tip.kind]) : '';
  });

  // 5. Senders, weighted by remaining budget so the richest personas carry the
  //    most tips and none drops below the reserve.
  const pool = senders.map((sender) => ({ ...sender, remaining: sender.budget - MIN_SENDER_BALANCE }));
  const firstTipperOfPost = new Map();
  const used = new Set();
  const unfunded = [];
  for (const tip of tips) {
    // The hottest post's SECOND tip is pinned to whoever sent its first, so the
    // strip reads "N YAPP by M people" with fewer people than rows.
    const pinned = tip.kind === 'post' && tip.targetId === hottestPostId ? firstTipperOfPost.get(tip.targetId) : undefined;
    const affordable = pool.filter((sender) => sender.ownerId !== tip.to && sender.remaining >= tip.amount);
    const pinnedChoice = affordable.filter((sender) => sender.personaIdx === pinned);
    const candidates = pinnedChoice.length > 0 ? pinnedChoice : affordable;
    if (candidates.length === 0) { unfunded.push(tip.seq); continue; }
    const chosen = weightedPick(rng, candidates.map((sender) => [sender, Number(sender.remaining)]));
    chosen.remaining -= tip.amount;
    tip.sender = chosen.personaIdx;
    tip.senderId = chosen.ownerId;
    // Only the FIRST tip on a post records its tipper, so the pin above applies
    // to exactly one follow-up tip rather than the whole thread.
    firstTipperOfPost.set(tip.targetId, tip.kind === 'post' && !firstTipperOfPost.has(tip.targetId) ? chosen.personaIdx : null);

    // (sender, recipient, amount, note) is the only handle a readback has on a
    // specific tip, so two identical ones would confirm each other.
    let unique = false;
    for (let attempt = 0; attempt < 64 && !unique; attempt++) {
      tip.note = tip.kind === 'profile' ? tip.message : encodeTipNote(tip.kind, tip.targetId, tip.message);
      const key = `${tip.senderId}|${tip.to}|${tip.amount}|${tip.note}`;
      if (!used.has(key)) { used.add(key); unique = true; break; }
      tip.message = pick(rng, MESSAGES[tip.kind]);
      if (attempt > 8) {
        chosen.remaining += tip.amount;
        tip.amount = weightedPick(rng, AMOUNT_WEIGHTS);
        chosen.remaining -= tip.amount;
      }
    }
    if (!unique) throw new Error(`could not make tip ${tip.seq} unique against the rest of the plan`);
  }
  return { tips: tips.filter((tip) => tip.senderId !== undefined), unfunded };
}

/**
 * The argument merge the live run uses. `...args` FIRST: it carries the plan sizes, but also `authors: null` and
 * `senders` as bare persona indexes, and a spread placed last would shadow the discovered ones with them.
 */
const planArgs = (args, authors, senders) => ({ ...args, authors, senders, seed: args.seed });

const planToJson = (tips) => tips.map((tip) => ({ ...tip, amount: tip.amount.toString() }));
const planFromJson = (tips) => tips.map((tip) => ({ ...tip, amount: BigInt(tip.amount) }));

async function run({ args, handle, battery, socialId }) {
  /** One page of `transfer` rows off a token-history index, newest first — the shape tip-history-service.ts reads with. */
  const transfers = async (tokenId, where, orderBy) => (await battery.queryDocs('transfer', {
    where: [['tokenId', '==', tokenId], ...where], orderBy: [['tokenId', 'asc'], ...orderBy, ['$createdAt', 'desc']], limit: TIP_PAGE_LIMIT,
  }, TOKEN_HISTORY_CONTRACT_ID)).map((row) => ({
    id: normalizeId(row.$id), from: normalizeId(row.$ownerId), to: normalizeId(row.toIdentityId),
    amount: BigInt(row.amount ?? 0), note: typeof row.publicNote === 'string' ? row.publicNote : '',
  }));
  const transfersTo = (tokenId, id) => transfers(tokenId, [['toIdentityId', '==', id]], [['toIdentityId', 'asc']]);
  const transfersFrom = (tokenId, id) => transfers(tokenId, [['$ownerId', '==', id]], [['$ownerId', 'asc']]);
  const yappBalances = async (ids, tokenId) => {
    const balances = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const result = await readback(handle, () => handle.sdk.tokens.balances(chunk, tokenId));
      for (const id of chunk) balances.set(id, (result instanceof Map ? result.get(id) : result?.[id]) ?? 0n);
    }
    return balances;
  };

  const tokenId = await readback(handle, () => handle.sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));
  console.log(`YAPP ${tokenId}`);
  const fresh = { authors: null, plan: null, done: {} };
  const state = args.replan ? { ...fresh } : loadCheckpoint(args.state,
    { network: network(), socialContractId: socialId, tokenId, seed: args.seed }, fresh);

  if (!state.plan) {
    // No "posts per author" aggregate exists, so walk the languageTimeline index
    // forward in time — the only index that pages the whole corpus — and tally
    // owners. Ties break on the identity id, so the ranking is stable.
    const tally = new Map();
    let cursor = 0;
    for (let page = 0; page < args.scanPages; page++) {
      const rows = await battery.queryDocs('post', {
        where: [['language', '==', args.language], ['$createdAt', '>', cursor]],
        orderBy: [['language', 'asc'], ['$createdAt', 'asc']], limit: 100,
      }, socialId);
      if (rows.length === 0) break;
      for (const row of rows) tally.set(normalizeId(row.$ownerId), (tally.get(normalizeId(row.$ownerId)) ?? 0) + 1);
      cursor = Number(rows[rows.length - 1].$createdAt);
      if (rows.length < 100) break;
    }
    const discovered = args.authors ?? [...tally.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, args.authorCount).map(([id]) => id);
    if (discovered.length === 0) throw new Error('no authors found on the social contract');

    const authors = [];
    for (const id of discovered) {
      const [profile] = await battery.queryDocs('profile', { where: [['$ownerId', '==', id]], orderBy: [['$ownerId', 'asc']], limit: 1 }, profileContractId());
      const byOwner = (docType) => battery.queryDocs(docType, {
        where: [['$ownerId', '==', id], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20,
      }, socialId).then((rows) => rows.map((row) => normalizeId(row.$id)));
      const [posts, replies] = await Promise.all([byOwner('post'), byOwner('reply')]);
      if (posts.length === 0) { console.log(`  skipping ${id} — no posts on the byOwner index`); continue; }
      authors.push({ id, label: profile?.displayName || id.slice(0, 8), posts, replies });
    }

    const actors = await actorsFor(battery, args.senders);
    // The plan is sized from what the senders HOLD, so they are topped up first.
    // The target is the mean planned tip (6.52 YAPP over AMOUNT_WEIGHTS) times
    // this run's tip count, split across the senders, plus the reserve.
    const meanTip = AMOUNT_WEIGHTS.reduce((t, [amount, weight]) => t + Number(amount) * weight, 0) / 100;
    const share = BigInt(Math.ceil((meanTip * (args.postTips + args.replyTips + args.profileTips)) / args.senders.length));
    await ensureTokens(battery, tokenId, actors, new Map(args.senders.map((idx) => [idx, share + MIN_SENDER_BALANCE])),
      { headroom: share / 4n });
    const balances = await yappBalances([...actors.values()].map((actor) => actor.ownerId), tokenId);
    const senders = [...actors.values()].map((actor) => ({
      personaIdx: actor.personaIdx, ownerId: actor.ownerId, handle: actor.label, budget: balances.get(actor.ownerId) ?? 0n,
    }));
    printTable([['sender', 18], ['YAPP on hand', -12]], senders.map((s) => [s.handle, String(s.budget)]), 'PLAN');
    const built = buildPlan(planArgs(args, authors, senders));
    if (built.unfunded.length > 0) console.log(`  ${built.unfunded.length} tip(s) dropped: no sender has the budget`);
    state.authors = authors.map(({ id, label }) => ({ id, label }));
    state.plan = planToJson(built.tips);
    saveCheckpoint(args.state, state);
  }

  const plan = planFromJson(state.plan);
  const labels = new Map(state.authors.map((author) => [author.id, author.label]));
  const byKind = plan.reduce((acc, tip) => ({ ...acc, [tip.kind]: (acc[tip.kind] ?? 0) + 1 }), {});
  console.log(`\nplan: ${counts(byKind, ` tips moving ${plan.reduce((t, tip) => t + tip.amount, 0n)} YAPP across `
    + `${state.authors.length} authors; ${Object.keys(state.done).length} already confirmed`)}`);

  if (!args.verifyOnly) {
    const actors = await actorsFor(battery, plan.map((tip) => tip.sender));
    const balances = await yappBalances([...actors.values()].map((actor) => actor.ownerId), tokenId);

    // Resume: a tip already on the sender's `from` index was broadcast by an
    // earlier run that died before it could record it.
    for (const actor of actors.values()) {
      const sent = await transfersFrom(tokenId, actor.ownerId);
      for (const tip of plan) {
        if (tip.sender !== actor.personaIdx || state.done[tip.seq]) continue;
        const proof = sent.find((row) => row.note === tip.note && row.to === tip.to && row.amount === tip.amount);
        if (proof) state.done[tip.seq] = { transferId: proof.id, resumed: true };
      }
    }
    saveCheckpoint(args.state, state);

    let sent = 0;
    let moved = 0n;
    const skips = [];
    // Sequential per sender (identity nonce), parallel across senders.
    await Promise.all([...actors.values()].map(async (actor) => {
      let balance = balances.get(actor.ownerId) ?? 0n;
      for (const tip of plan.filter((item) => item.sender === actor.personaIdx)) {
        if (state.done[tip.seq] || sent >= args.maxTips) continue;
        if (balance - tip.amount < MIN_SENDER_BALANCE) { skips.push([tip.seq, actor.label, String(tip.amount), String(balance)]); continue; }
        let reported = null;
        try {
          await actor.lock(() => handle.sdk.tokens.transfer({
            dataContractId: socialId, tokenPosition: YAPP_TOKEN_POSITION, senderId: actor.ownerId,
            recipientId: tip.to, amount: tip.amount, publicNote: tip.note, identityKey: actor.identityKey, signer: actor.signer,
          }));
        } catch (error) {
          // A 504 on the confirmation wait does not mean the transfer was refused.
          reported = describeErr(error);
          if (!WAIT_MAYBE_LANDED.test(reported)) console.log(`     tip ${tip.seq}: transfer reported "${reported.slice(0, 120)}"`);
        }
        let proof = null;
        for (let attempt = 0; attempt < CONFIRM_ATTEMPTS && !proof; attempt++) {
          await sleep(SETTLE_MS);
          proof = (await transfersTo(tokenId, tip.to)).find((row) => row.note === tip.note && row.from === actor.ownerId && row.amount === tip.amount);
        }
        if (proof) {
          balance -= tip.amount;
          sent += 1;
          moved += tip.amount;
          state.done[tip.seq] = { transferId: proof.id };
        } else {
          console.log(`  [${tip.seq}] ${actor.label} -> ${labels.get(tip.to)} ${tip.amount} YAPP UNCONFIRMED: `
            + `${(reported ?? 'no transfer row carries this note').slice(0, 140)}`);
          // The transfer may have moved the balance anyway; re-read rather than
          // size the rest of this sender's tips against a stale number.
          balance = (await yappBalances([actor.ownerId], tokenId)).get(actor.ownerId) ?? balance;
        }
        saveCheckpoint(args.state, state);
      }
    }));
    console.log(`\n  ${sent} tip(s) confirmed this run, ${moved} YAPP moved`);
    if (skips.length > 0) {
      printTable([['tip', -4], ['sender', 18], ['amount', -6], ['balance', -8]], skips.slice(0, 10),
        `${skips.length} tip(s) skipped to keep senders above ${MIN_SENDER_BALANCE} YAPP`);
    }
  }

  // ---- VERIFY: the app's own read — newest 100 incoming transfers, filtered by note.
  const byTarget = new Map();
  const perAuthor = [];
  for (const author of state.authors) {
    const rows = await transfersTo(tokenId, author.id);
    let received = 0n;
    let noted = 0;
    for (const row of rows) {
      received += row.amount;
      const note = parseTipNote(row.note);
      if (!note) continue;
      noted += 1;
      const entry = byTarget.get(note.targetId) ?? { kind: note.kind, author: author.id, total: 0n, tips: 0, tippers: new Set() };
      entry.total += row.amount;
      entry.tips += 1;
      entry.tippers.add(row.from);
      byTarget.set(note.targetId, entry);
    }
    perAuthor.push({ ...author, rows: rows.length, received, noted });
  }
  printTable([['YAPP', -6], ['tippers', -7], ['tips', -4], ['kind', 7], ['target', 46], ['author', 18]],
    [...byTarget.entries()].sort((a, b) => Number(b[1].total - a[1].total) || b[1].tips - a[1].tips).slice(0, 12)
      .map(([targetId, e]) => [String(e.total), e.tippers.size, e.tips, e.kind,
        e.kind === 'post' ? `${POST_LINK_BASE}${targetId}` : targetId, labels.get(e.author)]),
    `VERIFY — ${byTarget.size} target(s) carry proved tips (most tipped first)`);
  printTable([['author', 18], ['YAPP received', -13], ['transfers', -9], ['tip-noted', -9], ['profile', 46]],
    perAuthor.sort((a, b) => Number(b.received - a.received))
      .map((a) => [a.label, String(a.received), a.rows, a.noted, `/user?id=${a.id}`]),
    'per author (what the profile "YAPP received" reads)');

  const confirmed = Object.keys(state.done).length;
  console.log(`\n${confirmed}/${plan.length} planned tips confirmed on chain; checkpoint ${args.state}`);
  return confirmed === plan.length ? 0 : 1;
}

/** Deterministic stand-in authors and senders, so the planner runs with no chain. */
function fixture(args) {
  return {
    authors: Array.from({ length: args.authorCount }, (_, a) => ({
      id: fakeId(`author-${a}`), label: `Author ${a}`,
      posts: Array.from({ length: 20 }, (_, p) => fakeId(`post-${a}-${p}`)),
      replies: Array.from({ length: 20 }, (_, r) => fakeId(`reply-${a}-${r}`)),
    })),
    senders: args.senders.map((personaIdx, i) => ({
      personaIdx, ownerId: fakeId(`sender-${personaIdx}`), handle: `tipper-${personaIdx}`, budget: i < 2 ? 135n + BigInt(i) * 130n : 400n,
    })),
  };
}

function dryRun(plan, args) {
  const byKind = plan.tips.reduce((acc, tip) => ({ ...acc, [tip.kind]: (acc[tip.kind] ?? 0) + 1 }), {});
  console.log('authors and senders are deterministic stand-ins offline; the live run discovers the busiest real authors.');
  console.log(counts(byKind, ` tips moving ${plan.tips.reduce((t, tip) => t + tip.amount, 0n)} YAPP, seed ${args.seed}`));
  printTable([['tip', -4], ['sender', -7], ['recipient', 10], ['YAPP', -5], ['kind', 8], ['target', 12], ['message', 44]],
    plan.tips.slice(0, 15).map((tip) => [tip.seq, tip.sender, tip.label, String(tip.amount), tip.kind,
      tip.targetId ? `${tip.targetId.slice(0, 10)}…` : '—', tip.message || '—']));
  console.log(`  … ${Math.max(0, plan.tips.length - 15)} more`);
  return 0;
}

/** Pure planner invariants against synthetic inputs. */
function selfTest(args) {
  const { authors, senders } = fixture({ ...args, authorCount: 10, senders: [240, 241, 310, 311, 312, 313, 314, 315] });
  const options = planArgs({ ...args, seed: 'self-test' }, authors, senders);
  // The live run's merge must not let `defaults.authors = null` win (it did once,
  // and only the fixture-based dry run hid it).
  const merged = planArgs({ ...args, authors: null, senders: [1, 2] }, authors, senders);
  const plan = buildPlan(options);
  const kinds = plan.tips.reduce((acc, tip) => ({ ...acc, [tip.kind]: (acc[tip.kind] ?? 0) + 1 }), {});
  const targeted = plan.tips.filter((tip) => tip.kind !== 'profile');
  const notes = targeted.map((tip) => parseTipNote(tip.note));
  const spend = new Map();
  for (const tip of plan.tips) spend.set(tip.sender, (spend.get(tip.sender) ?? 0n) + tip.amount);
  const perTarget = new Map();
  for (const tip of plan.tips.filter((tip) => tip.kind === 'post')) {
    const entry = perTarget.get(tip.targetId) ?? { tips: 0, senders: new Set() };
    entry.tips += 1;
    entry.senders.add(tip.sender);
    perTarget.set(tip.targetId, entry);
  }
  const perAuthor = new Map();
  for (const tip of plan.tips) perAuthor.set(tip.to, (perAuthor.get(tip.to) ?? 0) + 1);
  const amounts = plan.tips.map((tip) => Number(tip.amount));
  const small = amounts.filter((amount) => amount <= 5).length;
  const withMessage = plan.tips.filter((tip) => tip.message).length;
  const json = (built) => JSON.stringify(planToJson(built.tips));
  return reportSelfTest('the tips planner', [
    [`plans 120 tips (${plan.tips.length})`, plan.tips.length === 120],
    [`100 post / 10 reply / 10 profile (${JSON.stringify(kinds)})`, kinds.post === 100 && kinds.reply === 10 && kinds.profile === 10],
    [`every tip has a funded sender (${plan.unfunded.length} unfunded)`, plan.unfunded.length === 0],
    ['no tip is a self-tip', plan.tips.every((tip) => tip.senderId !== tip.to)],
    ['every (sender, recipient, amount, note) tuple is unique',
      new Set(plan.tips.map((tip) => `${tip.senderId}|${tip.to}|${tip.amount}|${tip.note}`)).size === plan.tips.length],
    ['every targeted tip note parses as a v1 tip note', notes.every((note) => note !== null)],
    ['every note names its own target', targeted.every((tip, i) => notes[i].targetId === tip.targetId && notes[i].kind === tip.kind)],
    ['profile tips carry a bare message, not a tip note',
      plan.tips.filter((tip) => tip.kind === 'profile').every((tip) => parseTipNote(tip.note) === null)],
    [`no sender is planned below ${MIN_SENDER_BALANCE} YAPP`,
      options.senders.every((sender) => (spend.get(sender.personaIdx) ?? 0n) <= sender.budget - MIN_SENDER_BALANCE)],
    ['at least one post carries 5+ tips', [...perTarget.values()].sort((a, b) => b.tips - a.tips)[0].tips >= 5],
    ['some post is tipped twice by one sender', [...perTarget.values()].some((entry) => entry.senders.size < entry.tips)],
    [`tips are spread over at most 40 posts (${perTarget.size})`, perTarget.size <= 40],
    [`no author receives enough tips to push older ones off the ${TIP_PAGE_LIMIT}-row page`,
      [...perAuthor.values()].every((count) => count < TIP_PAGE_LIMIT / 2)],
    [`amounts skew small (${small}/${amounts.length} are <= 5 YAPP)`, small / amounts.length > 0.7],
    ['some tips are headline-sized', amounts.some((amount) => amount >= 25)],
    [`most tips carry a message (${withMessage}/${plan.tips.length})`, withMessage / plan.tips.length > 0.5],
    ['the same seed plans exactly the same tips', json(buildPlan(options)) === json(plan)],
    ['a different seed plans different tips', json(buildPlan({ ...options, seed: 'self-test-2' })) !== json(plan)],
    ['the plan arguments keep the discovered authors and senders, not the defaults',
      merged.authors === authors && merged.senders === senders],
  ]);
}

export default {
  name: 'tips',
  state: '.seed-tips.local.json',
  contractEnv: [],
  defaults: {
    seed: 'yappr-tips-v1', senders: [240, 241, 310, 311, 312, 313, 314, 315], authors: null,
    // 80 pages covers the whole seeded corpus today, so the ranking is the real
    // busiest-author list rather than the busiest of an arbitrary prefix.
    authorCount: 12, scanPages: 80, language: 'en', replan: false,
    postTips: 100, replyTips: 10, profileTips: 10, postsPerAuthor: 4, maxTips: Infinity,
  },
  flags: {
    '--replan': ['replan', 'bool'], '--senders': ['senders', 'numlist'], '--authors': ['authors', 'list'], '--author-count': ['authorCount', 'number'],
    '--scan-pages': ['scanPages', 'number'], '--post-tips': ['postTips', 'number'], '--reply-tips': ['replyTips', 'number'],
    '--profile-tips': ['profileTips', 'number'], '--posts-per-author': ['postsPerAuthor', 'number'], '--max-tips': ['maxTips', 'number'],
  },
  plan: (args) => buildPlan({ ...args, ...fixture(args) }),
  dryRun,
  selfTest,
  get extraContracts() { return [profileContractId(), TOKEN_HISTORY_CONTRACT_ID]; },
  run,
};
