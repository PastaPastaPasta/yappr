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
 *   unlike, unlike-tagged, reply-unlike   the refunds (negative costs)
 *   v13 only (media arrays, profile reports; the copy then also holds report):
 *   post-media-1 / post-media-4       one and four images (mediaUrls, mediaDigests, mediaKinds)
 *   report-post / report-profile      a liker reports the post, and a fresh identity's
 *                                     profile (`about: 1`); the 50M moderators action fee
 *                                     the published file charges is printed beside it
 *
 * Every write is built for the cut by scripts/social-shapes.mjs: on v13 posts
 * carry `live: true`, replies `rootOwnerId`, and a reply like is `{ replyId }`.
 *
 * Several cuts in one run (`--contract-file` repeated) are measured one after
 * the other by the same identities on the same network, then compared side by
 * side: v12 (counter author/hashtag indexes) against a v11 copy registered on
 * the same 5.0.0-beta.2 chain is the comparison docs/SOCIAL_V12.md records.
 * What the file declares picks the writes (a tombstone when post has
 * `deleted`); nothing keys on the file's name.
 *
 * Usage (NETWORK=devnet, the devnet from the env or .env.devnet):
 *   node scripts/measure-social-fees.mjs --contract-file contracts/yappr-social-contract-v12.json \
 *     --contract-file contracts/yappr-social-contract-v11.json \
 *     --bot 1 --bot 0 --bot 2 --bot 3 [--json <out>]
 *   node scripts/measure-social-fees.mjs --contract-file contracts/yappr-social-contract-v12.json --reuse <id> ...
 *     # measure again on a measurement contract an earlier run registered (printed as
 *     # "measurement contract <id>"), instead of registering another throwaway copy
 *   node scripts/measure-social-fees.mjs --contract-file <file> [--contract-file <file>] --dry-run
 *     # offline: build and parse each throwaway copy, print documentCreateCost's estimates
 * Identities: `--bot <n>[:<id>]` (seed index n of E2E_SEED_PHRASE, identity id n of
 * DEVNET_IDENTITY_IDS / E2E_IDENTITY_IDS) or `--identity-id <id> --key-wif-file <file>`, four
 * in all. The first (P) registers each contract and writes the posts; the other three like
 * and reply. Never the maker. Each registration costs P about 40 × 10⁹ credits.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DataContract, PlatformVersion, PrivateKey, documentCreateCost, ensureInitialized } from '@dashevo/evo-sdk';
import initWasmDpp2, { DataContract as NodeRulesDataContract, PlatformVersion as NodeRulesPlatformVersion } from '@dashevo/wasm-dpp2';
import bs58 from 'bs58';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import { devnetConfig, devnetSdk, envValue } from './sdk-env.mjs';
import { REPO_ROOT, createdId, findRecentByValues } from './seed/seed-lib.mjs';
import { buildDocument, randomIdBytes } from './verify-lib.mjs';
import { actionFeeOf, socialShapes } from './social-shapes.mjs';

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
  const args = { actors: [], cuts: [], json: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract-file': args.cuts.push({ file: isAbsolute(argv[i + 1]) ? argv[++i] : join(REPO_ROOT, argv[++i]), reuse: null }); break;
      case '--reuse': {
        const cut = args.cuts.at(-1);
        if (!cut || cut.reuse) throw new Error('--reuse <contractId> follows its --contract-file');
        cut.reuse = argv[++i];
        break;
      }
      case '--dry-run': args.dryRun = true; break;
      case '--json': args.json = argv[++i]; break;
      case '--bot': { const [index, id] = argv[++i].split(':'); args.actors.push({ kind: 'bot', index: Number(index), id: id || null }); break; }
      case '--identity-id': args.actors.push({ kind: 'wif', id: argv[++i], wifFile: null }); break;
      case '--key-wif-file': args.actors.at(-1).wifFile = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (args.cuts.length === 0) throw new Error('need at least one --contract-file');
  if (!args.dryRun && args.actors.length !== 4) throw new Error('need four identities (the poster, then three likers)');
  return args;
}

/**
 * post, reply, like and likeReply as the file declares them, minus token costs and action fees;
 * on v13 report too (its profile target and its action fee are new).
 */
