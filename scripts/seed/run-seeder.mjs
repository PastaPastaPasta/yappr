/**
 * Corpus executor: replays a `corpus.<name>.jsonl` op stream (see
 * CORPUS_FORMAT.md) against the devnet social contract as the seed
 * identities provisioned by provision-seed-identities.mjs.
 *
 * The target is the v10 or v11 social contract (`.env.devnet`; the run refuses
 * any other NEXT_PUBLIC_CONTRACT_TOPOLOGY). The corpus `''` convention means
 * "untagged", and an untagged post/quote/like OMITS the hashtag property
 * (writing `''` is `where` consensus error 40127). A post or reply with a
 * `mediaUrl` carries the sha256 and dHash of the bytes at that URL
 * (media-hash.mjs), fetched once per URL before the run starts. A like is one
 * transition: v10 has no `beat` companion. A `repost` op is written as a post
 * quoting its target with no content (v10 has no repost type), through the
 * same path as a quote; its 40105 is success only when our bare repost is
 * already there.
 *
 * Two things shape what a create CARRIES: `post` and `reply` must agree to the
 * action fee their type declares (`$actionFeeAgreement`, 40132 without), which
 * `sdk.documents.create` cannot express — so those creates are hand-built
 * batches — and their token costs are `optional`, so `--credits-fraction` of
 * the actors omit `$tokenPaymentInfo` and pay credits while the rest pay YAPP
 * with the contract owner offered the gas. An actor's currency is fixed by its
 * persona index, so a resume keeps it.
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
 * Devnet quirks handled:
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
 *     [--concurrency 10] [--max-ops N] [--pipeline [--window 8]]
 *     [--credits-fraction 0.25]
 *   node scripts/seed/run-seeder.mjs --self-test
 *
 * `--pipeline` swaps the confirm-per-op executor for scripts/seed/pipeline.mjs:
 * hand-built transitions with locally-tracked nonces, broadcast without
 * waiting, reconciled by readback — up to `--window` in flight per identity.
 * Use a high --concurrency (hundreds) with it; throughput scales with the
 * number of distinct authors, not with concurrency on one.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentActionFeeAgreement, IdentitySigner, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import {
  CRITICAL_AUTH_KEY_ID,
  DUPLICATE_UNIQUE,
  duplicateIsSuccess,
  FEE_MULTIPLIER_NOT_TOLERATED,
  NONCE_DESYNC,
  PROGRESS_FILE,
  REPORT_FILE,
  RETRYABLE,
  TOKEN_COST,
  PREFER_CONTRACT_OWNER,
  tokenCostFor,
  TRANSPORT_COLLAPSE,
  WAIT_MAYBE_LANDED,
  YAPP_TOKEN_POSITION,
  actionFeeAgreementOptions,
  actionFeeFor,
  appendProgress,
  buildDocument,
  corpusYappCost,
  createDocument,
  forgetFeeMultiplier,
  createSdkHandle,
  createdId,
  deriveDocumentIdBytes,
  describeErr,
  CONTENT_MAX,
  CONTENT_MAX_BYTES,
  codePointLength,
  expandedContentLength,
  utf8Length,
  findRecentByValues,
  hashtagProps,
  ledgerEntry,
  likeValueTuple,
  loadLedger,
  loadPersonas,
  loadProgress,
  network,
  feeMultiplierPermille,
  parseCorpus,
  paymentInfo,
  paysInCredits,
  feeAgreementFor,
  randomEntropy,
  readback,
  requireSeededTopology,
  sleep,
  socialContractId,
  stateRank,
  substituteLinks,
  wifFromHex,
} from './seed-lib.mjs';
import { dHashFromLuma, mediaFieldsFor } from './media-hash.mjs';

const SDK_TIMEOUT_MS = 30_000;
/**
 * Share of a run's actors that pay their token-priced writes in CREDITS
 * (no `$tokenPaymentInfo`) rather than YAPP, so a seeded devnet exercises both
 * halves of the optional-token-cost path. `--credits-fraction` overrides it.
 */
const DEFAULT_CREDITS_FRACTION = 0.25;
const MAX_ATTEMPTS = 4;
/** Reads settle behind the write quorum; poll cadence for landed-or-not checks. */
const SETTLE_MS = 3_000;
const SETTLE_POLLS = 3;
/** How long an op may park waiting for its target ref before giving up. */
const DEP_WAIT_TIMEOUT_MS = 15 * 60_000;
/** Identity fetches in flight while building the actor table (startup cost only). */
const ACTOR_FETCH_CONCURRENCY = 16;

