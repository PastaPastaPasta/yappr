/**
 * Corpus executor: replays a `corpus.<name>.jsonl` op stream (see
 * CORPUS_FORMAT.md) against the devnet v4 social contract as the seed
 * identities provisioned by provision-seed-identities.mjs.
 *
 * Execution model:
 *  - per-author ops run STRICTLY SEQUENTIALLY in corpus line order (one
 *    in-flight state transition per identity — the identity contract nonce
 *    forbids more);
 *  - different authors run in parallel, capped by a global semaphore
 *    (--concurrency, default 10 in-flight state transitions);
 *  - cross-author ordering is by ref availability only: an op whose target ref
 *    has not materialized yet parks until the defining author produces it.
 *    Refs always point at earlier corpus lines, so the dependency graph is
 *    acyclic and this cannot deadlock.
 *
 * Resumability: every executed line is appended to the JSON-lines checkpoint
 * `.seed-progress.local.json` together with the ref → {id, ownerId, hashtag}
 * map entries; a re-run folds the journal, skips completed lines, resolves
 * refs from the checkpoint, and retries failures. Nothing is ever duplicated:
 * documents are built with per-attempt-stable entropy, so even a retry of a
 * broadcast that DID land reads back as the same document.
 *
 * Devnet quirks handled (from scripts/verify-v4.mjs):
 *  - DAPI 504 on the confirmation wait ≠ rejection — readback decides;
 *  - indexOnly like/likeReply creates can THROW post-broadcast even when the
 *    write landed (no confirmed Document comes back) — acceptance is decided
 *    by an entry-existence query, never by throw/no-throw;
 *  - quorum rotations kill the SDK ("Quorum not found in cache", "no available
 *    addresses") — full reconnect behind a proxy handle;
 *  - nonce desync → reconnect (fresh nonce cache) and retry.
 *
 * Run:
 *   NETWORK=devnet node scripts/seed/run-seeder.mjs --personas <file> --corpus <file> \
 *     [--concurrency 10] [--max-ops N]
 *   node scripts/seed/run-seeder.mjs --self-test
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { IdentitySigner, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import {
  CRITICAL_AUTH_KEY_ID,
  DUPLICATE_UNIQUE,
  NONCE_DESYNC,
  PROGRESS_FILE,
  REPORT_FILE,
  RETRYABLE,
  TOKEN_COST,
  TRANSPORT_COLLAPSE,
  WAIT_MAYBE_LANDED,
  YAPP_TOKEN_POSITION,
  appendProgress,
  buildDocument,
  corpusYappCost,
  createSdkHandle,
  describeErr,
  expandedContentLength,
  ledgerEntry,
  loadLedger,
  loadPersonas,
  loadProgress,
  network,
  parseCorpus,
  paymentInfo,
  randomEntropy,
  readback,
  sleep,
  socialContractId,
  stateRank,
  substituteLinks,
  wifFromHex,
} from './seed-lib.mjs';

const SDK_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
/** Reads settle behind the write quorum; poll cadence for landed-or-not checks. */
const SETTLE_MS = 3_000;
const SETTLE_POLLS = 3;
/** How long an op may park waiting for its target ref before giving up. */
const DEP_WAIT_TIMEOUT_MS = 15 * 60_000;

// ---- CLI ------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { personas: null, corpus: null, concurrency: 10, maxOps: Infinity, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--personas': args.personas = argv[++i]; break;
      case '--corpus': args.corpus = argv[++i]; break;
      case '--concurrency': args.concurrency = Number(argv[++i]); break;
      case '--max-ops': args.maxOps = Number(argv[++i]); break;
      case '--self-test': args.selfTest = true; break;
      default: throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  if (!args.selfTest) {
    if (!args.personas || !args.corpus) throw new Error('--personas and --corpus are required');
    if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer');
    if (args.maxOps !== Infinity && (!Number.isInteger(args.maxOps) || args.maxOps < 1)) throw new Error('--max-ops must be a positive integer');
  }
  return args;
}

// ---- Scheduling primitives ---------------------------------------------------------

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }
  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }
  release() {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {}); // a rejected dependency must not crash the process
  return { promise, resolve, reject };
}

