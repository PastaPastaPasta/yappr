/**
 * LIVE fees of the social writes: the credits each write actually cost its
 * signer, read as the identity's balance before and after the confirmed write
 * (the SDK does not return a transition's fee). Every figure is measured at
 * least three times, beside `documentCreateCost`'s estimate for the same
 * contract, so the estimator can be checked against the chain.
 *
 * It registers a THROWAWAY contract from a social cut: post, reply, like and
 * likeReply exactly as the file declares them (indexes, references,
 * preallocation, moderation, tombstone rules), minus the YAPP token costs and
 * the action fees, which are contract charges added on top of the fee (an
 * 80M-credit moderators fee per post and 16M per reply on v10/v11, and 10 / 3
 * / 1 YAPP) and would only blur the comparison.
 *
 * Measured (each 3×):
 *   like-first / like-later           untagged, on a fresh post
 *   tagged-first / tagged-later       tagged post
 *   reply-like-first / reply-like-later
 *   post, post-tagged, quote, repost, reply
 *   tombstone                         design M only (a post's author replace)
 *   unlike                            the refund (a negative cost)
 *
 * Usage (NETWORK=devnet, the devnet from the env):
 *   node scripts/measure-social-fees.mjs --contract-file contracts/yappr-social-contract-v11.json \
 *     --bot 1 --bot 0 --bot 2 --identity-id <id> --key-wif-file <file> [--json <out>]
 * The first identity registers the contract and writes the posts; the other
 * three like and reply. Never the maker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DataContract, PlatformVersion, PrivateKey, documentCreateCost, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import { devnetConfig, devnetSdk, envValue } from './sdk-env.mjs';
import { REPO_ROOT, createdId, findRecentByValues } from './seed/seed-lib.mjs';
import { buildDocument, randomIdBytes } from './verify-lib.mjs';

const RUNS = 3;
const TRANSPORT_COLLAPSE = /no available addresses|invalid quorum|quorum not found/i;
/** The SDK instance a quorum rotation or a dead gateway set can replace (as verify-lib does). */
const session = { sdk: null, config: null, contracts: [] };
const sdk = new Proxy({}, { get(_, property) { const value = session.sdk[property]; return typeof value === 'function' ? value.bind(session.sdk) : value; } });
async function connectSession() {
  const fresh = devnetSdk({ timeoutMs: 30000, config: session.config });
  await fresh.connect();
  await fresh.epoch.current();
  for (const contractId of session.contracts) await fresh.contracts.fetch(contractId);
  session.sdk = fresh;
}
/** Runs `fn`, reconnecting and running it again (up to 3 times) when the transport collapsed. */
async function withReconnect(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 3 || !TRANSPORT_COLLAPSE.test(describeErr(e))) throw e;
      console.log(`     (transport collapsed, reconnecting: ${describeErr(e).slice(0, 100)})`);
      await sleep(3000);
      await connectSession().catch(() => {});
    }
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CENTS_PER_CREDIT = 60 * 100 / 1e11;

function parseArgs(argv) {
  const args = { actors: [], contractFile: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract-file': args.contractFile = isAbsolute(argv[i + 1]) ? argv[++i] : join(REPO_ROOT, argv[++i]); break;
      case '--json': args.json = argv[++i]; break;
      case '--bot': { const [index, id] = argv[++i].split(':'); args.actors.push({ kind: 'bot', index: Number(index), id: id || null }); break; }
      case '--identity-id': args.actors.push({ kind: 'wif', id: argv[++i], wifFile: null }); break;
      case '--key-wif-file': args.actors.at(-1).wifFile = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contractFile || args.actors.length !== 4) throw new Error('need --contract-file and four identities (the poster, then three likers)');
  return args;
}

