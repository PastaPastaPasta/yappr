/**
 * Takes the public posts and replies of TEST identities (the battery bots, the
 * devnet e2e pool) off the social timeline, by the author's own delete: every
 * live post (quotes and bare reposts included) and every reply that is not yet
 * a tombstone becomes one, `{ deleted: true }` plus the fields the contract
 * freezes unconditionally (`socialShapes(…).tombstone`: a post's `hashtag` or
 * `tags`, a reply's `rootPostId`, `replyToReplyId` and, up to v13, its stored
 * owners). From social v11 posts
 * and replies are `canBeDeleted: false` and the app hides tombstones in every
 * feed (`tombstonesAreHidden()` in lib/contract-topology.ts), so a tombstone is
 * how test content leaves. Each identity signs and pays for its own
 * tombstones, which refund the content's storage. The maker's moderator delete
 * is never used, and the maker (or the contract's owner) is refused outright.
 *
 * Idempotent: only live documents are touched, so a second run finds nothing.
 * Only the identities passed in are queried (`$ownerId ==` on each type's
 * owner index), and a document is tombstoned only when its stored owner is
 * that identity. `since` (ms) narrows the run to documents whose `$createdAt`
 * is at or after it. Transient DAPI faults (quorum rotations, an exhausted
 * address pool, timeouts) are retried with backoff, reconnecting through
 * `reconnect` when the instance itself is dead. An identity whose tombstones
 * keep failing is given up on after FAILURES_BEFORE_GIVING_UP in a row, so a
 * dead network cannot hold a battery's verdict back for long.
 *
 * It takes everything an identity wrote since `since`, not only one run's
 * documents: two runs sharing a bot at once would clean each other's fixtures,
 * so a bot set runs one battery at a time (as the CI pool's concurrency group
 * already ensures for the e2e).
 *
 * Used by scripts/clean-test-content.mjs (the CLI and the devnet e2e job's
 * cleanup step) and by verify-v10's end-of-run cleanup (verify-lib
 * `runBattery`). Prints no key material.
 */
import bs58 from 'bs58';
import { Identifier } from '@dashevo/evo-sdk';
import { CRITICAL_AUTH_KEY_ID } from './derive-identities.mjs';
import { describeErr, signerFor } from './owner-keys.mjs';
import { asBase58, sleep } from './seed/seed-lib.mjs';
import { socialShapes } from './social-shapes.mjs';
import { buildDocument } from './verify-lib.mjs';

/** A fault of the transport, not a verdict on the request: retried with backoff. */
const TRANSIENT_ERROR = /quorum|no available addresses|transport|timed? ?out|deadline|gateway|\b50[234]\b|econnreset|fetch failed/i;
/** A dead SDK instance (as verify-lib's TRANSPORT_COLLAPSE): only these are worth a reconnect. */
const INSTANCE_DEAD = /no available addresses|invalid quorum|quorum not found/i;
/** A consensus refusal (a 10xxx/40xxx code): a re-broadcast of the same document would be refused the same way… */
const CONSENSUS_REFUSAL = /\bcode"?\s*[=:]\s*(10|4[01])\d{3}\b/;
/** …unless the identity nonce or the revision went stale, which a re-read and a fresh broadcast cure. */
const STALE_WRITE = /\bcode"?\s*[=:]\s*(40001|40106)\b|identity (contract )?nonce|invalid ?document ?revision/i;

const PAGE = 100;
const MAX_PAGES = 50;
const READ_TRIES = 6;
const BROADCAST_TRIES = 3;
const CONFIRM_POLLS = 6;
const FAILURES_BEFORE_GIVING_UP = 3;
/** The earliest `--since` read as milliseconds (2001-09-09): a smaller number is seconds, or a year, by mistake. */
const MIN_SINCE_MS = 1e12;

/** A refused query arrives as a "transport error" too (gRPC invalid argument); retrying it only repeats the refusal. */
const REFUSED_QUERY = /invalid argument|non indexed property/i;

export const isTransient = (error) => {
  const text = typeof error === 'string' ? error : describeErr(error);
  return TRANSIENT_ERROR.test(text) && !REFUSED_QUERY.test(text);
};

/**
 * A queried document as `{ id, ownerId, createdAt, revision, data }`: the
 * SDK's Document (its getters, and `toObject()` for the data, identifiers as
 * bytes) or a plain object carrying `$id`, `$ownerId`, `$createdAt`, `$revision`.
 */