/**
 * The scheduling engine, network-free and executor-injected so the self-test
 * can drive it. `executor(op, refs)` performs one op and returns the ref
 * record to publish ({kind, id, ownerId, hashtag}) or null for ops that
 * define no ref; it throws on permanent failure.
 *
 * Returns aggregate results; appends every executed line through `journal`.
 */
export async function runCorpus({ ops, executor, concurrency, progress, journal, maxOps = Infinity, log = () => {} }) {
  const refDeferreds = new Map();
  const refFor = (ref) => {
    if (!refDeferreds.has(ref)) refDeferreds.set(ref, deferred());
    return refDeferreds.get(ref);
  };
  for (const [ref, record] of progress.refs) refFor(ref).resolve(record);

  const semaphore = new Semaphore(concurrency);
  const abort = deferred();
  let aborted = false;
  let executed = 0;
  const results = { done: 0, failed: 0, skipped: 0, deferredOps: 0, perType: {}, errors: [] };
  const bump = (type, field, ms = 0) => {
    results.perType[type] ??= { done: 0, failed: 0, totalMs: 0 };
    results.perType[type][field] += 1;
    results.perType[type].totalMs += ms;
  };

  const dependencies = (op) => {
    const needed = [];
    if (op.type === 'quote') needed.push(op.quotedRef);
    if (op.type === 'reply') needed.push(op.rootRef, op.parentRef);
    if (['like', 'likeReply', 'repost', 'bookmark'].includes(op.type)) needed.push(op.targetRef);
    if (typeof op.content === 'string') {
      for (const match of op.content.matchAll(/\{\{link:([A-Za-z0-9_-]+)\}\}/g)) needed.push(match[1]);
    }
    return [...new Set(needed)];
  };

  const byAuthor = new Map();
  for (const op of ops) {
    if (!byAuthor.has(op.author)) byAuthor.set(op.author, []);
    byAuthor.get(op.author).push(op);
  }

  const workers = [...byAuthor.entries()].map(async ([author, queue]) => {
    for (const op of queue) {
      if (aborted) return;
      if (progress.completed.has(op.line)) {
        results.skipped += 1;
        continue; // its ref (if any) was already resolved from the checkpoint
      }
      // Park until every referenced target has materialized.
      const needs = dependencies(op);
      let deps;
      let depTimer;
      try {
        const wait = Promise.all(needs.map((ref) => refFor(ref).promise));
        const timeout = new Promise((_, reject) => {
          depTimer = setTimeout(() => reject(new Error(`dependency wait timed out for [${needs.join(', ')}]`)), DEP_WAIT_TIMEOUT_MS);
        });
        timeout.catch(() => {}); // losing the race must not surface as an unhandled rejection
        deps = await Promise.race([wait, abort.promise.then(() => 'aborted'), timeout]);
      } catch (e) {
        const record = { line: op.line, status: 'failed', type: op.type, author, error: `dependency failed: ${e.message ?? e}` };
        journal(record);
        results.failed += 1;
        results.errors.push(record);
        bump(op.type, 'failed');
        if (op.ref) refFor(op.ref).reject(new Error(`line ${op.line} failed`));
        continue;
      } finally {
        clearTimeout(depTimer);
      }
      if (deps === 'aborted' || aborted) return;
      if (executed >= maxOps) {
        aborted = true;
        abort.resolve();
        log(`--max-ops ${maxOps} reached — stopping (resume with the same command)`);
        return;
      }
      executed += 1;

      await semaphore.acquire();
      const startedAt = Date.now();
      try {
        const refRecord = await executor(op);
        const record = {
          line: op.line,
          status: 'done',
          type: op.type,
          author,
          ...(op.ref ? { ref: op.ref, ...refRecord } : {}),
        };
        journal(record);
        progress.completed.set(op.line, record);
        results.done += 1;
        bump(op.type, 'done', Date.now() - startedAt);
        if (op.ref) refFor(op.ref).resolve(refRecord);
      } catch (e) {
        const record = { line: op.line, status: 'failed', type: op.type, author, error: describeErr(e).slice(0, 400) };
        journal(record);
        results.failed += 1;
        results.errors.push(record);
        bump(op.type, 'failed', Date.now() - startedAt);
        log(`line ${op.line} (${op.type} by ${author}) FAILED: ${record.error.slice(0, 180)}`);
        if (op.ref) refFor(op.ref).reject(new Error(`line ${op.line} failed`));
      } finally {
        semaphore.release();
      }
    }
  });

  await Promise.all(workers);
  results.deferredOps = ops.length - results.done - results.failed - results.skipped;
  return results;
}