/** post, reply, like and likeReply as the file declares them, minus token costs and action fees. */
function measureContractSource(file) {
  const social = JSON.parse(readFileSync(file, 'utf8'));
  const documentSchemas = {};
  for (const type of ['post', 'reply', 'like', 'likeReply']) {
    const schema = structuredClone(social.documentSchemas[type]);
    delete schema.actionFees;
    delete schema.tokenCost;
    documentSchemas[type] = schema;
  }
  const config = structuredClone(social.config);
  const moderators = config.moderation?.moderators;
  if (moderators?.moderatedDocumentTypes) {
    moderators.moderatedDocumentTypes = Object.fromEntries(Object.entries(moderators.moderatedDocumentTypes).filter(([type]) => documentSchemas[type]));
  }
  return { $formatVersion: social.$formatVersion, version: 1, config, documentSchemas };
}

async function resolveActor(sdk, actor, label) {
  if (actor.kind === 'bot') {
    const ownerId = actor.id ?? (envValue('DEVNET_IDENTITY_IDS') || envValue('E2E_IDENTITY_IDS') || '').split(',')[actor.index]?.trim();
    return { label, ownerId, ...(await signerFor(sdk, resolveOwner({ botIndex: actor.index, ownerId }))) };
  }
  const wif = readFileSync(actor.wifFile, 'utf8').trim();
  const hash = PrivateKey.fromWIF(wif).getPublicKeyHash();
  const identity = await sdk.identities.fetch(actor.id);
  const key = identity.publicKeys.find((k) => k.getPublicKeyHash() === hash && /^auth/i.test(k.purpose) && /^(critical|high)$/i.test(k.securityLevel));
  if (!key) throw new Error(`${actor.wifFile} is not a HIGH or CRITICAL authentication key of ${actor.id}`);
  return { label, ownerId: actor.id, ...(await signerFor(sdk, { ownerId: actor.id, keyId: key.keyId, wif })) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureInitialized();
  const source = measureContractSource(args.contractFile);
  session.config = devnetConfig();
  await connectSession();
  const [P, ...likers] = await Promise.all(args.actors.map((actor, i) => resolveActor(sdk, actor, ['P', 'L1', 'L2', 'L3'][i])));
  const nonce = ((await sdk.identities.nonce(P.ownerId)) ?? 0n) + 1n;
  const draft = DataContract.fromJSON({ ...source, id: DataContract.generateId(P.ownerId, nonce).toBase58(), ownerId: P.ownerId }, true, PlatformVersion.latest());
  const contractId = (await sdk.contracts.publish({ dataContract: draft, identityKey: P.identityKey, signer: P.signer })).id.toBase58();
  session.contracts.push(contractId);
  console.log(`measurement contract ${contractId} (${args.contractFile.replace(/^.*\//, '')}), registered by P=${P.ownerId}`);
  await sleep(3000);
  const contract = await sdk.contracts.fetch(contractId);
  const id = (value) => bs58.decode(value);
  const tombstones = source.documentSchemas.post.properties.deleted !== undefined;

  // ---- balances ----
  const balanceOf = async (who) => BigInt((await withReconnect(() => sdk.identities.fetch(who.ownerId)))?.balance ?? 0);
  /** Waits until two reads agree and differ from `before` (a lagging node can serve the old balance). */
  async function settledBalance(who, before) {
    let last = null;
    for (let tries = 0; tries < 20; tries++) {
      await sleep(2000);
      const now = await balanceOf(who).catch(() => null);
      if (now !== null && now !== before && now === last) return now;
      last = now;
    }
    return last ?? before;
  }
  /** The fee of one confirmed write; null (not recorded) when the write did not land. */
  async function costOf(who, write) {
    const before = await balanceOf(who);
    const outcome = await write();
    if (outcome?.ok === false) { console.log(`     (not landed, not recorded: ${(outcome.error ?? '').slice(0, 120)})`); return null; }
    const after = await settledBalance(who, before);
    if (after === before) { console.log('     (balance unchanged, not recorded)'); return null; }
    return { credits: Number(before - after), ...(outcome?.id ? { id: outcome.id } : {}) };
  }

  // ---- writes ----
  async function create(who, docType, data) {
    const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data, entropy: randomIdBytes() });
    const since = Date.now();
    try {
      const created = await sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer });
      const createdAs = createdId(created);
      if (createdAs) return { ok: true, id: createdAs };
    } catch (e) {
      const error = describeErr(e);
      if (/\bcode"?\s*[=:]\s*\d{4,5}\b/.test(error)) return { ok: false, error };
      if (TRANSPORT_COLLAPSE.test(error)) await connectSession().catch(() => {});
    }
    for (let tries = 0; tries < 6; tries++) {
      await sleep(2500);
      const found = await findRecentByValues(sdk, { contractId, docType, ownerId: who.ownerId, data, since }).catch(() => null);
      if (found) return { ok: true, id: found };
    }
    return { ok: false, error: 'no document after the write' };
  }
  const targetField = (docType) => (docType === 'like' ? 'postId' : 'replyId');
  const liked = async (who, docType, data) => {
    const field = targetField(docType);
    const rows = await withReconnect(() => sdk.documents.query({ dataContractId: contractId, documentTypeName: docType, where: [[field, '==', bs58.encode(data[field])], ['$ownerId', '==', who.ownerId]], limit: 1 }));
    return [...(rows instanceof Map ? rows.values() : Object.values(rows ?? {}))].filter(Boolean).length === 1;
  };
  /** An indexOnly write is judged by the liked state, never by the create's own answer. */
  async function indexOnlyWrite(who, docType, data, write, wanted) {
    await write().catch(async (e) => { if (TRANSPORT_COLLAPSE.test(describeErr(e))) await connectSession().catch(() => {}); });
    for (let tries = 0; tries < 6; tries++) {
      if ((await liked(who, docType, data)) === wanted) return { ok: true };
      await sleep(2500);
    }
    return { ok: false, error: 'the liked state did not change' };
  }
  const like = (who, docType, data) => indexOnlyWrite(who, docType, data, () => {
    const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data, entropy: randomIdBytes() });
    return sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer });
  }, true);
  const unlike = (who, docType, data) => indexOnlyWrite(who, docType, data, () => {
    const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data });
    return sdk.documents.delete({ document, identityKey: who.identityKey, signer: who.signer });
  }, false);
  async function tombstone(who, docId, data) {
    const stored = await sdk.documents.get(contractId, 'post', docId);
    const revision = BigInt(stored?.revision ?? 1) + 1n;
    const { document } = buildDocument({ contractId, docType: 'post', ownerId: who.ownerId, data, revision, id: bs58.decode(docId) });
    await sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer }).catch(async (e) => { if (TRANSPORT_COLLAPSE.test(describeErr(e))) await connectSession().catch(() => {}); });
    for (let tries = 0; tries < 6; tries++) {
      const after = await withReconnect(() => sdk.documents.get(contractId, 'post', docId)).catch(() => null);
      if (BigInt(after?.revision ?? 0) >= revision) return { ok: true };
      await sleep(2500);
    }
    return { ok: false, error: 'the tombstone did not land' };
  }

  const results = {};
  const record = (key, measured) => {
    if (!measured) return;
    (results[key] ??= []).push(measured.credits);
    console.log(`  ${key.padEnd(18)} ${String(measured.credits).padStart(12)} credits`);
  };
  const text = (n) => `measured fee ${n} ${'x'.repeat(116)}`.slice(0, 140);

  for (let run = 0; run < RUNS; run++) {
    console.log(`\n--- run ${run + 1} ---`);
    const post = await costOf(P, () => create(P, 'post', { content: text(run) }));
    record('post', post);
    const tagged = await costOf(P, () => create(P, 'post', { content: text(run), hashtag: 'feemeasure' }));
    record('post-tagged', tagged);
    if (!post || !tagged) continue;
    const reply = await costOf(P, () => create(P, 'reply', { content: text(run), rootPostId: id(post.id), parentOwnerId: id(P.ownerId) }));
    record('reply', reply);
    const quoteTarget = await create(P, 'post', { content: text(run) });
    if (!reply || !quoteTarget.ok) continue;
    record('quote', await costOf(likers[run % 3], () => create(likers[run % 3], 'post', { content: text(run), quotedPostId: id(quoteTarget.id), quotedPostOwnerId: id(P.ownerId) })));
    record('repost', await costOf(likers[(run + 1) % 3], () => create(likers[(run + 1) % 3], 'post', { quotedPostId: id(quoteTarget.id), quotedPostOwnerId: id(P.ownerId) })));
    const postLike = { postId: id(post.id), postAuthor: id(P.ownerId) };
    const taggedLike = { postId: id(tagged.id), postAuthor: id(P.ownerId), hashtag: 'feemeasure' };
    const replyLike = { replyId: id(reply.id), replyAuthor: id(P.ownerId) };
    for (const [prefix, docType, data] of [['like', 'like', postLike], ['tagged', 'like', taggedLike], ['reply-like', 'likeReply', replyLike]]) {
      record(`${prefix}-first`, await costOf(likers[0], () => like(likers[0], docType, data)));
      record(`${prefix}-later`, await costOf(likers[1], () => like(likers[1], docType, data)));
      record(`${prefix}-later`, await costOf(likers[2], () => like(likers[2], docType, data)));
    }
    record('unlike', await costOf(likers[2], () => unlike(likers[2], 'like', postLike)));
    if (tombstones) record('tombstone', await costOf(P, () => tombstone(P, quoteTarget.id, { deleted: true })));
    // A deliberate pause keeps a run's writes clear of the next run's quorum checks.
    await sleep(2000);
  }

  // ---- the estimator, on the same contract ----
  const pv = PlatformVersion.latest();
  const plainPost = { content: { length: 140 } };
  const absent = (type, keep) => Object.fromEntries(Object.keys(source.documentSchemas[type].properties).filter((p) => !keep.includes(p)).map((p) => [p, { present: false }]));
  const estimate = (type, fields) => documentCreateCost(contract, type, { fields }, pv).totalCredits;
  const estimates = {
    'post': estimate('post', { ...absent('post', ['content']), ...plainPost }),
    'post-tagged': estimate('post', { ...absent('post', ['content', 'hashtag']), ...plainPost, hashtag: { present: true } }),
    'quote': estimate('post', { ...absent('post', ['content', 'quotedPostId', 'quotedPostOwnerId']), ...plainPost }),
    'repost': estimate('post', { ...absent('post', ['quotedPostId', 'quotedPostOwnerId']) }),
    'reply': estimate('reply', { ...absent('reply', ['content', 'rootPostId', 'parentOwnerId']), ...plainPost }),
    'like-first': estimate('like', { hashtag: { present: false } }),
    'like-later': estimate('like', { hashtag: { present: false } }),
    'tagged-first': estimate('like', { hashtag: { present: true } }),
    'tagged-later': estimate('like', { hashtag: { present: true } }),
    'reply-like-first': estimate('likeReply', {}),
    'reply-like-later': estimate('likeReply', {}),
  };
  const M = (n) => `${(n / 1e6).toFixed(1)}M`;
  console.log(`\n${args.contractFile.replace(/^.*\//, '')} on ${contractId}: live credits (mean of ${RUNS}+, min–max) vs documentCreateCost (new / known values), ¢ at $60/DASH`);
  const table = {};
  for (const [key, values] of Object.entries(results)) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const est = estimates[key];
    table[key] = { mean, min: Math.min(...values), max: Math.max(...values), n: values.length, estimateNew: est ? Number(est.newValues) : null, estimateKnown: est ? Number(est.knownValues) : null };
    console.log(`  ${key.padEnd(18)} live ${M(mean).padStart(8)} (${(mean * CENTS_PER_CREDIT).toFixed(2)}¢; ${M(Math.min(...values))}–${M(Math.max(...values))}, n=${values.length})${est ? `   estimate ${M(Number(est.newValues))} / ${M(Number(est.knownValues))}` : ''}`);
  }
  if (args.json) writeFileSync(args.json, `${JSON.stringify({ contractFile: args.contractFile, contractId, table }, null, 2)}\n`);
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error('ERROR:', describeErr(e)); process.exit(1); });