function measureContractSource(file) {
  const social = JSON.parse(readFileSync(file, 'utf8'));
  const documentSchemas = {};
  const types = ['post', 'reply', 'like', 'likeReply', ...(socialShapes(social).cut.profileReports ? ['report'] : [])];
  for (const type of types) {
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

const fileName = (file) => file.replace(/^.*\//, '');
const M = (n) => `${(n / 1e6).toFixed(1)}M`;
/** The rows the measurement copy strips an action fee from, keyed as the results are: the fee the published file charges. */
function strippedActionFees(file) {
  const schemas = JSON.parse(readFileSync(file, 'utf8')).documentSchemas;
  const moderators = (type) => Number(actionFeeOf(schemas, type)?.moderators ?? 0);
  return { 'report-post': moderators('report'), 'report-profile': moderators('report') };
}
/** One media item of fixed bytes: the fee depends on the sizes, not the values. */
const mediaItems = (n) => Array.from({ length: n }, (_, i) => ({ url: `ipfs://bafyfeemeasure${i}`, sha256: new Uint8Array(32).fill(i + 1), fingerprint: new Uint8Array(8).fill(i + 1) }));

/**
 * documentCreateCost (#5159) for each measured create on `contract`, keyed as the live
 * results are: storage exact, processing estimated, new / known index values.
 */
function estimatesFor(contract, source) {
  const pv = PlatformVersion.latest();
  const { cut } = socialShapes(source);
  const plainPost = { content: { length: 140 } };
  // v13: every post carries `live` and every reply `rootOwnerId`, so neither is priced as absent.
  const always = { post: cut.liveMarker ? ['live'] : [], reply: cut.rootOwner ? ['rootOwnerId'] : [] };
  const absent = (type, keep) => Object.fromEntries(Object.keys(source.documentSchemas[type].properties).filter((p) => !keep.includes(p) && !(always[type] ?? []).includes(p)).map((p) => [p, { present: false }]));
  const estimate = (type, fields) => documentCreateCost(contract, type, { fields }, pv).totalCredits;
  /** `n` media items: n URLs (typed-array length), 40 n digest bytes, n kind bytes. */
  const media = (n) => ({ mediaUrls: { present: true, length: n }, mediaDigests: { present: true, length: 40 * n }, mediaKinds: { present: true, length: n } });
  const MEDIA = ['mediaUrls', 'mediaDigests', 'mediaKinds'];
  return {
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
    ...(cut.mediaArrays ? {
      'post-media-1': estimate('post', { ...absent('post', ['content', ...MEDIA]), ...plainPost, ...media(1) }),
      'post-media-4': estimate('post', { ...absent('post', ['content', ...MEDIA]), ...plainPost, ...media(4) }),
    } : {}),
    ...(cut.profileReports ? {
      'report-post': estimate('report', absent('report', ['postId', 'targetOwnerId', 'reason'])),
      'report-profile': estimate('report', absent('report', ['about', 'targetOwnerId', 'reason'])),
    } : {}),
  };
}

/** Offline: each cut's throwaway copy parses under both parsers, with the estimator's figures. */
async function dryRun(args) {
  await initWasmDpp2();
  const placeholder = '11111111111111111111111111111111';
  for (const { file, reuse } of args.cuts) {
    const source = measureContractSource(file);
    const json = { ...source, id: placeholder, ownerId: placeholder };
    const contract = DataContract.fromJSON(json, true, PlatformVersion.latest());
    NodeRulesDataContract.fromJSON(json, true, NodeRulesPlatformVersion.latest());
    const counters = source.documentSchemas.like.indices.filter((index) => index.summableOffCountIndex).map((index) => `${index.name}→${index.summableOffCountIndex}`);
    console.log(`\n${fileName(file)}: the measurement copy parses (wasm-sdk + wasm-dpp2); ${reuse ? `would reuse ${reuse}` : 'would register it'}; tombstone ${source.documentSchemas.post.properties.deleted !== undefined ? 'measured' : 'not on this cut'}; like counters ${counters.join(', ') || 'none'}`);
    // The live run's writes, as `create` / `like` fit them to the cut: each must be a valid create here.
    const shapes = socialShapes(source);
    const [x, y] = [randomIdBytes(), randomIdBytes()];
    const writes = [
      ['post', { content: 'x' }], ['post', { content: 'x', hashtag: 'feemeasure' }], ['post', { content: 'x', quotedPostId: x, quotedPostOwnerId: y }],
      ['post', { quotedPostId: x, quotedPostOwnerId: y }], ['reply', { content: 'x', rootPostId: x, parentOwnerId: y }],
      ['like', { postId: x, postAuthor: y }], ['like', { postId: x, postAuthor: y, hashtag: 'feemeasure' }], ['likeReply', { replyId: x, replyAuthor: y }],
      ...(shapes.cut.mediaArrays ? [1, 4].map((n) => ['post', { content: 'x', ...shapes.media(mediaItems(n)) }]) : []),
      ...(shapes.cut.profileReports ? [['report', shapes.report({ postId: x, targetOwnerId: y, reason: 1 })], ['report', shapes.report({ about: 1, targetOwnerId: y, reason: 1 })]] : []),
    ];
    for (const [docType, written] of writes) {
      const data = shapes.fit(docType, written);
      const { document } = buildDocument({ contractId: placeholder, docType, ownerId: placeholder, data, entropy: randomIdBytes(), createdAt: Date.now() });
      const problems = shapes.check(docType, data);
      const broken = contract.checkDocumentPropertyConstraints(document);
      if (problems.length > 0 || broken) throw new Error(`${fileName(file)}: the ${docType} write ${JSON.stringify(Object.keys(data))} is not valid: ${problems.join('; ')}${broken ? ` 10422 ${broken.rule}` : ''}`);
    }
    console.log(`  the ${writes.length} measured write shapes are valid creates of this cut (${Object.entries(shapes.cut).filter(([, on]) => on).map(([flag]) => flag).join(', ')})`);
    const stripped = strippedActionFees(file);
    for (const [key, estimate] of Object.entries(estimatesFor(contract, source))) {
      console.log(`  ${key.padEnd(18)} estimate ${M(Number(estimate.newValues)).padStart(8)} / ${M(Number(estimate.knownValues))}${stripped[key] ? `   + ${M(stripped[key])} moderators action fee (the published file's)` : ''}`);
    }
  }
  const { devnetName, addresses } = devnetConfig();
  console.log(`\nwould measure on devnet "${devnetName}" via ${addresses[0]} (+${addresses.length - 1} more)`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureInitialized();
  if (args.dryRun) return dryRun(args);
  session.config = devnetConfig();
  await connectSession();
  const [P, ...likers] = await Promise.all(args.actors.map((actor, i) => resolveActor(sdk, actor, ['P', 'L1', 'L2', 'L3'][i])));
  const measured = [];
  for (const cut of args.cuts) measured.push(await measureCut(cut, { P, likers }));
  if (measured.length > 1) {
    console.log(`\nside by side (live mean credits; the delta is each cut against ${fileName(measured[1].file)}):`);
    const keys = [...new Set(measured.flatMap((m) => Object.keys(m.table)))];
    console.log(`  ${'write'.padEnd(18)} ${measured.map((m) => fileName(m.file).replace(/^yappr-social-contract-|\.json$/g, '').padStart(10)).join(' ')}`);
    for (const key of keys) {
      const means = measured.map((m) => m.table[key]?.mean);
      const base = means[1];
      const cells = means.map((mean, i) => (mean === undefined ? '—' : `${M(mean)}${i !== 1 && base ? ` (${mean >= base ? '+' : ''}${(((mean - base) / Math.abs(base)) * 100).toFixed(0)}%)` : ''}`).padStart(10));
      console.log(`  ${key.padEnd(18)} ${cells.join(' ')}`);
    }
  }
  if (args.json) writeFileSync(args.json, `${JSON.stringify({ network: session.config.devnetName, measured }, null, 2)}\n`);
  return 0;
}

/**
 * One cut: register its throwaway copy (or reuse `cut.reuse`), measure every write RUNS
 * times, print the table beside the estimator's, and answer `{ file, contractId, table }`.
 */
async function measureCut(cut, { P, likers }) {
  const source = measureContractSource(cut.file);
  let contractId = cut.reuse;
  if (contractId) {
    const stored = await withReconnect(() => sdk.contracts.fetch(contractId));
    const post = stored?.toJSON?.(PlatformVersion.latest())?.documentSchemas?.post;
    if (!post) throw new Error(`--reuse ${contractId}: no contract with a post type`);
    if (post.actionFees || post.tokenCost) throw new Error(`--reuse ${contractId} carries action fees or token costs: name a measurement contract this script registered, not a published social contract`);
    if (source.documentSchemas.report && !stored.toJSON(PlatformVersion.latest()).documentSchemas.report) throw new Error(`--reuse ${contractId} has no report type: it predates the v13 report rows, so register a fresh copy`);
    console.log(`\nmeasurement contract ${contractId} (${fileName(cut.file)}), reused`);
  } else {
    const nonce = ((await sdk.identities.nonce(P.ownerId)) ?? 0n) + 1n;
    const draft = DataContract.fromJSON({ ...source, id: DataContract.generateId(P.ownerId, nonce).toBase58(), ownerId: P.ownerId }, true, PlatformVersion.latest());
    contractId = (await sdk.contracts.publish({ dataContract: draft, identityKey: P.identityKey, signer: P.signer })).id.toBase58();
    console.log(`\nmeasurement contract ${contractId} (${fileName(cut.file)}), registered by P=${P.ownerId}`);
    await sleep(3000);
  }
  session.contracts.push(contractId);
  const contract = await withReconnect(() => sdk.contracts.fetch(contractId));
  const id = (value) => bs58.decode(value);
  const tombstones = source.documentSchemas.post.properties.deleted !== undefined;
  /** The writes below are v12-shaped; `fit` adapts them to the cut (v13: live, rootOwnerId, `{ replyId }` likes). */
  const shapes = socialShapes(source);
  const stripped = strippedActionFees(cut.file);

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
  async function create(who, docType, written) {
    const data = shapes.fit(docType, written);
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
    const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data: shapes.fit(docType, data), entropy: randomIdBytes() });
    return sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer });
  }, true);
  const unlike = (who, docType, data) => indexOnlyWrite(who, docType, data, () => {
    const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data: shapes.fit(docType, data) });
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
    record('unlike-tagged', await costOf(likers[2], () => unlike(likers[2], 'like', taggedLike)));
    record('reply-unlike', await costOf(likers[2], () => unlike(likers[2], 'likeReply', replyLike)));
    if (tombstones) record('tombstone', await costOf(P, () => tombstone(P, quoteTarget.id, { deleted: true })));
    if (shapes.cut.mediaArrays) {
      for (const n of [1, 4]) record(`post-media-${n}`, await costOf(P, () => create(P, 'post', { content: text(run), ...shapes.media(mediaItems(n)) })));
    }
    if (shapes.cut.profileReports) {
      // One report per reporter and target: a liker reports this run's post, and a fresh identity's profile.
      const reporter = likers[run % 3];
      record('report-post', await costOf(reporter, () => create(reporter, 'report', shapes.report({ postId: id(post.id), targetOwnerId: id(P.ownerId), reason: 1 }))));
      record('report-profile', await costOf(reporter, () => create(reporter, 'report', shapes.report({ about: 1, targetOwnerId: randomIdBytes(), reason: 1 }))));
    }
    // A deliberate pause keeps a run's writes clear of the next run's quorum checks.
    await sleep(2000);
  }

  // ---- the estimator, on the same contract ----
  const estimates = estimatesFor(contract, source);
  console.log(`\n${fileName(cut.file)} on ${contractId}: live credits (mean of ${RUNS}+, min–max) vs documentCreateCost (new / known values), ¢ at $60/DASH`);
  const table = {};
  for (const [key, values] of Object.entries(results)) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const est = estimates[key];
    // A report's moderators action fee is stripped from the measurement copy (it is a contract charge, not a fee): add it back for the total.
    const actionFee = stripped[key] ?? 0;
    table[key] = { mean, min: Math.min(...values), max: Math.max(...values), n: values.length, estimateNew: est ? Number(est.newValues) : null, estimateKnown: est ? Number(est.knownValues) : null, ...(actionFee ? { actionFee } : {}) };
    console.log(`  ${key.padEnd(18)} live ${M(mean).padStart(8)} (${(mean * CENTS_PER_CREDIT).toFixed(2)}¢; ${M(Math.min(...values))}–${M(Math.max(...values))}, n=${values.length})${est ? `   estimate ${M(Number(est.newValues))} / ${M(Number(est.knownValues))}` : ''}${actionFee ? `   + ${M(actionFee)} action fee = ${M(mean + actionFee)} (${((mean + actionFee) * CENTS_PER_CREDIT).toFixed(2)}¢)` : ''}`);
  }
  return { file: cut.file, contractId, table };
}

main().then((code) => process.exit(code), (e) => { console.error('ERROR:', describeErr(e)); process.exit(1); });