// ---- Devnet executor ----------------------------------------------------------------

/** "Does <owner>'s indexOnly entry for this target exist?" — the acceptance read. */
async function entryExists(handle, contractId, docType, keyField, keyValue, ownerId) {
  return readback(handle, async () => {
    const result = await handle.sdk.documents.query({
      dataContractId: contractId,
      documentTypeName: docType,
      where: [
        [keyField, '==', keyValue],
        ['$ownerId', '==', ownerId],
      ],
    });
    return result.size > 0;
  });
}

/** Duplicate-tolerant op kinds: a 40105 means the end state already holds. */
const DUPLICATE_IS_SUCCESS = new Set(['like', 'likeReply', 'follow', 'bookmark', 'repost']);

function buildExecutor({ handle, contractId, actors, progressRefs }) {
  const bytes = (base58) => bs58.decode(base58);
  const resolveRef = (ref) => {
    const record = progressRefs.get(ref);
    if (!record) throw new Error(`ref "${ref}" not materialized (checkpoint out of sync)`);
    return record;
  };

  /** Maps one corpus op to {docType, data, tokenCost, refRecord, accepted}. */
  function planOp(op) {
    const actor = actors.get(op.author);
    if (!actor) throw new Error(`author ${op.author} has no provisioned identity`);
    const ownerBytes = bytes(actor.ownerId);
    const finalContent = typeof op.content === 'string'
      ? substituteLinks(op.content, (ref) => resolveRef(ref).id)
      : undefined;
    if (finalContent !== undefined && finalContent.length > 500) {
      throw new Error(`line ${op.line}: content is ${finalContent.length} chars after link substitution (max 500)`);
    }

    switch (op.type) {
      case 'post':
      case 'quote': {
        const quoted = op.type === 'quote' ? resolveRef(op.quotedRef) : null;
        return {
          docType: 'post',
          tokenCost: TOKEN_COST.post,
          data: {
            content: finalContent ?? '',
            language: 'en',
            author: ownerBytes,
            hashtag: op.hashtag ?? '',
            ...(op.mediaUrl ? { mediaUrl: op.mediaUrl } : {}),
            ...(op.sensitive !== undefined ? { sensitive: op.sensitive } : {}),
            ...(quoted ? { quotedPostId: bytes(quoted.id), quotedPostOwnerId: bytes(quoted.ownerId) } : {}),
          },
          refRecord: (id) => ({ kind: 'post', id, ownerId: actor.ownerId, hashtag: op.hashtag ?? '' }),
        };
      }
      case 'reply': {
        const root = resolveRef(op.rootRef);
        const parent = resolveRef(op.parentRef);
        return {
          docType: 'reply',
          tokenCost: TOKEN_COST.reply,
          data: {
            content: finalContent ?? '',
            rootPostId: bytes(root.id),
            parentOwnerId: bytes(parent.ownerId),
            author: ownerBytes,
            ...(parent.kind === 'reply' ? { replyToReplyId: bytes(parent.id) } : {}),
            ...(op.mediaUrl ? { mediaUrl: op.mediaUrl } : {}),
          },
          refRecord: (id) => ({ kind: 'reply', id, ownerId: actor.ownerId, hashtag: '' }),
        };
      }
      case 'like': {
        const target = resolveRef(op.targetRef);
        return {
          docType: 'like',
          tokenCost: TOKEN_COST.like,
          indexOnly: true,
          // propertyAgreement: hashtag and postAuthor MUST equal the post's
          // values or the create dies with consensus error 40127.
          data: { postId: bytes(target.id), hashtag: target.hashtag ?? '', postAuthor: bytes(target.ownerId) },
          accepted: () => entryExists(handle, contractId, 'like', 'postId', target.id, actor.ownerId),
        };
      }
      case 'likeReply': {
        const target = resolveRef(op.targetRef);
        return {
          docType: 'likeReply',
          tokenCost: TOKEN_COST.likeReply,
          indexOnly: true,
          data: { replyId: bytes(target.id), replyAuthor: bytes(target.ownerId) },
          accepted: () => entryExists(handle, contractId, 'likeReply', 'replyId', target.id, actor.ownerId),
        };
      }
      case 'repost': {
        const target = resolveRef(op.targetRef);
        return {
          docType: 'repost',
          tokenCost: TOKEN_COST.repost,
          data: { postId: bytes(target.id), postOwnerId: bytes(target.ownerId) },
        };
      }
      case 'follow': {
        const target = actors.get(op.target);
        if (!target) throw new Error(`follow target ${op.target} has no provisioned identity`);
        return { docType: 'follow', data: { followingId: bytes(target.ownerId) } };
      }
      case 'bookmark': {
        const target = resolveRef(op.targetRef);
        return { docType: 'bookmark', data: { postId: bytes(target.id) } };
      }
      default:
        throw new Error(`unhandled op type ${op.type}`);
    }
  }

  /**
   * One op, end to end. The document is built ONCE (stable entropy → stable
   * $id), so a retry of a broadcast that DID land converges on the same
   * document instead of duplicating it. Acceptance is decided by the chain:
   * readback by id for stored doctypes, entry-existence for indexOnly ones.
   */
  return async function executeOp(op) {
    const actor = actors.get(op.author);
    const plan = planOp(op);
    const { document, id } = buildDocument({
      contractId,
      docType: plan.docType,
      ownerId: actor.ownerId,
      data: plan.data,
      entropy: randomEntropy(),
    });
    const accepted = plan.accepted ?? (async () =>
      (await readback(handle, () => handle.sdk.documents.get(contractId, plan.docType, id))) != null);

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await handle.sdk.documents.create({
          document,
          identityKey: actor.identityKey,
          signer: actor.signer,
          ...paymentInfo(plan.tokenCost),
        });
        if (!plan.indexOnly) return plan.refRecord ? plan.refRecord(id) : null;
        // indexOnly: a clean return still gets one confirming read (cheap, and
        // the SDK's post-broadcast behavior for these types is unreliable).
        if (await accepted()) return plan.refRecord ? plan.refRecord(id) : null;
        lastError = new Error('create returned but the entry is not on chain');
      } catch (e) {
        lastError = e;
        const text = describeErr(e);
        if (DUPLICATE_UNIQUE.test(text) && DUPLICATE_IS_SUCCESS.has(op.type)) {
          return plan.refRecord ? plan.refRecord(id) : null; // end state already holds
        }
        if (TRANSPORT_COLLAPSE.test(text)) {
          try { await handle.reconnect(text); } catch { /* next attempt retries the rebuild */ }
        } else if (NONCE_DESYNC.test(text)) {
          // the only cure for a stale identity-contract-nonce cache is a fresh SDK
          try { await handle.reconnect(`nonce desync: ${text.slice(0, 80)}`); } catch { /* ditto */ }
        }
        // The broadcast may have landed even though the call threw (504 on the
        // confirmation wait, post-broadcast indexOnly throw, retried duplicate).
        const settlePolls = WAIT_MAYBE_LANDED.test(text) || plan.indexOnly ? SETTLE_POLLS : 1;
        for (let poll = 0; poll < settlePolls; poll++) {
          await sleep(SETTLE_MS);
          try {
            if (await accepted()) return plan.refRecord ? plan.refRecord(id) : null;
          } catch (readError) {
            lastError = readError;
          }
        }
        const retryable =
          TRANSPORT_COLLAPSE.test(text) || NONCE_DESYNC.test(text) || RETRYABLE.test(text) || WAIT_MAYBE_LANDED.test(text);
        if (!retryable) {
          const isConsensus = /code=4\d{4}/.test(text) || /consensus/i.test(text);
          if (isConsensus) throw e; // Platform said no — retrying cannot help
        }
      }
      await sleep(2_000 * attempt);
    }
    throw lastError ?? new Error('op failed after retries');
  };
}