export function storedOf(doc) {
  const data = typeof doc?.toObject === 'function' ? doc.toObject() : { ...doc };
  const createdAt = doc?.createdAt ?? data.$createdAt;
  return {
    id: asBase58(doc?.id ?? data.$id),
    ownerId: asBase58(doc?.ownerId ?? data.$ownerId),
    createdAt: createdAt === undefined || createdAt === null ? null : Number(createdAt),
    revision: BigInt(doc?.revision ?? data.$revision ?? 1),
    data,
  };
}

/**
 * What a cleanup tombstones of `ownerId`'s queried `docs`: those it owns that
 * are not yet tombstones, created at or after `since` (ms; null for all). A
 * document with no readable `$createdAt` is left alone when `since` is set.
 *
 * @param {unknown[]} docs
 * @param {{ ownerId: string, since?: number | null }} options
 */
export function cleanupTargets(docs, { ownerId, since = null }) {
  return docs
    .map(storedOf)
    .filter((stored) => stored.ownerId === ownerId && stored.data.deleted !== true)
    .filter((stored) => since === null || (stored.createdAt !== null && stored.createdAt >= since));
}

/**
 * Throws when an identity to clean is one the caller refuses (the maker, the
 * contract's owner): their content is not test content, and nothing here may
 * sign for them.
 */
export function refuseIdentities(identities, refused) {
  const banned = new Set([...refused].filter(Boolean));
  const hit = identities.filter(({ id }) => banned.has(id));
  if (hit.length > 0) throw new Error(`refusing to clean ${hit.map(({ id, label }) => label ?? id).join(', ')}: the maker or the contract owner, not a test identity`);
}

/**
 * The reads that list `ownerId`'s posts and replies: each type's owner index
 * (`post.ownerAndTime`, `live == true` pinned first from v13, which leaves the
 * tombstones out; `reply.ownerAndTime`, tombstones included), from `since`
 * when given. Newest first: what Recent shows is read before the page cap
 * could cut a long history short.
 *
 * @param {ReturnType<typeof socialShapes>} shapes
 * @param {string} ownerId
 * @param {number | null} [since]
 */
export function ownerQueries(shapes, ownerId, since = null) {
  const where = [['$ownerId', '==', ownerId], ...(since === null ? [] : [['$createdAt', '>=', since]])];
  const orderBy = [['$ownerId', 'asc'], ['$createdAt', 'desc']];
  return { post: shapes.ownerPosts({ where, orderBy }), reply: { where, orderBy } };
}

/** `--since`: epoch milliseconds, or anything `Date.parse` reads (an ISO time). Epoch seconds or a bare year are refused. */
export function parseSince(value) {
  const text = String(value ?? '').trim();
  const ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  if (!Number.isFinite(ms) || ms < MIN_SINCE_MS) throw new Error(`--since ${JSON.stringify(value)}: give epoch milliseconds or an ISO time`);
  return ms;
}

/** The reads and writes of one cleanup, retrying transient faults on the current SDK. */
function session({ sdk, contractId, reconnect, settleMs }) {
  const state = { sdk };
  const retrying = async (fn) => {
    let last;
    for (let attempt = 0; attempt < READ_TRIES; attempt++) {
      try {
        return await fn(state.sdk);
      } catch (e) {
        last = e;
        const reason = describeErr(e);
        if (!isTransient(reason)) throw e;
        if (reconnect && INSTANCE_DEAD.test(reason)) state.sdk = (await reconnect(reason).catch(() => null)) ?? state.sdk;
        await sleep(settleMs * (attempt + 1));
      }
    }
    throw last;
  };
  const docsOf = (page) => [...(page?.values?.() ?? [])].filter(Boolean);
  /** Every page of a read, newest first; `truncated` when MAX_PAGES full pages left older documents unread. */
  const queryAll = async (type, { where, orderBy }) => {
    const docs = [];
    let startAfter;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = docsOf(await retrying((s) => s.documents.query({ dataContractId: contractId, documentTypeName: type, where, orderBy, limit: PAGE, ...(startAfter ? { startAfter } : {}) })));
      docs.push(...batch);
      if (batch.length < PAGE) return { docs, truncated: false };
      startAfter = storedOf(batch.at(-1)).id;
    }
    return { docs, truncated: true };
  };
  const get = async (type, id) => {
    const doc = await retrying((s) => s.documents.get(contractId, type, id));
    return doc ? storedOf(doc) : null;
  };
  return { state, retrying, queryAll, get, docsOf };
}