// ---- CLI ------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { personas: null, corpus: null, concurrency: 10, maxOps: Infinity, selfTest: false, pipeline: false, window: 8, creditsFraction: null, requireDhash: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--personas': args.personas = argv[++i]; break;
      case '--corpus': args.corpus = argv[++i]; break;
      case '--concurrency': args.concurrency = Number(argv[++i]); break;
      case '--max-ops': args.maxOps = Number(argv[++i]); break;
      case '--pipeline': args.pipeline = true; break;
      case '--require-dhash': args.requireDhash = true; break;
      case '--window': args.window = Number(argv[++i]); break;
      case '--credits-fraction': args.creditsFraction = Number(argv[++i]); break;
      case '--self-test': args.selfTest = true; break;
      default: throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  if (args.creditsFraction !== null && !(args.creditsFraction >= 0 && args.creditsFraction <= 1)) {
    throw new Error('--credits-fraction must be between 0 and 1');
  }
  if (!args.selfTest) {
    if (!args.personas || !args.corpus) throw new Error('--personas and --corpus are required');
    if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer');
    if (args.maxOps !== Infinity && (!Number.isInteger(args.maxOps) || args.maxOps < 1)) throw new Error('--max-ops must be a positive integer');
    args.creditsFraction ??= DEFAULT_CREDITS_FRACTION;
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

/**
 * Maps one corpus op to {docType, data, tokenCost, indexOnly, refRecord,
 * existenceKey}. Pure (exported for the self-test): the acceptance query for
 * indexOnly types is described by `existenceKey` and bound to the network in
 * buildExecutor. An untagged post/quote/like OMITS the hashtag property (the
 * corpus '' convention and an absent checkpoint hashtag are equivalent).
 * `mediaFor(url)` answers the `{ mediaHash, mediaFingerprint }` of a URL,
 * computed before the run (`resolveCorpusMedia`).
 */
export function planOp(op, { actors, resolveRef, mediaFor = missingMedia }) {
  const bytes = (base58) => bs58.decode(base58);
  const actor = actors.get(op.author);
  if (!actor) throw new Error(`author ${op.author} has no provisioned identity`);
  const finalContent = typeof op.content === 'string'
    ? substituteLinks(op.content, (ref) => resolveRef(ref).id)
    : undefined;
  if (finalContent !== undefined && (codePointLength(finalContent) > CONTENT_MAX || utf8Length(finalContent) > CONTENT_MAX_BYTES)) {
    throw new Error(`line ${op.line}: content is ${codePointLength(finalContent)} characters / ${utf8Length(finalContent)} bytes after link substitution (max ${CONTENT_MAX} / ${CONTENT_MAX_BYTES})`);
  }
  const media = op.mediaUrl ? { mediaUrl: op.mediaUrl, ...mediaFor(op.mediaUrl) } : {};

  switch (op.type) {
    case 'post':
    case 'quote': {
      const quoted = op.type === 'quote' ? resolveRef(op.quotedRef) : null;
      return {
        docType: 'post',
        tokenCost: TOKEN_COST.post,
        data: {
          content: finalContent ?? '',
          ...hashtagProps(op.hashtag),
          ...media,
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
          ...(parent.kind === 'reply' ? { replyToReplyId: bytes(parent.id) } : {}),
          ...media,
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
        // where: hashtag and postAuthor MUST mirror the post — including
        // hashtag ABSENCE (both-absent = agreement; '' on a like of an
        // untagged post is consensus error 40127). `postAuthor` binds to
        // `post.$ownerId`. The same tuple is what a delete-by-values carries.
        // The like itself feeds the rolling trending windows (byTrendPost, byTrendHashtagPost).
        data: likeValueTuple(target),
        existenceKey: { keyField: 'postId', keyValue: target.id },
      };
    }
    case 'likeReply': {
      const target = resolveRef(op.targetRef);
      return {
        docType: 'likeReply',
        tokenCost: TOKEN_COST.likeReply,
        indexOnly: true,
        data: { replyId: bytes(target.id), replyAuthor: bytes(target.ownerId) },
        existenceKey: { keyField: 'replyId', keyValue: target.id },
      };
    }
    case 'repost': {
      // v10 has no repost type: a repost is a post quoting its target (a post or
      // a reply) with no content, written like a quote — the post price and the
      // post action fee agreement. It defines no ref.
      const target = resolveRef(op.targetRef);
      const field = target.kind === 'reply' ? 'quotedReplyId' : 'quotedPostId';
      return {
        docType: 'post',
        tokenCost: TOKEN_COST.post,
        data: { [field]: bytes(target.id), quotedPostOwnerId: bytes(target.ownerId) },
        repostTarget: { field, value: target.id },
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
 * How one create is sent, shared by the confirm-per-op executor and the
 * pipelined one.
 *
 * A `post` or `reply` create must carry an `$actionFeeAgreement` (40132
 * without one), and `sdk.documents.create` has no option for it — its
 * `DocumentCreateOptions` are document / identityKey / signer /
 * tokenPaymentInfo / settings — so those creates are hand-built batches
 * (`createWithAgreement`), which also means their id is known before the
 * broadcast rather than read off the return. Everything else keeps the facade
 * path exactly as before.
 *
 * What a create PAYS is per actor: `actor.paysCredits` omits the token payment
 * entirely (the `optional: true` costs, the signer paying credits), while the
 * rest pay YAPP and ask the contract owner to cover the gas
 * (PreferContractOwner).
 */
function writeShapeFor({ handle }) {
  const paymentFor = (actor, docType, tokenCost) => {
    if (!tokenCost || actor.paysCredits) return {};
    // The gas offer comes from the DOCTYPE's own tokenCost, not from whether
    // anything charges an action fee: the two are independent in the grammar,
    // and asking for a payer the type does not offer is 40129.
    return paymentInfo(tokenCost, { gasFeesPaidBy: tokenCostFor(docType)?.gasFeesPaidBy ?? 0 });
  };
  return {
    paymentFor,
    /** Resolves to something `createdId` can read an id off, or `{ id }` from the manual path. */
    async create({ contractId, actor, document, entropy, docType, data, tokenCost }) {
      const payment = paymentFor(actor, docType, tokenCost);
      const agreement = await feeAgreementFor(handle.sdk, docType);
      return createDocument(handle.sdk, { contractId, actor, docType, document, data, entropy, agreement, payment });
    },
  };
}

function buildExecutor({ handle, contractId, actors, progressRefs, mediaFor }) {
  const writeShape = writeShapeFor({ handle });
  const resolveRef = (ref) => {
    const record = progressRefs.get(ref);
    if (!record) throw new Error(`ref "${ref}" not materialized (checkpoint out of sync)`);
    return record;
  };

  /**
   * One op, end to end. Acceptance is decided by the chain: readback by id for
   * stored doctypes, entry-existence for indexOnly ones. Protocol 14 derives
   * the id from the nonce `documents.create()` picks, so a retry of a
   * broadcast that DID land converges on the landed document only through the
   * value readback in `accepted` (`findRecentByValues`) — not through a stable
   * id, which no longer exists before the write.
   */
  return async function executeOp(op) {
    const actor = actors.get(op.author);
    const plan = planOp(op, { actors, resolveRef, mediaFor });
    // One draw per op, reused by every attempt. Under protocol 14 that does NOT
    // make the id stable across a retry — the id commits to the nonce too — so
    // what recognises a broadcast that landed is the by-value `accepted` probe
    // below, not the entropy.
    const entropy = randomEntropy();
    const { document } = buildDocument({
      contractId,
      docType: plan.docType,
      ownerId: actor.ownerId,
      data: plan.data,
      entropy,
    });
    // Protocol 14: the stored id is derived from the nonce `documents.create()`
    // picks, so it is only known from a create that RETURNED. `id` is filled in
    // from that return; a stored-doctype create that threw is reconciled by a
    // value readback of the owner's recent documents instead (see `accepted`).
    let id = null;
    const startedAt = Date.now();
    const accepted = plan.existenceKey
      ? () => entryExists(handle, contractId, plan.docType, plan.existenceKey.keyField, plan.existenceKey.keyValue, actor.ownerId)
      : async () => {
        if (id) return (await readback(handle, () => handle.sdk.documents.get(contractId, plan.docType, id))) != null;
        id = await readback(handle, () => findRecentByValues(handle.sdk, { contractId, docType: plan.docType, ownerId: actor.ownerId, data: plan.data, since: startedAt }));
        return id != null;
      };

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const created = await writeShape.create({
          contractId, actor, document, entropy, docType: plan.docType, data: plan.data, tokenCost: plan.tokenCost,
        });
        if (!plan.indexOnly) {
          id = createdId(created) ?? id;
          if (!id && !(await accepted())) throw new Error('create returned no id and the document is not on chain');
          return plan.refRecord ? plan.refRecord(id) : null;
        }
        // indexOnly: a clean return still gets one confirming read (cheap, and
        // the SDK's post-broadcast behavior for these types is unreliable).
        if (await accepted()) return plan.refRecord ? plan.refRecord(id) : null;
        lastError = new Error('create returned but the entry is not on chain');
      } catch (e) {
        lastError = e;
        const text = describeErr(e);
        if (DUPLICATE_UNIQUE.test(text) && await duplicateIsSuccess(handle, contractId, { op, plan, ownerId: actor.ownerId }).catch(() => false)) {
          return plan.refRecord ? plan.refRecord(id) : null;
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
        // A 40134 says only that this process's cached fee multiplier is stale
        // (an epoch turned over mid-run): drop it and the next attempt prices a
        // fresh agreement. Every other consensus refusal is final.
        if (FEE_MULTIPLIER_NOT_TOLERATED.test(text)) forgetFeeMultiplier();
        const retryable =
          TRANSPORT_COLLAPSE.test(text) || NONCE_DESYNC.test(text) || RETRYABLE.test(text) || WAIT_MAYBE_LANDED.test(text)
          || FEE_MULTIPLIER_NOT_TOLERATED.test(text);
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

// ---- Media -----------------------------------------------------------------------------

function missingMedia(url) {
  throw new Error(`media ${url} was not resolved before the run (resolveCorpusMedia)`);
}

const MEDIA_FETCH_CONCURRENCY = 4;
const MEDIA_FETCH_ATTEMPTS = 3;
const hexOf = (bytes) => Buffer.from(bytes).toString('hex');
const bytesOf = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));

/** The media cache beside the progress journal (`.seed-progress.local.media.json`, gitignored with it). */
export const mediaCacheFile = (progressFile = PROGRESS_FILE) => `${progressFile.replace(/\.json$/, '')}.media.json`;

function loadMediaCache(file) {
  if (!file || !existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * The `{ mediaHash, mediaFingerprint }` of every distinct `mediaUrl` in the
 * corpus, resolved before any write so a media op never waits on (or fails
 * over) an image download mid-run. Returns the sync lookup planOp takes.
 *
 * Each URL is fetched at most once per ledger: results are cached in
 * `cacheFile` (url → hex hash, fingerprint, decoded), so a resumed run writes
 * the hashes the first run computed even if the bytes behind a URL drift.
 * Fetches run `MEDIA_FETCH_CONCURRENCY` at a time with `MEDIA_FETCH_ATTEMPTS`
 * tries each. A fingerprint that is a stand-in (no local decoder) is counted
 * loudly, and `requireDhash` refuses the run instead (a cached stand-in is
 * then fetched again, in case a decoder is now available).
 */
export async function resolveCorpusMedia(ops, { fetchBytes, log = () => {}, cacheFile = null, requireDhash = false } = {}) {
  const urls = [...new Set(ops.map((op) => op.mediaUrl).filter(Boolean))];
  const cache = loadMediaCache(cacheFile);
  const todo = urls.filter((url) => !cache[url] || (requireDhash && !cache[url].decoded));
  const failed = [];
  const queue = [...todo];
  await Promise.all(Array.from({ length: Math.min(MEDIA_FETCH_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      let lastError = null;
      for (let attempt = 1; attempt <= MEDIA_FETCH_ATTEMPTS; attempt++) {
        try {
          const fields = await mediaFieldsFor(url, { fetchBytes });
          cache[url] = { mediaHash: hexOf(fields.mediaHash), mediaFingerprint: hexOf(fields.mediaFingerprint), decoded: fields.decoded };
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          if (attempt < MEDIA_FETCH_ATTEMPTS) await sleep(1_000 * attempt);
        }
      }
      if (lastError) failed.push(`${url}: ${describeErr(lastError).slice(0, 120)}`);
    }
  }));
  if (cacheFile && todo.length > 0) writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
  if (failed.length > 0) throw new Error(`could not fetch ${failed.length} media URL(s) after ${MEDIA_FETCH_ATTEMPTS} tries:\n  ${failed.join('\n  ')}`);
  const standIns = urls.filter((url) => !cache[url].decoded);
  if (urls.length > 0) log(`media: ${urls.length} URL(s), ${todo.length} fetched, ${urls.length - todo.length} from the cache`);
  if (standIns.length > 0) {
    const warning = `${standIns.length} of ${urls.length} media fingerprint(s) are STAND-INS (no local image decoder: macOS sips); the client's near-duplicate check cannot match them`;
    if (requireDhash) throw new Error(`--require-dhash: ${warning}`);
    log(`WARNING: ${warning}. Re-run with --require-dhash on a machine with sips to refuse this.`);
  }
  return (url) => {
    const entry = cache[url];
    if (!entry) return missingMedia(url);
    return { mediaHash: bytesOf(entry.mediaHash), mediaFingerprint: bytesOf(entry.mediaFingerprint) };
  };
}

// ---- Actors ---------------------------------------------------------------------------

async function buildActors(handle, ledger, personas, ops, creditsFraction = 0) {
  const authors = new Set(ops.map((op) => op.author));
  for (const op of ops) if (op.type === 'follow') authors.add(op.target);
  const actors = new Map();
  // One identity fetch each; sequentially that is minutes of startup at 300
  // authors, so fetch a bounded number of them at a time.
  const queue = [...authors];
  const build = async (idx) => {
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
    const wif = wifFromHex(authKey.privateKeyHex);
    const signer = new IdentitySigner();
    signer.addKeyFromWif(wif);
    // `wif` signs the hand-built batches an action fee agreement needs;
    // `paysCredits` fixes this actor's currency for the whole run.
    actors.set(idx, {
      personaIdx: idx, ownerId: entry.identityId, handle: entry.handle, identityKey, signer, wif,
      paysCredits: paysInCredits(idx, creditsFraction),
    });
  };
  await Promise.all(
    Array.from({ length: Math.min(ACTOR_FETCH_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) await build(queue.shift());
    })
  );
  return actors;
}

async function snapshotBalances(handle, actors, tokenId) {
  const ids = [...actors.values()].map((actor) => actor.ownerId);
  // DAPI caps identity/token balance queries at 100 ids per call.
  const credits = new Map();
  const yapp = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const c = await readback(handle, () => handle.sdk.identities.balances(chunk));
    const y = await readback(handle, () => handle.sdk.tokens.balances(chunk, tokenId));
    for (const id of chunk) {
      credits.set(id, (c instanceof Map ? c.get(id) : c?.[id]) ?? 0n);
      yapp.set(id, (y instanceof Map ? y.get(id) : y?.[id]) ?? 0n);
    }
  }
  const get = (map, key) => map.get(key) ?? 0n;
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

  // YAPP cost model: 2 posts + 1 quote = 30, 2 replies = 6, like+likeReply = 2, and the repost is a post = 10
  const { total } = corpusYappCost(ops);
  check('yapp cost: 48 for the sample corpus (a repost costs a post)', total === 48, `total=${total}`);

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
  // One quote or repost per author and target (ownerAndQuotedPost / ownerAndQuotedReply, 40105).
  const target = '{"type":"post","ref":"p1","author":0,"content":"x","hashtag":""}\n';
  check('parse: a second repost of the same post by the same author rejected', rejects(
    `${target}{"type":"repost","author":1,"targetRef":"p1"}\n{"type":"repost","author":1,"targetRef":"p1"}`, '40105'));
  check('parse: a repost after a quote of the same post by the same author rejected', rejects(
    `${target}{"type":"quote","ref":"p2","author":1,"content":"q","quotedRef":"p1","hashtag":""}\n{"type":"repost","author":1,"targetRef":"p1"}`, '40105'));
  check('parse: a quote after a repost of the same post by the same author rejected', rejects(
    `${target}{"type":"repost","author":1,"targetRef":"p1"}\n{"type":"quote","ref":"p2","author":1,"content":"q","quotedRef":"p1","hashtag":""}`, '40105'));
  check('parse: another author\'s repost, and a repost of a reply, are accepted', parseCorpus(
    `${target}{"type":"repost","author":1,"targetRef":"p1"}\n{"type":"repost","author":2,"targetRef":"p1"}\n` +
    '{"type":"reply","ref":"r1","author":2,"rootRef":"p1","parentRef":"p1","content":"r"}\n{"type":"repost","author":1,"targetRef":"r1"}', personas).ops.length === 5);
  check('parse: bad hashtag rejected', rejects('{"type":"post","ref":"p1","author":0,"content":"x","hashtag":"UPPER"}', 'hashtag'));
  check('parse: self-follow rejected', rejects('{"type":"follow","author":0,"target":0}', 'follow itself'));
  check('parse: oversize expanded content rejected', rejects(
    '{"type":"post","ref":"p1","author":0,"content":"x","hashtag":""}\n' +
    JSON.stringify({ type: 'post', ref: 'p2', author: 0, content: 'y'.repeat(940) + '{{link:p1}}', hashtag: '' }),
    'can expand'
  ));
  check('parse: content over 2000 UTF-8 bytes rejected though under 1000 characters', rejects(
    JSON.stringify({ type: 'post', ref: 'p1', author: 0, content: '€'.repeat(667), hashtag: '' }),
    'UTF-8 bytes'
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

  // ---- Document shapes: hashtag ABSENCE, no attested author, no language, media hashes ----
  const owner = bs58.encode(new Uint8Array(32).fill(1));
  const targetId = bs58.encode(new Uint8Array(32).fill(2));
  const planCtx = (refHashtag) => ({
    actors: new Map([[0, { ownerId: owner }], [1, { ownerId: owner }]]),
    resolveRef: () => ({ kind: 'post', id: targetId, ownerId: owner, hashtag: refHashtag }),
  });
  const postOp = { type: 'post', ref: 'p1', author: 0, content: 'x', hashtag: '', line: 1 };
  const quoteOp = { type: 'quote', ref: 'p2', author: 0, content: 'q', quotedRef: 'p1', hashtag: '', line: 2 };
  const likeOp = { type: 'like', author: 1, targetRef: 'p1', line: 3 };
  const replyOp = { type: 'reply', author: 1, rootRef: 'p1', parentRef: 'p1', content: 'r', line: 4 };

  const plannedPost = planOp(postOp, planCtx('')).data;
  const plannedReply = planOp(replyOp, planCtx('')).data;
  check('post OMITS the attested author column and `language` (v10 has neither)',
    !('author' in plannedPost) && !('language' in plannedPost));
  check('reply OMITS the attested author column, keeping its parent linkage',
    !('author' in plannedReply) && plannedReply.rootPostId instanceof Uint8Array && plannedReply.parentOwnerId instanceof Uint8Array);
  check('a like is ONE document: tagged or not, no beat companion', planOp(likeOp, planCtx('dash')).companion === undefined && planOp(likeOp, planCtx('')).companion === undefined);
  const media = { mediaHash: new Uint8Array(32).fill(3), mediaFingerprint: new Uint8Array(8).fill(4) };
  const withMedia = planOp({ ...postOp, mediaUrl: 'https://example.com/a.png' }, { ...planCtx(''), mediaFor: () => media }).data;
  check('a post with mediaUrl carries its hash and fingerprint (dependentRequired)',
    withMedia.mediaUrl === 'https://example.com/a.png' && withMedia.mediaHash === media.mediaHash && withMedia.mediaFingerprint === media.mediaFingerprint);
  const replyWithMedia = planOp({ ...replyOp, mediaUrl: 'ipfs://bafy' }, { ...planCtx(''), mediaFor: () => media }).data;
  check('a reply with mediaUrl carries them too', replyWithMedia.mediaHash === media.mediaHash && replyWithMedia.mediaFingerprint === media.mediaFingerprint);
  check('a post without media carries neither', !('mediaHash' in plannedPost) && !('mediaFingerprint' in plannedPost));
  check('an unresolved media URL fails the plan instead of writing a 10101', (() => {
    try { planOp({ ...postOp, mediaUrl: 'https://example.com/b.png' }, planCtx('')); return false; } catch (e) { return /not resolved/.test(e.message); }
  })());
  // The pinned dHash: bit = right pixel brighter, row-major, most significant bit first.
  const hex = (grid) => Buffer.from(dHashFromLuma(grid)).toString('hex');
  check('dHash: a left-to-right ramp sets every bit, a flat or right-to-left grid none',
    hex(Array.from({ length: 72 }, (_, i) => i % 9)) === 'ffffffffffffffff' &&
      hex(new Array(72).fill(7)) === '0000000000000000' && hex(Array.from({ length: 72 }, (_, i) => 9 - (i % 9))) === '0000000000000000');
  check('dHash: row r is byte r, its first pair the most significant bit',
    hex(Array.from({ length: 72 }, (_, i) => (i === 1 ? 1 : 0))) === '8000000000000000' &&
      hex(Array.from({ length: 72 }, (_, i) => (i === 7 * 9 + 8 ? 1 : 0))) === '0000000000000001');
  // Media: fetched once, retried, cached beside the journal, stand-ins counted.
  {
    const cacheFile = join(mkdtempSync(join(tmpdir(), 'seed-media-')), 'progress.media.json');
    const mediaOps = [{ mediaUrl: 'https://example.com/a' }, { mediaUrl: 'https://example.com/a' }, { mediaUrl: 'https://example.com/b' }, {}];
    let fetches = 0;
    let flaky = 1;
    const fetchBytes = async (url) => {
      fetches += 1;
      if (url.endsWith('/b') && flaky-- > 0) throw new Error('503');
      return new TextEncoder().encode(url);
    };
    const logs = [];
    const first = await resolveCorpusMedia(mediaOps, { fetchBytes, cacheFile, log: (m) => logs.push(m) });
    check('media: each distinct URL resolves, a failed fetch is retried', fetches === 3 && first('https://example.com/a').mediaHash.length === 32 && first('https://example.com/b').mediaFingerprint.length === 8, `fetches=${fetches}`);
    const again = await resolveCorpusMedia(mediaOps, { fetchBytes: async () => { throw new Error('must not refetch'); }, cacheFile });
    check('media: a resume reads the cache, the same bytes out', Buffer.from(again('https://example.com/a').mediaHash).equals(Buffer.from(first('https://example.com/a').mediaHash)));
    check('media: stand-in fingerprints are counted loudly', logs.some((m) => /WARNING: 2 of 2 media fingerprint\(s\) are STAND-INS/.test(m)), logs.join(' | '));
    const refused = await resolveCorpusMedia(mediaOps, { fetchBytes, cacheFile, requireDhash: true }).then(() => false, (e) => /--require-dhash/.test(e.message));
    check('media: --require-dhash refuses stand-ins', refused);
    check('media: the cache sits beside the progress journal (gitignored with it)', mediaCacheFile('/x/.seed-progress.local.json') === '/x/.seed-progress.local.media.json');
  }
  check('content: 1000 characters plan; 1001, or 2001 bytes in fewer characters, refuse', (() => {
    const plan = (content) => { try { planOp({ ...postOp, content }, planCtx('')); return true; } catch { return false; } };
    return plan('x'.repeat(1000)) && !plan('x'.repeat(1001)) && !plan('€'.repeat(667)) && plan('😀'.repeat(500));
  })());
  check('untagged post OMITS hashtag', !('hashtag' in plannedPost));
  check('tagged post keeps its hashtag', planOp({ ...postOp, hashtag: 'dash' }, planCtx('')).data.hashtag === 'dash');
  const repostOp = { type: 'repost', author: 1, targetRef: 'p1', line: 5 };
  const plannedRepost = planOp(repostOp, planCtx('dash'));
  check('a repost is a POST quoting its target with no content (no hashtag), at the post price',
    plannedRepost.docType === 'post' && plannedRepost.tokenCost === TOKEN_COST.post && plannedRepost.refRecord === undefined &&
      JSON.stringify(Object.keys(plannedRepost.data)) === JSON.stringify(['quotedPostId', 'quotedPostOwnerId']) &&
      bs58.encode(plannedRepost.data.quotedPostId) === targetId && bs58.encode(plannedRepost.data.quotedPostOwnerId) === owner &&
      plannedRepost.repostTarget.field === 'quotedPostId' && plannedRepost.repostTarget.value === targetId,
    JSON.stringify(Object.keys(plannedRepost.data)));
  const replyRepost = planOp(repostOp, { ...planCtx(''), resolveRef: () => ({ kind: 'reply', id: targetId, ownerId: owner }) });
  check('a repost of a reply quotes it through quotedReplyId',
    JSON.stringify(Object.keys(replyRepost.data)) === JSON.stringify(['quotedReplyId', 'quotedPostOwnerId']) && replyRepost.repostTarget.field === 'quotedReplyId');
  // A repost's 40105 counts as done only when the post holding the entry is our bare repost.
  const holding = (stored) => ({ sdk: { documents: { query: async () => new Map([['x', { toObject: () => stored }]]) } } });
  const ours = { $ownerId: bs58.decode(owner), quotedPostId: bs58.decode(targetId), quotedPostOwnerId: bs58.decode(owner) };
  const duplicate = (handle, op, plan) => duplicateIsSuccess(handle, targetId, { op, plan, ownerId: owner });
  check('a 40105 is done for a like; for a repost only when our bare repost holds the entry, never for a quote',
    await duplicate(holding(null), likeOp, planOp(likeOp, planCtx(''))) &&
      await duplicate(holding(ours), repostOp, plannedRepost) &&
      !(await duplicate(holding({ ...ours, content: 'a quote with text' }), repostOp, plannedRepost)) &&
      !(await duplicate(holding({ ...ours, $ownerId: bs58.decode(targetId) }), repostOp, plannedRepost)) &&
      !(await duplicate(holding(ours), quoteOp, planOp(quoteOp, planCtx('')))));
  const plannedQuote = planOp(quoteOp, planCtx('')).data;
  check('untagged quote OMITS hashtag (quote fields intact)', !('hashtag' in plannedQuote) && plannedQuote.quotedPostId instanceof Uint8Array);
  const plannedLike = planOp(likeOp, planCtx(''));
  check(
    'like of an untagged post OMITS like.hashtag',
    !('hashtag' in plannedLike.data) && plannedLike.data.postAuthor instanceof Uint8Array && plannedLike.existenceKey.keyValue === targetId
  );
  check('like of a tagged post copies the hashtag', planOp(likeOp, planCtx('dash')).data.hashtag === 'dash');
  // The delete-by-values tuple is the same value tuple — it must reproduce the absence.
  const deleteTupleAbsent = likeValueTuple({ id: targetId, ownerId: owner }); // ref with no hashtag key at all
  const deleteTupleEmpty = likeValueTuple({ id: targetId, ownerId: owner, hashtag: '' });
  check(
    'like delete tuple OMITS hashtag, for \'\' and absent refs alike',
    !('hashtag' in deleteTupleAbsent) && JSON.stringify(Object.keys(deleteTupleAbsent)) === JSON.stringify(Object.keys(deleteTupleEmpty))
  );

  // Parse-time tag length: the contract's maxLength is 61
  const longTag = (n) => `{"type":"post","ref":"pL","author":0,"content":"x","hashtag":"${'a'.repeat(n)}"}`;
  check('parse: 61-char tag accepted', parseCorpus(longTag(61), personas).ops.length === 1);
  check('parse: 62-char tag rejected', (() => {
    try { parseCorpus(longTag(62), personas); return false; }
    catch (e) { return e.message.includes('maxLength 61'); }
  })());

  // Journal round-trip: a ref recorded with hashtag '' and one recorded with
  // NO hashtag key must fold and replay to identical documents.
  const tmpJournal = join(mkdtempSync(join(tmpdir(), 'seed-selftest-')), 'progress.jsonl');
  appendProgress({ line: 1, status: 'done', type: 'post', ref: 'pA', kind: 'post', id: targetId, ownerId: owner }, tmpJournal);
  appendProgress({ line: 2, status: 'done', type: 'post', ref: 'pB', kind: 'post', id: targetId, ownerId: owner, hashtag: '' }, tmpJournal);
  const folded = loadProgress(tmpJournal);
  const likeFromRef = (ref) => likeValueTuple(folded.refs.get(ref));
  check(
    "journal: absent-hashtag ref replays identically to a '' ref (both omit the property)",
    folded.refs.size === 2 &&
      JSON.stringify(Object.keys(likeFromRef('pA'))) === JSON.stringify(Object.keys(likeFromRef('pB'))) &&
      !('hashtag' in likeFromRef('pA'))
  );

  // ---- What a create CARRIES: the action fee agreement and YAPP vs credits ----
  const postFee = actionFeeFor('post');
  const replyFee = actionFeeFor('reply');
  check('the action fees come off the committed contract JSON (80M post / 16M reply, moderators only)',
    postFee?.moderators === 80_000_000n && postFee.owner === 0n && postFee.pricing === 'feeMultiplier' &&
      replyFee?.moderators === 16_000_000n && replyFee.owner === 0n,
    `post=${postFee?.moderators} reply=${replyFee?.moderators}`);
  check('nothing but post and reply charges an action fee',
    ['like', 'likeReply', 'follow', 'bookmark', 'yapprProfile'].every((docType) => actionFeeFor(docType) === null));

  const agreed = actionFeeAgreementOptions(postFee, 1000n);
  check('the agreement names the exact declared amounts, each pot on its own, plus the known multiplier',
    agreed.owner === 0n && agreed.moderators === 80_000_000n &&
      agreed.feeMultiplier.knownPermille === 1000n && agreed.feeMultiplier.increaseTolerancePercent === 20,
    JSON.stringify(agreed, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
  check('a fixed-priced fee names NO multiplier (naming one is the same 40133)',
    actionFeeAgreementOptions({ owner: 1n, moderators: 2n, pricing: 'fixed' }).feeMultiplier === undefined);
  check('the agreement carries the multiplier it is given, not a constant',
    actionFeeAgreementOptions(postFee, 1250n).feeMultiplier.knownPermille === 1250n);

  // The payment bags are wasm objects, unlike everything above them.
  await ensureInitialized();
  // Build the REAL wasm object, not just the options bag: the constructor
  // deserializes through serde, so a field it stopped accepting (or a bigint it
  // started rejecting) would leave every assertion above passing while every
  // live post create is refused 40132.
  const builtAgreement = new DocumentActionFeeAgreement(actionFeeAgreementOptions(postFee, 1000n));
  check('the constructed DocumentActionFeeAgreement carries the amounts, pricing and tolerance it was given',
    builtAgreement.moderators === 80_000_000n && builtAgreement.owner === 0n &&
      builtAgreement.pricing === 'feeMultiplier' && builtAgreement.knownFeeMultiplierPermille === 1000n &&
      builtAgreement.feeMultiplierIncreaseTolerancePercent === 20,
    `${builtAgreement.pricing} ${builtAgreement.moderators} @${builtAgreement.knownFeeMultiplierPermille}permille`);
  check('a fixed-priced agreement round-trips with NO multiplier',
    new DocumentActionFeeAgreement(actionFeeAgreementOptions({ owner: 0n, moderators: 5n, pricing: 'fixed' })).knownFeeMultiplierPermille === undefined);

  const yappBag = paymentInfo(TOKEN_COST.post, { gasFeesPaidBy: PREFER_CONTRACT_OWNER }).tokenPaymentInfo.toJSON();
  check('a YAPP payment asks the contract owner to pay the gas (PreferContractOwner), never insists',
    yappBag.gasFeesPaidBy === 'PreferContractOwner' && Number(yappBag.maximumTokenCost) === TOKEN_COST.post,
    JSON.stringify(yappBag));
  check('a payment with no gas offer leaves the signer paying the gas',
    paymentInfo(TOKEN_COST.post).tokenPaymentInfo.toJSON().gasFeesPaidBy === 'DocumentOwner');
  check('a credits write carries NO token payment info at all (that is what makes it pay credits)',
    JSON.stringify(paymentInfo(undefined)) === '{}');

  // A 40134 is the one consensus refusal a retry can fix — but only after the
  // cached multiplier is dropped, so the matcher must not swallow its
  // neighbours (40132/40133 mean the client is wrong and retrying is waste).
  check('the stale-multiplier matcher recognises 40134 by code and by name', (() => {
    const byCode = FEE_MULTIPLIER_NOT_TOLERATED.test('rejected: code=40134');
    const byName = FEE_MULTIPLIER_NOT_TOLERATED.test('DocumentActionFeeMultiplierNotToleratedError: ... but the fee multiplier is 1500 permille');
    return byCode && byName;
  })());
  check('it does not claim the agreement codes a retry cannot fix, or digits inside an amount',
    !FEE_MULTIPLIER_NOT_TOLERATED.test('code=40132') && !FEE_MULTIPLIER_NOT_TOLERATED.test('code=40133') &&
      !FEE_MULTIPLIER_NOT_TOLERATED.test('insufficient balance: 4013400 credits required'));
  // A stub epoch source: the multiplier is cached per process, so the only way
  // to see the cache work (and the only way to see it dropped) is to change
  // what the source says between reads.
  let epochReads = 0;
  const epochSaying = (permille) => ({ epoch: { current: async () => { epochReads += 1; return { feeMultiplierPermille: permille }; } } });
  forgetFeeMultiplier();
  const first = await feeMultiplierPermille(epochSaying(1000n));
  const cached = await feeMultiplierPermille(epochSaying(1500n));
  check('the epoch multiplier is read once per process, not per create',
    first === 1000n && cached === 1000n && epochReads === 1, `reads=${epochReads} first=${first} cached=${cached}`);
  forgetFeeMultiplier();
  const afterForget = await feeMultiplierPermille(epochSaying(1500n));
  check('forgetting it (after a 40134) makes the next agreement re-read the epoch',
    afterForget === 1500n && epochReads === 2, `reads=${epochReads} after=${afterForget}`);
  forgetFeeMultiplier();

  // The currency is a property of the ACTOR, fixed by persona index, so a
  // resumed run never moves an author between the two funding models.
  const share = (fraction) => Array.from({ length: 1000 }, (_, i) => paysInCredits(i, fraction)).filter(Boolean).length / 1000;
  check('credits fraction: 0 pays everyone in YAPP, 1 pays everyone in credits',
    share(0) === 0 && share(1) === 1);
  check('credits fraction: 0.25 splits about a quarter of actors onto credits', Math.abs(share(0.25) - 0.25) < 0.05, `${share(0.25)}`);
  check('credits fraction: an actor keeps its currency across calls (a resume must not switch it)',
    Array.from({ length: 50 }, (_, i) => paysInCredits(i, 0.25)).every((v, i) => v === paysInCredits(i, 0.25)));
  const creditsAuthors = new Set([0, 1, 2].filter((idx) => paysInCredits(idx, 1)));
  check('credits actors are excluded from the YAPP estimate (counting them over-funds the run)',
    corpusYappCost(ops, { paysCredits: (idx) => creditsAuthors.has(idx) }).total === 0 &&
      corpusYappCost(ops).total === 48);

  // Protocol 14 document id: the derivation is consensus (wasm-dpp2's
  // `Document.generateId` from beta.4), pinned to rs-dpp's `PINNED_V1_ID`
  // (generate_document_id.rs) — contract [1;32], owner [2;32], type "note",
  // entropy [7;32], nonce 1. `lib/document-id.test.ts` pins the browser path to
  // the same vector.
  await ensureInitialized();
  const ones = new Uint8Array(32).fill(1), twos = new Uint8Array(32).fill(2), sevens = new Uint8Array(32).fill(7);
  const pinnedId = deriveDocumentIdBytes({ contractId: ones, ownerId: twos, docType: 'note', entropy: sevens, nonce: 1n });
  const pinnedHex = Buffer.from(pinnedId).toString('hex');
  check('document id: derivation matches the platform pinned v1 vector', pinnedHex === 'e574ae73396611a517691d1f89275b6e99642cb9c176ce8cf879b1665c50f15f', pinnedHex);
  const note = { contractId: bs58.encode(ones), docType: 'note', ownerId: bs58.encode(twos), data: {}, entropy: sevens };
  const withNonce = buildDocument({ ...note, nonce: 1n });
  check('document id: buildDocument with a nonce carries the derived id', withNonce.id === bs58.encode(pinnedId) && String(withNonce.document.id) === withNonce.id);
  const placeholder = buildDocument(note);
  check('document id: buildDocument without a nonce returns no id (placeholder for documents.create)', placeholder.id === null && String(placeholder.document.id) !== withNonce.id);
  check('document id: createdId reads the confirmed document, never the placeholder', createdId(withNonce.document) === withNonce.id && createdId(null) === null && createdId(undefined) === null);

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
  console.error('         [--concurrency 10] [--max-ops N] [--credits-fraction 0.25] [--require-dhash]');
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
  requireSeededTopology();
  await ensureInitialized();
  const personas = loadPersonas(args.personas);
  const { ops, stats } = parseCorpus(readFileSync(args.corpus, 'utf8'), personas);
  const { total: yappNeeded, perAuthor } = corpusYappCost(ops, { paysCredits: (idx) => paysInCredits(idx, args.creditsFraction) });
  console.log(`corpus: ${ops.length} ops (${Object.entries(stats).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}`).join(', ')})`);
  if (args.creditsFraction > 0) {
    console.log(`payment: ${Math.round(args.creditsFraction * 100)}% of actors pay CREDITS (no $tokenPaymentInfo), the rest pay YAPP with the contract owner offered the gas`);
  }
  {
    const [post, reply] = [actionFeeFor('post'), actionFeeFor('reply')];
    console.log(`action fees: post ${post.moderators} + reply ${reply.moderators} credits to the moderators pot, ${post.pricing} pricing — every post/reply create is a hand-built batch carrying the agreement`);
  }
  console.log(`YAPP required if run from scratch: ${yappNeeded} total, max ${Math.max(0, ...perAuthor.values())} for one author`);

  const ledger = loadLedger();
  const progress = loadProgress();
  if (progress.completed.size > 0) {
    console.log(`checkpoint: ${progress.completed.size} line(s) already complete, ${progress.refs.size} ref(s) known (${PROGRESS_FILE})`);
  }

  const contractId = socialContractId();
  // The journal keys records by corpus LINE and names documents of one
  // contract: resumed against another contract (or a corpus with lines added
  // or removed) it would skip the wrong lines and bind refs to foreign ids.
  // Records carry the contract they were written to; refuse a mismatch.
  const journaledContracts = new Set([...progress.completed.values()].map((record) => record.contractId).filter(Boolean));
  if ([...journaledContracts].some((id) => id !== contractId)) {
    throw new Error(`${PROGRESS_FILE} was written against ${[...journaledContracts].join(', ')}, not ${contractId}: move it aside to seed this contract from scratch`);
  }
  if (progress.completed.size > 0 && journaledContracts.size === 0) {
    console.log(`WARNING: ${PROGRESS_FILE} predates contract stamping; resume only if it was written against ${contractId} and this exact corpus`);
  }
  const handle = createSdkHandle({ contractIds: [contractId], timeoutMs: SDK_TIMEOUT_MS, log: (msg) => console.log(`  ${msg}`) });
  const { protocolVersion } = await handle.connect();
  console.log(`connected to devnet (PV${protocolVersion ?? '?'}), contract ${contractId}`);

  const actors = await buildActors(handle, ledger, personas, ops, args.creditsFraction);
  console.log(`actors: ${actors.size} identities loaded from the ledger`);
  const tokenId = await readback(handle, () => handle.sdk.tokens.calculateId(contractId, YAPP_TOKEN_POSITION));
  const before = await snapshotBalances(handle, actors, tokenId);
  const mediaFor = await resolveCorpusMedia(ops.filter((op) => !progress.completed.has(op.line)), {
    log: (m) => console.log(`  ${m}`), cacheFile: mediaCacheFile(), requireDhash: args.requireDhash,
  });

  const executor = args.pipeline
    ? (await import('./pipeline.mjs')).buildPipelinedExecutor({
        handle, contractId, actors, ledger, progressRefs: progress.refs,
        planOp, mediaFor, entryExists, paymentFor: writeShapeFor({ handle }).paymentFor,
        window: args.window,
      })
    : buildExecutor({ handle, contractId, actors, progressRefs: progress.refs, mediaFor });
  if (args.pipeline) console.log(`executor: PIPELINED (window ${args.window} in flight per identity, concurrency ${args.concurrency})`);
  // The engine publishes refs through deferreds; the executor reads settled
  // records from progress.refs, so keep the two in sync as records land.
  const journal = (record) => {
    appendProgress({ ...record, contractId });
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