// ---- Actors ---------------------------------------------------------------------------

async function buildActors(handle, ledger, personas, ops) {
  const authors = new Set(ops.map((op) => op.author));
  for (const op of ops) if (op.type === 'follow') authors.add(op.target);
  const actors = new Map();
  for (const idx of authors) {
    const entry = ledgerEntry(ledger, idx);
    if (!entry || !entry.identityId || stateRank(entry.state) < stateRank('registered')) {
      throw new Error(`persona ${idx} is not provisioned (run provision-seed-identities.mjs first)`);
    }
    if (entry.state !== 'ready') {
      console.warn(`  warning: persona ${idx} (${entry.handle}) is in state "${entry.state}" — token-priced ops may fail`);
    }
    const identity = await readback(handle, () => handle.sdk.identities.fetch(entry.identityId));
    if (!identity) throw new Error(`identity ${entry.identityId} (persona ${idx}) not found on this devnet`);
    const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
    if (!identityKey) throw new Error(`identity ${entry.identityId} has no key ${CRITICAL_AUTH_KEY_ID}`);
    const authKey = entry.identityKeys.find((key) => key.keyId === CRITICAL_AUTH_KEY_ID);
    if (!authKey) throw new Error(`ledger entry for persona ${idx} has no key ${CRITICAL_AUTH_KEY_ID}`);
    const signer = new IdentitySigner();
    signer.addKeyFromWif(wifFromHex(authKey.privateKeyHex));
    actors.set(idx, { personaIdx: idx, ownerId: entry.identityId, handle: entry.handle, identityKey, signer });
  }
  return actors;
}