/** The signer of `who`: given (a battery's `{ identityKey, signer }`), or built from its WIF after checking it against the chain. */
async function signerOf(io, who) {
  if (who.identityKey && who.signer) return who;
  if (!who.wif) throw new Error(`${who.label ?? who.id}: no key to sign its tombstones with`);
  const { identityKey, signer } = await io.retrying((s) => signerFor(s, { ownerId: who.id, keyId: who.keyId ?? CRITICAL_AUTH_KEY_ID, wif: who.wif, publicKeyHex: who.publicKeyHex }));
  return { ...who, identityKey, signer };
}

/**
 * Tombstones one document of `who`'s, decided by reading it back: the
 * broadcast's own answer is not trusted (the gateway 504s waits that landed).
 * A consensus refusal stops at once; a transient failure, a stale nonce or a
 * stale revision re-reads the document and broadcasts again, at most
 * BROADCAST_TRIES times. Throws only when a read keeps failing.
 */
async function tombstoneOne(io, { contractId, shapes, settleMs }, who, type, stored) {
  let lastError = null;
  for (let attempt = 0; attempt < BROADCAST_TRIES; attempt++) {
    const current = attempt === 0 ? stored : await io.get(type, stored.id);
    if (!current) return { ok: false, error: 'the document is gone (a moderator removed it?)' };
    if (current.data.deleted === true) return { ok: true };
    if (current.ownerId !== who.id) return { ok: false, error: `owned by ${current.ownerId}, not ${who.id}` };
    const { document } = buildDocument({ contractId, docType: type, ownerId: who.id, data: shapes.tombstone(type, current.data), revision: current.revision + 1n, id: bs58.decode(current.id) });
    let error = null;
    try {
      await io.state.sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer });
    } catch (e) {
      error = describeErr(e);
    }
    for (let poll = 0; poll < CONFIRM_POLLS; poll++) {
      const now = await io.get(type, stored.id).catch(() => null);
      if (now?.data.deleted === true) return { ok: true };
      if (error && CONSENSUS_REFUSAL.test(error) && !STALE_WRITE.test(error)) return { ok: false, error };
      await sleep(settleMs);
    }
    lastError = error ?? 'not a tombstone after the replace';
    if (error && !isTransient(error) && !STALE_WRITE.test(error)) break;
    // A failed broadcast may leave the SDK's cached identity contract nonce behind; read it afresh.
    try {
      await io.state.sdk.wasm?.refreshIdentityNonce?.(new Identifier(who.id));
    } catch {
      // Best effort: the next broadcast reports a stale nonce on its own.
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Lists, and with `live` tombstones, the live posts and replies each of
 * `identities` (`{ id, label?, identityKey?, signer?, wif?, keyId?, publicKeyHex? }`)
 * wrote on the social contract `contractId` (`contract`: its JSON, the cut it
 * was registered from), from `since` (ms) when given. Refuses `refuse` and the
 * contract's owner. Answers the counts:
 * `{ mode, found, tombstoned, failed, incomplete, spentCredits, identities: [{ id, label, posts, replies, tombstoned?, failed?, spentCredits?, errors?, documents? }] }`.
 * `incomplete` counts the identities whose documents could not all be read
 * (a read kept failing, or the page cap cut an old history short): re-run
 * those. A plan lists each document (`documents`). One identity's failure is
 * counted, never thrown, so the others are still cleaned.
 */
export async function cleanTestContent({ sdk, contractId, contract, identities, since = null, live = false, refuse = [], reconnect, log = console.log, settleMs = 2500 }) {
  const shapes = socialShapes(contract);
  shapes.tombstone('post', {}); // throws on a cut whose authors delete for real (v10): nothing here applies

  const io = session({ sdk, contractId, reconnect, settleMs });
  const onChain = await io.retrying((s) => s.contracts.fetch(contractId));
  if (!onChain) throw new Error(`no contract ${contractId} on this network`);
  const unique = [...new Map(identities.map((who) => [who.id, who])).values()];
  refuseIdentities(unique, [...refuse, asBase58(onChain.ownerId)]);

  const summary = { mode: live ? 'live' : 'plan', found: 0, tombstoned: 0, failed: 0, incomplete: 0, spentCredits: 0n, identities: [] };
  for (const who of unique) {
    const row = { id: who.id, label: who.label ?? who.id, posts: 0, replies: 0, errors: [] };
    summary.identities.push(row);
    try {
      await cleanIdentity({ io, contractId, shapes, since, live, log, settleMs }, who, row);
    } catch (e) {
      row.errors.push(describeErr(e).slice(0, 200));
      summary.incomplete += 1;
      log(`WARN  ${row.label}: stopped: ${row.errors.at(-1)}`);
    }
    if (row.truncated) summary.incomplete += 1;
    summary.found += row.posts + row.replies;
    summary.tombstoned += row.tombstoned ?? 0;
    summary.failed += row.failed ?? 0;
    summary.spentCredits += row.spentCredits ?? 0n;
    if (row.errors.length === 0) delete row.errors;
  }
  return summary;
}

/** One identity's part of {@link cleanTestContent}, filling `row` as it goes. */
async function cleanIdentity({ io, contractId, shapes, since, live, log, settleMs }, who, row) {
  const queries = ownerQueries(shapes, who.id, since);
  const targets = [];
  for (const type of ['post', 'reply']) {
    const { docs, truncated } = await io.queryAll(type, queries[type]);
    if (truncated) {
      row.truncated = true;
      log(`WARN  ${row.label}: more than ${MAX_PAGES * PAGE} ${type} documents; only the newest were read (narrow with --since, or run again)`);
    }
    for (const stored of cleanupTargets(docs, { ownerId: who.id, since })) targets.push({ type, stored });
  }
  row.posts = targets.filter((t) => t.type === 'post').length;
  row.replies = targets.length - row.posts;
  if (!live) {
    row.documents = targets.map(({ type, stored }) => ({ type, id: stored.id, createdAt: stored.createdAt === null ? null : new Date(stored.createdAt).toISOString() }));
    return;
  }
  if (targets.length === 0) return;
  Object.assign(row, { tombstoned: 0, failed: 0 });
  let signing;
  try {
    signing = await signerOf(io, { ...who, label: row.label });
  } catch (e) {
    row.failed = targets.length;
    row.errors.push(`cannot sign its tombstones: ${describeErr(e).slice(0, 200)}`);
    log(`WARN  ${row.label}: ${row.errors[0]}`);
    return;
  }
  const balance = () => io.retrying((s) => s.identities.balance(who.id)).then(BigInt, () => null);
  const before = await balance();
  let failingInARow = 0;
  for (const [index, { type, stored }] of targets.entries()) {
    if (failingInARow >= FAILURES_BEFORE_GIVING_UP) {
      row.failed += targets.length - index;
      row.errors.push(`gave up after ${FAILURES_BEFORE_GIVING_UP} failures in a row; ${targets.length - index} left live`);
      break;
    }
    const outcome = await tombstoneOne(io, { contractId, shapes, settleMs }, signing, type, stored)
      .catch((e) => ({ ok: false, error: describeErr(e) }));
    if (outcome.ok) {
      row.tombstoned += 1;
      failingInARow = 0;
    } else {
      row.failed += 1;
      failingInARow += 1;
      row.errors.push(`${type} ${stored.id}: ${outcome.error.slice(0, 200)}`);
    }
  }
  const after = await balance();
  if (before !== null && after !== null) row.spentCredits = before - after;
  log(`${row.failed ? 'WARN ' : 'OK   '} ${row.label}: tombstoned ${row.tombstoned} of ${targets.length} (${row.posts} posts, ${row.replies} replies)${row.failed ? `; failed ${row.failed}: ${row.errors[0]}` : ''}`);
}

/**
 * The newest posts on the global `timeline` index, with the live ones by any of
 * `identities` (or by an id in `others`, e.g. `{ [makerId]: 'maker' }`) counted
 * per owner: what a visitor's Recent shows first.
 */
export async function surveyTimeline({ sdk, contractId, identities, others = {}, limit = 60, reconnect, settleMs = 2500 }) {
  const io = session({ sdk, contractId, reconnect, settleMs });
  const page = await io.retrying((s) => s.documents.query({ dataContractId: contractId, documentTypeName: 'post', where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']], limit }));
  const labels = new Map([...Object.entries(others), ...identities.map(({ id, label }) => [id, label ?? id])]);
  const survey = { scanned: 0, live: 0, byTestIdentities: 0, byOthers: 0, owners: {} };
  for (const stored of io.docsOf(page).map(storedOf)) {
    survey.scanned += 1;
    if (stored.data.deleted === true) continue;
    survey.live += 1;
    const label = labels.get(stored.ownerId);
    if (label === undefined) { survey.byOthers += 1; continue; }
    if (identities.some(({ id }) => id === stored.ownerId)) survey.byTestIdentities += 1;
    survey.owners[label] = (survey.owners[label] ?? 0) + 1;
  }
  return survey;
}