async function snapshotBalances(handle, actors, tokenId) {
  const ids = [...actors.values()].map((actor) => actor.ownerId);
  const credits = await readback(handle, () => handle.sdk.identities.balances(ids));
  const yapp = await readback(handle, () => handle.sdk.tokens.balances(ids, tokenId));
  const get = (map, key) => ((map instanceof Map ? map.get(key) : map?.[key]) ?? 0n);
  const out = new Map();
  for (const actor of actors.values()) {
    out.set(actor.personaIdx, { credits: get(credits, actor.ownerId), yapp: get(yapp, actor.ownerId) });
  }
  return out;
}

// ---- Report ----------------------------------------------------------------------------

function buildReport({ args, ops, stats, results, before, after, actors, wallClockMs }) {
  const perType = Object.fromEntries(
    Object.entries(results.perType).map(([type, r]) => [
      type,
      { done: r.done, failed: r.failed, avgMs: r.done + r.failed > 0 ? Math.round(r.totalMs / (r.done + r.failed)) : 0 },
    ])
  );
  const identities = [...actors.values()].map((actor) => {
    const b = before.get(actor.personaIdx) ?? { credits: 0n, yapp: 0n };
    const a = after.get(actor.personaIdx) ?? { credits: 0n, yapp: 0n };
    return {
      personaIdx: actor.personaIdx,
      handle: actor.handle,
      identityId: actor.ownerId,
      creditsBefore: String(b.credits),
      creditsAfter: String(a.credits),
      creditsConsumed: String(b.credits - a.credits),
      yappBefore: String(b.yapp),
      yappAfter: String(a.yapp),
      yappConsumed: String(b.yapp - a.yapp),
    };
  });
  const totalCreditsConsumed = identities.reduce((sum, i) => sum + BigInt(i.creditsConsumed), 0n);
  const totalYappConsumed = identities.reduce((sum, i) => sum + BigInt(i.yappConsumed), 0n);
  const executedOps = results.done + results.failed;
  return {
    network: network(),
    contractId: socialContractId(),
    corpus: args.corpus,
    startedAt: new Date(Date.now() - wallClockMs).toISOString(),
    finishedAt: new Date().toISOString(),
    wallClockMs,
    corpusOps: ops.length,
    corpusStats: stats,
    executed: executedOps,
    done: results.done,
    failed: results.failed,
    skippedAlreadyComplete: results.skipped,
    deferredByMaxOps: results.deferredOps,
    opsPerSec: wallClockMs > 0 ? Number(((executedOps * 1000) / wallClockMs).toFixed(2)) : 0,
    perType,
    identities,
    totalCreditsConsumed: String(totalCreditsConsumed),
    totalYappConsumed: String(totalYappConsumed),
    errors: results.errors,
  };
}

function printSummary(report) {
  console.log('\n---- seed run summary ----');
  console.log(`ops: ${report.done} done, ${report.failed} failed, ${report.skippedAlreadyComplete} skipped (checkpoint), ${report.deferredByMaxOps} deferred`);
  console.log(`wall clock: ${(report.wallClockMs / 1000).toFixed(1)}s  overall ${report.opsPerSec} ops/s`);
  for (const [type, r] of Object.entries(report.perType)) {
    console.log(`  ${type.padEnd(10)} done=${String(r.done).padStart(5)}  failed=${String(r.failed).padStart(4)}  avg=${r.avgMs}ms`);
  }
  console.log(`credits consumed: ${report.totalCreditsConsumed}  YAPP consumed: ${report.totalYappConsumed}`);
  for (const identity of report.identities) {
    console.log(
      `  ${String(identity.personaIdx).padEnd(4)} ${identity.handle.padEnd(18)} credits ${identity.creditsBefore} → ${identity.creditsAfter}  ` +
      `YAPP ${identity.yappBefore} → ${identity.yappAfter}`
    );
  }
  if (report.errors.length > 0) {
    console.log(`\n${report.errors.length} failure(s):`);
    for (const error of report.errors.slice(0, 20)) console.log(`  line ${error.line} (${error.type}): ${error.error.slice(0, 160)}`);
    if (report.errors.length > 20) console.log(`  … and ${report.errors.length - 20} more (see ${REPORT_FILE})`);
  }
  console.log(`report written to ${REPORT_FILE}`);
}

// ---- Self-test (pure: parsing, ref resolution, scheduling — no network) -----------------

async function selfTest() {
  let failures = 0;
  const check = (name, condition, detail = '') => {
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures += 1;
  };

  const personas = [
    { idx: 0, handle: 'alice42', displayName: 'Alice', avatarSeed: 'a' },
    { idx: 1, handle: 'bob37', displayName: 'Bob', avatarSeed: 'b' },
    { idx: 2, handle: 'carol88', displayName: 'Carol', avatarSeed: 'c' },
  ];
  const corpus = [
    '{"type":"post","ref":"p001","author":0,"content":"hello devnet","hashtag":"dash"}',
    '{"type":"post","ref":"p002","author":1,"content":"untagged with media","hashtag":"","mediaUrl":"ipfs://bafyexample","sensitive":true}',
    '{"type":"quote","ref":"p003","author":2,"content":"look at {{link:p001}}","quotedRef":"p001","hashtag":""}',
    '{"type":"reply","ref":"r001","author":1,"rootRef":"p001","parentRef":"p001","content":"first reply"}',
    '{"type":"reply","ref":"r002","author":2,"rootRef":"p001","parentRef":"r001","content":"nested reply"}',
    '{"type":"like","author":2,"targetRef":"p001"}',
    '{"type":"likeReply","author":0,"targetRef":"r001"}',
    '{"type":"repost","author":0,"targetRef":"p002"}',
    '{"type":"follow","author":0,"target":1}',
    '{"type":"bookmark","author":1,"targetRef":"p003"}',
  ].join('\n');

  // Parsing + stats
  const { ops, stats } = parseCorpus(corpus, personas);
  check('parse: all lines accepted', ops.length === 10);
  check('parse: stats per type', stats.post === 2 && stats.quote === 1 && stats.reply === 2 && stats.like === 1);
  check('parse: line numbers carried', ops[3].line === 4);

  // YAPP cost model: 2 posts + 1 quote = 30, 2 replies = 6, like+likeReply+repost = 3
  const { total } = corpusYappCost(ops);
  check('yapp cost: 39 for the sample corpus', total === 39, `total=${total}`);

  // Structural rejections
  const rejects = (line, why) => {
    try {
      parseCorpus(line, personas);
      return false;
    } catch (e) {
      return e.message.includes(why);
    }
  };
  check('parse: forward ref rejected', rejects('{"type":"like","author":0,"targetRef":"nope"}', 'not defined earlier'));
  check('parse: likeReply on a post rejected', rejects(
    '{"type":"post","ref":"p1","author":0,"content":"x","hashtag":""}\n{"type":"likeReply","author":1,"targetRef":"p1"}',
    'is a post, expected reply'
  ));
  check('parse: duplicate like rejected', rejects(
    '{"type":"post","ref":"p1","author":0,"content":"x","hashtag":""}\n{"type":"like","author":1,"targetRef":"p1"}\n{"type":"like","author":1,"targetRef":"p1"}',
    '40105'
  ));
  check('parse: bad hashtag rejected', rejects('{"type":"post","ref":"p1","author":0,"content":"x","hashtag":"UPPER"}', 'hashtag'));
  check('parse: self-follow rejected', rejects('{"type":"follow","author":0,"target":0}', 'follow itself'));
  check('parse: oversize expanded content rejected', rejects(
    '{"type":"post","ref":"p1","author":0,"content":"x","hashtag":""}\n' +
    JSON.stringify({ type: 'post', ref: 'p2', author: 0, content: 'y'.repeat(440) + '{{link:p1}}', hashtag: '' }),
    'can expand'
  ));

  // Link substitution
  const substituted = substituteLinks('see {{link:p001}} now', () => 'FakePostId111');
  check('links: substituted with the post URL', substituted === 'see https://yap.pr/devnet/post/?id=FakePostId111 now');
  check('links: expansion length is the worst case', expandedContentLength('{{link:p001}}') === 'https://yap.pr/devnet/post/?id='.length + 44);

  // Scheduling: per-author order, ref availability, journal, resume
  const executionLog = [];
  const journal = [];
  const mockExecutor = async (op) => {
    await sleep(Math.random() * 5);
    executionLog.push(op.line);
    if (op.ref) {
      const kind = op.type === 'reply' ? 'reply' : 'post';
      return { kind, id: `id-${op.ref}`, ownerId: `owner-${op.author}`, hashtag: op.hashtag ?? '' };
    }
    return null;
  };
  const progress1 = { completed: new Map(), refs: new Map() };
  const results1 = await runCorpus({
    ops,
    executor: mockExecutor,
    concurrency: 3,
    progress: progress1,
    journal: (record) => journal.push(record),
  });
  check('schedule: all ops executed', results1.done === 10 && results1.failed === 0);
  const positions = new Map(executionLog.map((line, i) => [line, i]));
  const authorOrderOk = [...new Set(ops.map((o) => o.author))].every((author) => {
    const lines = ops.filter((o) => o.author === author).map((o) => o.line);
    return lines.every((line, i) => i === 0 || positions.get(lines[i - 1]) < positions.get(line));
  });
  check('schedule: per-author order preserved', authorOrderOk);
  check('schedule: deps executed before dependents', positions.get(1) < positions.get(6) && positions.get(4) < positions.get(7));
  check('schedule: journal covers every op', journal.length === 10);

  // Resume: fold the journal, re-run — nothing executes twice
  const progress2 = { completed: new Map(), refs: new Map() };
  for (const record of journal) {
    if (record.status === 'done') {
      progress2.completed.set(record.line, record);
      if (record.ref) progress2.refs.set(record.ref, { kind: record.kind, id: record.id, ownerId: record.ownerId, hashtag: record.hashtag });
    }
  }
  let reexecuted = 0;
  const results2 = await runCorpus({
    ops,
    executor: async () => {
      reexecuted += 1;
      return null;
    },
    concurrency: 3,
    progress: progress2,
    journal: () => {},
  });
  check('resume: completed lines never re-executed', reexecuted === 0 && results2.skipped === 10);

  // Failure propagation: a failed defining op fails its dependents, others continue
  const progress3 = { completed: new Map(), refs: new Map() };
  const results3 = await runCorpus({
    ops,
    executor: async (op) => {
      if (op.ref === 'p001') throw new Error('synthetic failure');
      if (op.ref) return { kind: op.type === 'reply' ? 'reply' : 'post', id: `id-${op.ref}`, ownerId: `o-${op.author}`, hashtag: '' };
      return null;
    },
    concurrency: 3,
    progress: progress3,
    journal: () => {},
  });
  // p001 fails → p003 (quote+link), r001, r002 (chain), like p001, likeReply r001, bookmark p003 all fail; p002, repost p002, follow survive
  check('failure: dependents fail, independents survive', results3.failed === 7 && results3.done === 3, `done=${results3.done} failed=${results3.failed}`);

  // --max-ops stops cleanly without journaling unexecuted ops
  const progress4 = { completed: new Map(), refs: new Map() };
  const journal4 = [];
  const results4 = await runCorpus({
    ops,
    executor: mockExecutor,
    concurrency: 1,
    progress: progress4,
    journal: (record) => journal4.push(record),
    maxOps: 3,
  });
  check('max-ops: executes exactly the cap', results4.done === 3 && journal4.length === 3, `done=${results4.done}`);

  console.log(failures === 0 ? '\nSELF-TEST PASSED (no network calls)' : `\n${failures} SELF-TEST CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- Main -----------------------------------------------------------------------------

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: NETWORK=devnet node scripts/seed/run-seeder.mjs --personas <file> --corpus <file>');
  console.error('         [--concurrency 10] [--max-ops N]');
  console.error('       node scripts/seed/run-seeder.mjs --self-test');
  process.exit(1);
}

if (args.selfTest) {
  await selfTest();
}

if (network() !== 'devnet') {
  console.error('This seeder only writes to devnets. Run with NETWORK=devnet.');
  process.exit(1);
}

try {
  await ensureInitialized();
  const personas = loadPersonas(args.personas);
  const { ops, stats } = parseCorpus(readFileSync(args.corpus, 'utf8'), personas);
  const { total: yappNeeded, perAuthor } = corpusYappCost(ops);
  console.log(`corpus: ${ops.length} ops (${Object.entries(stats).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}`).join(', ')})`);
  console.log(`YAPP required if run from scratch: ${yappNeeded} total, max ${Math.max(0, ...perAuthor.values())} for one author`);

  const ledger = loadLedger();
  const progress = loadProgress();
  if (progress.completed.size > 0) {
    console.log(`checkpoint: ${progress.completed.size} line(s) already complete, ${progress.refs.size} ref(s) known (${PROGRESS_FILE})`);
  }

  const contractId = socialContractId();
  const handle = createSdkHandle({ contractIds: [contractId], timeoutMs: SDK_TIMEOUT_MS, log: (msg) => console.log(`  ${msg}`) });
  const { protocolVersion } = await handle.connect();
  console.log(`connected to devnet (PV${protocolVersion ?? '?'}), contract ${contractId}`);

  const actors = await buildActors(handle, ledger, personas, ops);
  console.log(`actors: ${actors.size} identities loaded from the ledger`);
  const tokenId = await readback(handle, () => handle.sdk.tokens.calculateId(contractId, YAPP_TOKEN_POSITION));
  const before = await snapshotBalances(handle, actors, tokenId);

  const executor = buildExecutor({ handle, contractId, actors, progressRefs: progress.refs });
  // The engine publishes refs through deferreds; the executor reads settled
  // records from progress.refs, so keep the two in sync as records land.
  const journal = (record) => {
    appendProgress(record);
    if (record.status === 'done' && record.ref) {
      progress.refs.set(record.ref, { kind: record.kind, id: record.id, ownerId: record.ownerId, hashtag: record.hashtag ?? '' });
    }
  };

  const startedAt = Date.now();
  const results = await runCorpus({
    ops,
    executor,
    concurrency: args.concurrency,
    progress,
    journal,
    maxOps: args.maxOps,
    log: (msg) => console.log(msg),
  });
  const wallClockMs = Date.now() - startedAt;

  const after = await snapshotBalances(handle, actors, tokenId);
  const report = buildReport({ args, ops, stats, results, before, after, actors, wallClockMs });
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  printSummary(report);
  process.exit(results.failed === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
