/**
 * Devnet proof of the "hide, don't delete" release set (docs/SOCIAL_V18.md):
 * registers throwaway copies of the EXACT committed files (social v18, blog
 * v10, storefront v11, and social v17 as the fee baseline) from devnet
 * identities, then runs the moderation battery against them. Devnet only; it
 * never touches a contract the /devnet build points at, and never a
 * testnet or mainnet key.
 *
 * Each copy is the committed file rendered as `register-app-connect-contracts`
 * renders an elected member, with one difference on the battery copies: the
 * interim names two appointed moderators, so the battery can run at once.
 * The `elected` copy keeps the file's `notYetUsable` interim with 1 h windows
 * and a 1 h election delay, to prove that posting stays closed until a team
 * is seated (scripts/file-release-charters.mjs seats one).
 *
 *   NETWORK=devnet node scripts/prove-v18-moderation.mjs <step> --accounts <module.mjs> --state <file.json>
 *
 * Steps: register | social | blog | storefront | fees | catalogue | elected | report
 *
 * `--accounts` names a module exporting `accountFor(key)` -> `{ identityId,
 * wifs }` for the roles below (devnet keys; nothing here prints one). The state
 * file journals every registration, write, read and proof height, so each step
 * resumes; keep it in a private directory.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import bs58 from 'bs58';
import {
  BatchTransition, BatchedTransition, DataContract, DataContractCreateTransition, DocumentActionFeeAgreement,
  DocumentCreateTransition, Identifier, IdentitySigner, PlatformVersion, PrivateKey,
} from '@dashevo/evo-sdk';
import { contractFilePath } from './app-connect-set.mjs';
import { contractSource, registrationJson } from './register-lib.mjs';
import { describeErr } from './owner-keys.mjs';
import { connectSdk, network } from './sdk-env.mjs';
import { NONCE_SEQUENCE_MASK, actionFeeAgreementOptions, deriveDocumentIdBytes } from './seed/seed-lib.mjs';
import { buildDocument, randomIdBytes } from './verify-lib.mjs';
import { expandQueries } from './hide-moderation-queries.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The throwaway copies: file, registrar and how the interim is rendered. */
const COPIES = {
  social: { file: 'yappr-social-contract-v18.json', registrar: 'maker', interim: 'appointed' },
  social17: { file: 'yappr-social-contract-v17.json', registrar: 'bots:1', interim: 'appointed' },
  blog: { file: 'yappr-blog-contract-v10.json', registrar: 'maker', interim: 'appointed' },
  storefront: { file: 'yappr-storefront-contract-v11.json', registrar: 'bots:2', interim: 'appointed' },
  elected: { file: 'yappr-social-contract-v18.json', registrar: 'maker', interim: 'elected', windows: 3600, delay: 3600 },
};

/** Who plays which role (account keys `--accounts` resolves). */
const ROLES = {
  MOD1: 'corpus:64', MOD2: 'corpus:65',
  AUTHOR: 'corpus:61', RESTRICTED: 'corpus:62', LIKER: 'corpus:63', LIKER2: 'corpus:60',
  FEE17: 'corpus:69', FEE18: 'corpus:71', FEELIKER: 'corpus:85',
  BLOGGER: 'corpus:75', BLOGGER2: 'corpus:76', COMMENTER: 'corpus:17',
  SELLER: 'corpus:79', BUYER: 'corpus:14',
};

const argValue = (flag) => { const i = process.argv.indexOf(flag); return i === -1 ? null : process.argv[i + 1]; };
const args = (() => {
  const argv = process.argv.slice(2);
  const value = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
  return { step: argv[0], accounts: value('--accounts'), state: value('--state') };
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const err = (e) => describeErr(e).slice(0, 900);
const codeOf = (s) => (String(s).match(/\b(4\d{4}|1\d{4})\b/) ?? [])[1] ?? null;
const big = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
const cents = (credits) => `${((Number(credits) / 1e6) * 0.06).toFixed(2)}¢`;
const toB58 = (v) => (v == null ? String(v) : typeof v === 'string' ? v : v.toBase58 ? v.toBase58() : bs58.encode(Uint8Array.from(v)));
const objOf = (d) => (d?.toJSON ? d.toJSON() : d?.toObject ? d.toObject() : d);
const docsOf = (r) => (r instanceof Map ? [...r.values()] : Array.isArray(r) ? r : Object.values(r ?? {})).filter(Boolean);
const eq = (a, b) => JSON.stringify(a, big) === JSON.stringify(b, big);

// ---------------------------------------------------------------------------
// State journal
// ---------------------------------------------------------------------------

let state;
function loadState() {
  state = existsSync(args.state) ? JSON.parse(readFileSync(args.state, 'utf8')) : { reg: {}, docs: {}, results: {}, reads: {}, fees: {} };
}
function save() {
  const tmp = `${args.state}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(state, big, 1)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, args.state);
}

// ---------------------------------------------------------------------------
// SDK and identities
// ---------------------------------------------------------------------------

let sdk;
let accountFor;
async function connect() {
  for (let i = 0; i < 12; i++) {
    try { sdk = await connectSdk({ timeoutMs: 30000 }); await sdk.identities.balance(accountFor(ROLES.MOD1).identityId); return; }
    catch (e) { log(`connect retry ${i}: ${err(e).slice(0, 140)}`); await sleep(8000); }
  }
  throw new Error('no connection to the devnet');
}
const retry = async (fn, n = 5) => {
  let last;
  for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { last = e; await sleep(2500 * (i + 1)); } }
  throw last;
};

const actors = {};
/** An identity with its keys matched against the chain: CRITICAL (1) for moderation and contracts, HIGH (2) or CRITICAL for documents, TRANSFER. */
async function who(key) {
  if (actors[key]) return actors[key];
  const account = accountFor(key);
  const identity = await retry(() => sdk.identities.fetch(account.identityId));
  const byLevel = {};
  for (const k of identity.publicKeys) {
    const j = k.toJSON();
    if (j.disabledAt) continue;
    const data = Buffer.from(j.data, 'base64').toString('hex');
    const wif = account.wifs.find((w) => Buffer.from(PrivateKey.fromWIF(w).getPublicKey().toBytes()).toString('hex') === data);
    if (!wif) continue;
    const slot = j.purpose === 3 ? 'transfer' : j.purpose === 0 ? ({ 0: 'master', 1: 'critical', 2: 'high' })[j.securityLevel] : null;
    if (slot && !byLevel[slot]) byLevel[slot] = { identityKey: k, wif };
  }
  if (!byLevel.critical) throw new Error(`${key}: no CRITICAL authentication key held`);
  const signer = new IdentitySigner();
  for (const w of account.wifs) signer.addKeyFromWif(w);
  actors[key] = { key, ownerId: account.identityId, identity, keys: byLevel, signer, doc: byLevel.high ?? byLevel.critical };
  return actors[key];
}
const balanceOf = async (id) => BigInt((await retry(() => sdk.identities.balance(id))) ?? 0);
/** The balance once it has moved off `before` and held still for one more read. */
async function settled(id, before, tries = 24) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const now = await balanceOf(id).catch(() => null);
    if (now !== null && now !== before && now === last) return now;
    last = now;
    await sleep(1500);
  }
  return last ?? before;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** The committed file as the copy registers it (see COPIES). */
function renderedSource(copy, moderators) {
  const source = contractSource(readFileSync(contractFilePath(copy.file), 'utf8'));
  const elected = source.config.moderation.moderators;
  const interim = copy.interim === 'appointed' ? { $type: 'appointedModerators', identities: moderators } : elected.interim;
  const windows = copy.windows ? { joinWindow: copy.windows, voteWindow: copy.windows } : {};
  const delay = copy.delay ? { electionDelay: copy.delay } : {};
  return { ...source, config: { ...source.config, moderation: { ...source.config.moderation, moderators: { ...elected, ...windows, ...delay, interim } } } };
}

async function register(names) {
  const moderators = [(await who(ROLES.MOD1)).ownerId, (await who(ROLES.MOD2)).ownerId];
  for (const name of names) {
    if (state.reg[name]?.fetched) { log(`${name}: already ${state.reg[name].id}`); continue; }
    const copy = COPIES[name];
    const registrar = await who(copy.registrar);
    const nonce = ((await retry(() => sdk.identities.nonce(registrar.ownerId))) ?? 0n) + 1n;
    const id = DataContract.generateId(registrar.ownerId, nonce).toBase58();
    const draft = DataContract.fromJSON(registrationJson(renderedSource(copy, moderators), { id, ownerId: registrar.ownerId }), true, PlatformVersion.latest());
    const st = new DataContractCreateTransition(draft, nonce, PlatformVersion.latest()).toStateTransition();
    st.sign(PrivateKey.fromWIF(registrar.keys.critical.wif), registrar.keys.critical.identityKey);
    const signedBytes = st.toBytes().length;
    const before = await balanceOf(registrar.ownerId);
    log(`${name}: registering ${copy.file} from ${copy.registrar} at nonce ${nonce} (${signedBytes} B signed, balance ${before})`);
    let error = null;
    try { await sdk.stateTransitions.broadcastAndWait(st); } catch (e) { error = err(e); log(`  broadcast: ${error.slice(0, 300)}`); }
    let fetched = null;
    for (let i = 0; i < 15 && !fetched; i++) { await sleep(4000); fetched = await sdk.contracts.fetch(id).catch(() => null); }
    const after = fetched ? await settled(registrar.ownerId, before) : before;
    state.reg[name] = { id, file: copy.file, registrar: registrar.ownerId, nonce: String(nonce), signedBytes, fetched: Boolean(fetched), fee: String(before - after), error, at: new Date().toISOString() };
    save();
    log(`${fetched ? 'REGISTERED' : 'FAILED'} ${name} ${id}: ${before - after} credits (${cents(before - after)})`);
    if (!fetched) throw new Error(`${name} did not register`);
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

let C = 'social';
const cid = () => state.reg[C].id;
const schemaOf = (docType) => JSON.parse(readFileSync(contractFilePath(COPIES[C].file), 'utf8')).documentSchemas[docType];
let permille = null;
async function agreementFor(docType) {
  const fees = schemaOf(docType).actionFees;
  if (!fees?.create) return null;
  permille ??= BigInt((await retry(() => sdk.epoch.current())).feeMultiplierPermille);
  return new DocumentActionFeeAgreement(actionFeeAgreementOptions({ ...fees.create, pricing: fees.pricing }, permille));
}

function record(label, actor, result) {
  state.results[`${C}/${label}`] = result;
  if (result.id && result.outcome === 'accepted' && result.kind === 'create') state.docs[`${C}/${label}`] = result.id;
  save();
  const verdict = result.pass ? 'PASS' : 'FAIL';
  log(`${verdict} [${C}] ${label} (${actor.key}) ${result.outcome}${result.code ? ` ${result.code}` : ''} fee ${result.fee} (${cents(result.fee ?? 0)})${result.error && !result.pass ? ` :: ${result.error.slice(0, 400)}` : ''}`);
  return result;
}
const done = (label) => state.results[`${C}/${label}`];
const docId = (label) => state.docs[`${C}/${label}`] ?? state.docs[label];

async function fetchDoc(docType, id) {
  return objOf((await retry(() => sdk.documents.get(cid(), docType, id), 3).catch(() => null)) ?? null);
}
/** For an indexOnly type (likes) a create is proved by the count under its target going up. */
async function countOf(docType, where) {
  const r = await retry(() => sdk.documents.count({ dataContractId: cid(), documentTypeName: docType, where }), 3);
  return (r instanceof Map ? [...r.values()] : Object.values(r ?? {})).reduce((s, x) => s + Number(x), 0);
}

async function create(label, role, docType, data, expect = 'ok', { indexOnlyCount } = {}) {
  if (done(label)) return done(label);
  const w = await who(ROLES[role] ?? role);
  const contractId = cid();
  const before = await balanceOf(w.ownerId);
  const countBefore = indexOnlyCount ? await countOf(docType, indexOnlyCount) : null;
  const rawNonce = (await retry(() => sdk.identities.contractNonce(w.ownerId, contractId))) ?? 0n;
  const nonce = (BigInt(rawNonce) & NONCE_SEQUENCE_MASK) + 1n;
  const entropy = randomIdBytes();
  const derived = deriveDocumentIdBytes({ contractId, ownerId: w.ownerId, docType, entropy, nonce });
  const id = bs58.encode(derived);
  let error = null;
  try {
    const { document } = buildDocument({ contractId, docType, ownerId: w.ownerId, data, entropy, id: derived });
    const agreement = await agreementFor(docType);
    const transition = new DocumentCreateTransition({ document, identityContractNonce: nonce, ...(agreement ? { actionFeeAgreement: agreement } : {}) });
    const st = BatchTransition.fromBatchedTransitions([new BatchedTransition(transition.toDocumentTransition())], w.ownerId, 0).toStateTransition();
    st.setIdentityContractNonce(nonce);
    st.sign(PrivateKey.fromWIF(w.doc.wif), w.doc.identityKey);
    await sdk.stateTransitions.broadcastAndWait(st);
  } catch (e) { error = err(e); }
  try { await sdk.wasm.refreshIdentityNonce(new Identifier(w.ownerId)); } catch { /* cache only */ }
  let landed = false;
  for (let i = 0; i < 5 && !landed; i++) {
    await sleep(2500);
    landed = indexOnlyCount ? (await countOf(docType, indexOnlyCount).catch(() => countBefore)) === countBefore + 1 : (await fetchDoc(docType, id)) !== null;
  }
  const after = landed ? await settled(w.ownerId, before) : await (async () => { await sleep(3000); return balanceOf(w.ownerId).catch(() => before); })();
  return record(label, w, { kind: 'create', docType, outcome: landed ? 'accepted' : 'refused', expect, pass: (expect === 'ok') === landed, code: error ? codeOf(error) : null, error, id: landed ? id : null, fee: String(before - after) });
}

async function replace(label, role, docType, target, data, expect = 'ok') {
  if (done(label)) return done(label);
  const w = await who(ROLES[role] ?? role);
  const id = docId(target);
  const stored = await fetchDoc(docType, id);
  const revision = BigInt(stored.$revision ?? 1) + 1n;
  const before = await balanceOf(w.ownerId);
  let error = null;
  try {
    const { document } = buildDocument({ contractId: cid(), docType, ownerId: w.ownerId, data, revision, id: bs58.decode(id) });
    await sdk.documents.replace({ document, identityKey: w.doc.identityKey, signer: w.signer });
  } catch (e) { error = err(e); }
  let landed = false;
  for (let i = 0; i < 5 && !landed; i++) { await sleep(2500); landed = BigInt((await fetchDoc(docType, id))?.$revision ?? 0) >= revision; }
  const after = landed ? await settled(w.ownerId, before) : await balanceOf(w.ownerId).catch(() => before);
  return record(label, w, { kind: 'replace', docType, outcome: landed ? 'accepted' : 'refused', expect, pass: (expect === 'ok') === landed, code: error ? codeOf(error) : null, error, id, fee: String(before - after) });
}

/** A moderator's `ChangeDocumentFields`: hide, unhide, label, or a restriction's lift. */
async function modChange(label, role, docType, target, fields, expect = 'ok', reasonDocumentId) {
  if (done(label)) return done(label);
  const w = await who(ROLES[role] ?? role);
  const id = docId(target);
  const prev = await fetchDoc(docType, id);
  const before = await balanceOf(w.ownerId);
  let error = null;
  try { await sdk.contracts.moderatorChangeDocumentFields({ identity: w.identity, contractId: cid(), documentTypeName: docType, documentId: id, fields, reason: { text: `v18 battery: ${label}`, ...(reasonDocumentId ? { reasonDocumentId } : {}) }, signer: w.signer }); }
  catch (e) { error = err(e); }
  let landed = false;
  let now = null;
  for (let i = 0; i < 5 && !landed; i++) { await sleep(2500); now = await fetchDoc(docType, id); landed = BigInt(now?.$revision ?? 0) > BigInt(prev?.$revision ?? 0); }
  const after = landed ? await settled(w.ownerId, before) : await balanceOf(w.ownerId).catch(() => before);
  return record(label, w, { kind: 'mod', docType, outcome: landed ? 'accepted' : 'refused', expect, pass: (expect === 'ok') === landed, code: error ? codeOf(error) : null, error, id, fee: String(before - after), prev, now });
}

/** A moderator delete: every v18 / blog v10 / storefront v11 type must refuse it. */
async function modDelete(label, role, docType, target) {
  if (done(label)) return done(label);
  const w = await who(ROLES[role] ?? role);
  const id = docId(target);
  let error = null;
  try { await sdk.contracts.moderatorDeleteDocument({ identity: w.identity, contractId: cid(), documentTypeName: docType, documentId: id, reason: { text: 'v18 battery: delete must be refused' }, signer: w.signer }); }
  catch (e) { error = err(e); }
  await sleep(3000);
  const still = (await fetchDoc(docType, id)) !== null;
  return record(label, w, { kind: 'modDelete', docType, outcome: still ? 'refused' : 'accepted', expect: 'refused', pass: still && error !== null, code: error ? codeOf(error) : null, error, id, fee: '0' });
}

/**
 * An unlike as a fresh client sends it, knowing only the like's owner and its post: every value
 * comes from the post document (author, tags, its `live` as `postLive`); no `$createdAt`.
 */
async function unlike(label, role, post, expect = 'ok') {
  if (done(label)) return done(label);
  const w = await who(ROLES[role] ?? role);
  const stored = await fetchDoc('post', docId(post));
  const lane = schemaOf('like').properties.postLive !== undefined;
  const data = { postId: bs58.decode(docId(post)), postAuthor: bs58.decode(stored.$ownerId), ...(stored.tags ? { tags: stored.tags } : {}), ...(lane ? { postLive: stored.live } : {}) };
  const counted = [['postId', '==', docId(post)]];
  const before = await balanceOf(w.ownerId);
  const countBefore = await countOf('like', counted);
  let error = null;
  try {
    const { document } = buildDocument({ contractId: cid(), docType: 'like', ownerId: w.ownerId, data, id: randomIdBytes() });
    await sdk.documents.delete({ document, identityKey: w.doc.identityKey, signer: w.signer });
  } catch (e) { error = err(e); }
  let gone = false;
  for (let i = 0; i < 5 && !gone; i++) { await sleep(2500); gone = (await countOf('like', counted).catch(() => countBefore)) === countBefore - 1; }
  const after = gone ? await settled(w.ownerId, before) : before;
  return record(label, w, { kind: 'unlike', docType: 'like', outcome: gone ? 'accepted' : 'refused', expect, pass: (expect === 'ok') === gone, code: error ? codeOf(error) : null, error, fee: String(before - after) });
}

/** A list action (warn, or a ban/suspend the contract must refuse: it keeps no such list). */
async function listAction(label, role, action, target, expect = 'ok') {
  if (done(label)) return done(label);
  const w = await who(ROLES[role] ?? role);
  const subject = (await who(ROLES[target] ?? target)).ownerId;
  const before = await balanceOf(w.ownerId);
  const base = { identity: w.identity, contractId: cid(), identityId: subject, signer: w.signer, reason: { text: `v18 battery: ${label}` } };
  let error = null;
  try {
    if (action === 'warn') await sdk.contracts.warnUser(base);
    else if (action === 'ban') await sdk.contracts.banUser(base);
    else if (action === 'suspend') await sdk.contracts.suspendUser({ ...base, until: BigInt(Date.now() + 3_600_000) });
  } catch (e) { error = err(e); }
  await sleep(3000);
  const after = await settled(w.ownerId, before, 8);
  return record(label, w, { kind: action, outcome: error ? 'refused' : 'accepted', expect, pass: (expect === 'ok') === !error, code: error ? codeOf(error) : null, error, fee: String(before - after) });
}

// ---------------------------------------------------------------------------
// Proved reads
// ---------------------------------------------------------------------------

const nameOf = (id) => {
  const hit = Object.entries(state.docs).find(([, v]) => v === id)?.[0];
  return hit ? hit.slice(hit.indexOf('/') + 1) : id;
};
const meta = (r) => {
  const m = objOf(r.metadata) ?? {};
  const p = objOf(r.proof) ?? {};
  const bytes = p.grovedbProof ? (typeof p.grovedbProof === 'string' ? Buffer.from(p.grovedbProof, 'base64').length : p.grovedbProof.length) : undefined;
  return { height: m.height, protocolVersion: m.protocolVersion, proofBytes: bytes };
};
const total = (a) => (typeof a === 'number' ? a : Object.values(a ?? {}).reduce((s, x) => s + Number(x), 0));

/** One proved read; `check(answer)` decides the verdict. `kind`: docs | count | ranked | average | get. */
async function read(phase, label, kind, docType, query, check = () => true) {
  const base = { dataContractId: cid(), documentTypeName: docType, ...query };
  let answer = null;
  let proof = null;
  let error = null;
  for (let i = 0; i < 4; i++) {
    try {
      if (kind === 'count') {
        const r = await sdk.documents.countWithProof(base);
        proof = meta(r);
        answer = r.data instanceof Map ? Object.fromEntries([...r.data.entries()].map(([k, v]) => [toB58(k) || 'total', Number(v)])) : Number(r.data);
      } else if (kind === 'ranked') {
        const r = await sdk.documents.rankedWithProof(base);
        proof = meta(r);
        answer = (r.data?.entries ?? []).map((e) => [typeof e.groupValue === 'string' ? nameOf(e.groupValue) : toB58(e.groupValue), Number(e.value)]);
      } else if (kind === 'average') {
        const r = await sdk.documents.averageWithProof(base, query.sumProperty);
        proof = meta(r);
        answer = Object.fromEntries([...(r.data instanceof Map ? r.data.entries() : Object.entries(r.data ?? {}))].map(([k, v]) => [toB58(k) || 'total', JSON.parse(JSON.stringify(v, big))]));
      } else if (kind === 'get') {
        const r = await sdk.documents.getWithProof(cid(), docType, query.id);
        proof = meta(r);
        answer = objOf(r.data);
      } else {
        const r = await sdk.documents.queryWithProof(base);
        proof = meta(r);
        answer = docsOf(r.data).map((d) => nameOf(toB58(objOf(d).$id)));
      }
      error = null;
      break;
    } catch (e) {
      error = err(e);
      if (!/quorum|transport|timeout|unavailable|deadline|connect/i.test(error)) break;
      await sleep(3000);
    }
  }
  let pass = false;
  try { pass = error === null && Boolean(check(answer)); } catch { pass = false; }
  state.reads[`${C}/${phase}/${label}`] = { pass, kind, docType, query: kind === 'get' ? { id: query.id } : query, answer, proof, error };
  save();
  log(`${pass ? 'PASS' : 'FAIL'} [${C}] ${phase} ${label}: ${error ? `refused :: ${error.slice(0, 300)}` : JSON.stringify(answer, big).slice(0, 400)}${proof ? ` (h${proof.height}, ${proof.proofBytes ?? '?'} B)` : ''}`);
  return answer;
}

// ---------------------------------------------------------------------------
// Social v18
// ---------------------------------------------------------------------------

const LANE = (live = 1, mod = null) => [['live', '==', live], ['mod', '==', mod]];
const newest = (where, limit = 20) => ({ where: [...where, ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']], limit });
const TAG = 'vxtag';
const TAG2 = 'vxtwo';
const POST_WINDOW = { field: '$createdAt', selector: 'newest', grid: { range: 259200, step: 86400 } };
const body = (n) => `v18 battery ${n}: the original content must survive every moderator action.`;

/** Every listing, count and rank on its default lane, plus the hidden lane, against the expected sets. */
async function socialLanes(phase, x) {
  const A = (await who(ROLES.AUTHOR)).ownerId;
  const R = (await who(ROLES.RESTRICTED)).ownerId;
  await read(phase, 'timeline (Recent), live 1, mod null', 'docs', 'post', newest(LANE()), (a) => eq(a, x.timeline));
  await read(phase, 'timeline page 2 (startAfter the first)', 'docs', 'post', { ...newest(LANE(), 1), startAfter: docId(x.timeline[0]) }, (a) => eq(a, x.timeline.slice(1, 2)));
  await read(phase, 'timeline count', 'count', 'post', { where: LANE() }, (a) => total(a) === x.timeline.length);
  await read(phase, `tag page #${TAG}`, 'docs', 'post', newest([...LANE(), ['tags', 'contains', TAG]]), (a) => eq(a, x.tagged));
  await read(phase, 'author posts', 'docs', 'post', newest([...LANE(), ['$ownerId', '==', A]]), (a) => eq(a, x.authorPosts));
  await read(phase, 'author post count', 'count', 'post', { where: [...LANE(), ['$ownerId', '==', A]] }, (a) => total(a) === x.authorPosts.length);
  await read(phase, 'top authors by post count (ranked at $ownerId)', 'ranked', 'post', { where: LANE(), groupBy: '$ownerId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 },
    (a) => (a.find(([k]) => k === A)?.[1] ?? 0) === x.authorPosts.length);
  await read(phase, 'mentions of the restricted author', 'docs', 'post', newest([['mentionedUserIds', 'contains', R], ['mod', '==', null]]), (a) => eq(a, x.mentions));
  await read(phase, 'thread page (repliesOf)', 'docs', 'reply', { where: [...LANE(), ['rootPostId', '==', docId('P1')]], orderBy: [['replyToReplyId', 'asc'], ['$createdAt', 'asc']], limit: 50 }, (a) => eq([...a].sort(), [...x.thread].sort()));
  await read(phase, 'direct replies (replyToReplyId == null)', 'docs', 'reply', { where: [...LANE(), ['rootPostId', '==', docId('P1')], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'asc']], limit: 50 }, (a) => eq(a, x.direct));
  await read(phase, 'thread count', 'count', 'reply', { where: [...LANE(), ['rootPostId', '==', docId('P1')]] }, (a) => total(a) === x.thread.length);
  await read(phase, 'direct reply count (two null pins)', 'count', 'reply', { where: [...LANE(), ['rootPostId', '==', docId('P1')], ['replyToReplyId', '==', null]] }, (a) => total(a) === x.direct.length);
  await read(phase, 'grouped thread counts', 'count', 'reply', { where: [...LANE(), ['rootPostId', 'in', [docId('P1'), docId('P2')]]], groupBy: ['rootPostId'] }, (a) => total(a) === x.thread.length);
  await read(phase, 'most replied (ranked at rootPostId)', 'ranked', 'reply', { where: LANE(), groupBy: 'rootPostId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 },
    (a) => (a.find(([k]) => k === 'P1')?.[1] ?? 0) === x.thread.length);
  await read(phase, 'restricted author\'s replies (reply.ownerAndTime)', 'docs', 'reply', newest([...LANE(), ['$ownerId', '==', R]]), (a) => eq(a, x.restrictedReplies));
  await read(phase, 'hidden lane (live 1, mod 1) timeline', 'docs', 'post', newest(LANE(1, 1)), (a) => eq(a, x.hidden));
  await read(phase, 'hidden lane count', 'count', 'post', { where: LANE(1, 1) }, (a) => total(a) === x.hidden.length);
  await read(phase, 'restricted lane (live 2, mod null) timeline', 'docs', 'post', newest(LANE(2)), (a) => eq(a, x.restricted));
  await read(phase, 'moderation log post (mod 1, newest action first)', 'docs', 'post', { where: [['mod', '==', 1], ['$moderatedAt', '>', 0]], orderBy: [['$moderatedAt', 'desc']], limit: 20 }, (a) => eq(a, x.postLog));
  await read(phase, 'moderation log reply (mod 1)', 'docs', 'reply', { where: [['mod', '==', 1], ['$moderatedAt', '>', 0]], orderBy: [['$moderatedAt', 'desc']], limit: 20 }, (a) => eq(a, x.replyLog));
  await read(phase, 'trending posts, postLive 1 (72h window)', 'ranked', 'like', { where: [['postLive', '==', 1]], groupBy: 'postId', aggregate: { type: 'count' }, direction: 'desc', limit: 10, timeRange: [POST_WINDOW] }, (a) => eq(Object.fromEntries([...a].sort()), Object.fromEntries(Object.entries(x.trending1).sort())));
  await read(phase, 'trending posts, postLive 2 (72h window)', 'ranked', 'like', { where: [['postLive', '==', 2]], groupBy: 'postId', aggregate: { type: 'count' }, direction: 'desc', limit: 10, timeRange: [POST_WINDOW] }, (a) => eq(Object.fromEntries([...a].sort()), Object.fromEntries(Object.entries(x.trending2).sort())));
}

async function socialBattery() {
  C = 'social';
  const A = (await who(ROLES.AUTHOR)).ownerId;
  const R = (await who(ROLES.RESTRICTED)).ownerId;
  const like = (post, postLive) => ({ postId: bs58.decode(docId(post)), postAuthor: bs58.decode(A), tags: state.postTags?.[post] ?? [], postLive });
  const likeCount = (post) => ({ indexOnlyCount: [['postId', '==', docId(post)]] });
  state.postTags = { P1: [TAG], P2: [TAG, TAG2], P3: [] };
  save();

  // ---- setup: three posts, a nested thread, likes ----
  await create('P1', 'AUTHOR', 'post', { content: body(1), tags: [TAG], live: 1 });
  await create('P2', 'AUTHOR', 'post', { content: body(2), tags: [TAG, TAG2], live: 1, mentionedUserIds: [bs58.decode(R)] });
  await create('P3', 'AUTHOR', 'post', { content: body(3), live: 1 });
  await create('unrestricted author writes live 2', 'AUTHOR', 'post', { content: body(4), live: 2 }, 'refused');
  await create('author writes mod on create', 'AUTHOR', 'post', { content: body(5), live: 1, mod: 1, modLabel: 1 }, 'refused');
  await create('R1', 'RESTRICTED', 'reply', { content: 'reply 1', rootPostId: bs58.decode(docId('P1')), live: 1 });
  await create('R2', 'RESTRICTED', 'reply', { content: 'reply 2', rootPostId: bs58.decode(docId('P1')), replyToReplyId: bs58.decode(docId('R1')), live: 1 });
  await create('like P1 (postLive 1)', 'LIKER', 'like', like('P1', 1), 'ok', likeCount('P1'));
  await create('like P2 with the wrong lane (postLive 2)', 'LIKER', 'like', like('P2', 2), 'refused', likeCount('P2'));
  const base = {
    timeline: ['P3', 'P2', 'P1'], tagged: ['P2', 'P1'], authorPosts: ['P3', 'P2', 'P1'], mentions: ['P2'],
    thread: ['R1', 'R2'], direct: ['R1'], restrictedReplies: ['R2', 'R1'], hidden: [], restricted: [], postLog: [], replyLog: [],
    trending1: { P1: 1 }, trending2: {},
  };
  await socialLanes('0 before', base);

  // ---- delete is gone; only a moderator writes mod ----
  await modDelete('moderator delete of a post is refused', 'MOD1', 'post', 'P1');
  await modDelete('moderator delete of a reply is refused', 'MOD1', 'reply', 'R1');
  await modChange('the author (not a moderator) changes mod', 'AUTHOR', 'post', 'P1', { mod: 1, modLabel: 1 }, 'refused');
  await replace('author replace setting mod', 'AUTHOR', 'post', 'P1', { content: body(1), tags: [TAG], live: 1, mod: 1, modLabel: 1 }, 'refused');
  await modChange('a hide without a reason (modReason)', 'MOD1', 'post', 'P3', { mod: 1 }, 'refused');

  // ---- hide: the post and a reply leave every default listing, count and rank ----
  await modChange('hide P2 (mod 1, modLabel 2)', 'MOD1', 'post', 'P2', { mod: 1, modLabel: 2 });
  await modChange('hide R1', 'MOD1', 'reply', 'R1', { mod: 1, modLabel: 2 });
  await create('like the hidden P2 (accepted: a like cannot read mod)', 'LIKER2', 'like', like('P2', 1), 'ok', likeCount('P2'));
  const hidden = { ...base, timeline: ['P3', 'P1'], tagged: ['P1'], authorPosts: ['P3', 'P1'], mentions: [], thread: ['R2'], direct: [], restrictedReplies: ['R2'], hidden: ['P2'], postLog: ['P2'], replyLog: ['R1'], trending1: { P1: 1, P2: 1 } };
  await socialLanes('1 hidden', hidden);
  await read('1 hidden', 'P2 by id keeps its content, lane and stamps', 'get', 'post', { id: docId('P2') }, (d) => d && d.content === body(2) && d.mod === 1 && d.modLabel === 2 && d.live === 1 && d.$moderatedBy === state.results['social/hide P2 (mod 1, modLabel 2)']?.now?.$moderatedBy && d.$moderatedAt != null);
  await replace('author replace removing mod (self-unhide)', 'AUTHOR', 'post', 'P2', { content: body(2), tags: [TAG, TAG2], live: 1, mentionedUserIds: [bs58.decode(R)] }, 'refused');

  // ---- unhide by the other moderator ----
  await modChange('unhide P2 (another moderator)', 'MOD2', 'post', 'P2', { mod: null });
  await modChange('unhide R1', 'MOD2', 'reply', 'R1', { mod: null });
  await socialLanes('2 unhidden', { ...base, postLog: [], replyLog: [], trending1: { P1: 1, P2: 1 } });

  // ---- an author tombstone carries mod through ----
  await modChange('re-hide P2', 'MOD1', 'post', 'P2', { mod: 1, modLabel: 2 });
  await replace('tombstone of hidden P2 dropping mod', 'AUTHOR', 'post', 'P2', { deleted: true, tags: [TAG, TAG2] }, 'refused');
  await replace('tombstone of hidden P2 carrying mod', 'AUTHOR', 'post', 'P2', { deleted: true, tags: [TAG, TAG2], mod: 1, modLabel: 2 });
  await read('3 tombstoned', 'P2 tombstone keeps mod', 'get', 'post', { id: docId('P2') }, (d) => d && d.deleted === true && d.content === undefined && d.live === undefined && d.mod === 1);
  await create('like a tombstone (no live to copy)', 'LIKER', 'like', like('P2', 1), 'refused', likeCount('P2'));

  // ---- restriction: moderator-only, forces live 2 on create, judged on create only ----
  const restriction = (target) => ({ target: bs58.decode(target), state: 1, reason: 3 });
  await create('a non-moderator creates a restriction', 'LIKER', 'restriction', restriction(R), 'refused');
  await create('RX', 'MOD1', 'restriction', restriction(R));
  await create('a second restriction of the same author (unique target)', 'MOD2', 'restriction', restriction(R), 'refused');
  await create('restricted author writes live 1', 'RESTRICTED', 'post', { content: body(6), live: 1 }, 'refused');
  await create('P4', 'RESTRICTED', 'post', { content: body(7), tags: [TAG], live: 2 });
  await create('R3', 'RESTRICTED', 'reply', { content: 'reply 3', rootPostId: bs58.decode(docId('P1')), live: 2 });
  await modChange('hide a reply the author wrote before the restriction ($revision guard)', 'MOD1', 'reply', 'R1', { mod: 1, modLabel: 4 });
  await replace('restricted author tombstones a pre-restriction reply ($revision guard)', 'RESTRICTED', 'reply', 'R2', { deleted: true, rootPostId: bs58.decode(docId('P1')), replyToReplyId: bs58.decode(docId('R1')) });
  state.postTags.P4 = [TAG];
  save();
  await create('like P4 (postLive 2)', 'LIKER', 'like', { postId: bs58.decode(docId('P4')), postAuthor: bs58.decode(R), tags: [TAG], postLive: 2 }, 'ok', likeCount('P4'));
  await create('like P4 claiming lane 1', 'LIKER2', 'like', { postId: bs58.decode(docId('P4')), postAuthor: bs58.decode(R), tags: [TAG], postLive: 1 }, 'refused', likeCount('P4'));
  const restricted = { ...base, timeline: ['P3', 'P1'], tagged: ['P1'], authorPosts: ['P3', 'P1'], mentions: [], thread: [], direct: [], restrictedReplies: [], hidden: [], restricted: ['P4'], postLog: ['P2'], replyLog: ['R1'], trending1: { P1: 1, P2: 1 }, trending2: { P4: 1 } };
  await socialLanes('4 restricted', restricted);
  await read('4 restricted', 'restricted lane thread (live 2)', 'docs', 'reply', { where: [...LANE(2), ['rootPostId', '==', docId('P1')]], orderBy: [['replyToReplyId', 'asc'], ['$createdAt', 'asc']], limit: 50 }, (a) => eq(a, ['R3']));
  await read('4 restricted', 'restriction log (state 1, newest first)', 'docs', 'restriction', { where: [['state', '==', 1], ['$moderatedAt', '>', 0]], orderBy: [['$moderatedAt', 'desc']], limit: 20 }, (a) => eq(a, ['RX']));
  await read('4 restricted', 'my standing (byTarget)', 'docs', 'restriction', { where: [['target', '==', R]], limit: 1 }, (a) => eq(a, ['RX']));

  // ---- lift: a state flip; no re-listing ----
  await modChange('clearing the state is refused (moderatorsOnly)', 'MOD2', 'restriction', 'RX', { state: null }, 'refused');
  await modChange('lift (state 2)', 'MOD2', 'restriction', 'RX', { state: 2 });
  await create('lifted author writes live 2', 'RESTRICTED', 'post', { content: body(8), live: 2 }, 'refused');
  await create('P5', 'RESTRICTED', 'post', { content: body(9), live: 1 });
  await read('5 lifted', 'restriction log (state 2: lifted)', 'docs', 'restriction', { where: [['state', '==', 2], ['$moderatedAt', '>', 0]], orderBy: [['$moderatedAt', 'desc']], limit: 20 }, (a) => eq(a, ['RX']));
  await read('5 lifted', 'P4 stays in the restricted lane', 'docs', 'post', newest(LANE(2)), (a) => eq(a, ['P4']));
  await read('5 lifted', 'P5 is listed', 'docs', 'post', newest(LANE()), (a) => eq(a, ['P5', 'P3', 'P1']));

  // ---- warnings are the only list ----
  await listAction('warn the restricted author', 'MOD1', 'warn', 'RESTRICTED');
  await listAction('ban (no banlist)', 'MOD1', 'ban', 'RESTRICTED', 'refused');
  await listAction('suspend (no suspension list)', 'MOD1', 'suspend', 'RESTRICTED', 'refused');
  const entries = await retry(() => sdk.contracts.moderationEntriesWithProof({ contractId: cid(), list: 'warnings', limit: 100 }));
  const page = objOf(entries.data) ?? entries.data;
  const warned = (page?.entries ?? []).map((e) => objOf(e) ?? e);
  const ok = warned.some((e) => toB58(e.identityId) === R && (e.warnings?.length ?? 0) >= 1);
  state.reads['social/6 warnings/warning list (moderationEntries)'] = { pass: ok, answer: JSON.parse(JSON.stringify(warned, big)), proof: meta(entries) };
  save();
  log(`${ok ? 'PASS' : 'FAIL'} [social] warning list: ${JSON.stringify(warned, big).slice(0, 300)}`);

  // ---- unlike: from the post's values alone, then like again; the trend window keeps the first (outlivesDelete) ----
  const p3 = { postId: bs58.decode(docId('P3')), postAuthor: bs58.decode(A), postLive: 1 };
  await create('like P3', 'LIKER2', 'like', p3, 'ok', likeCount('P3'));
  await read('7 unlike', 'P3 like count before the unlike', 'count', 'like', { where: [['postId', '==', docId('P3')]] }, (a) => total(a) === 1);
  await unlike('unlike P3 (values from the post alone)', 'LIKER2', 'P3');
  await read('7 unlike', 'P3 like count after the unlike', 'count', 'like', { where: [['postId', '==', docId('P3')]] }, (a) => total(a) === 0);
  await create('like P3 again', 'LIKER2', 'like', p3, 'ok', likeCount('P3'));
  await read('7 unlike', 'P3 like count after liking again', 'count', 'like', { where: [['postId', '==', docId('P3')]] }, (a) => total(a) === 1);
  await read('7 unlike', 'is P3 liked by the liker (byPost, the lane pinned)', 'docs', 'like', { where: [['postId', '==', docId('P3')], ['postLive', '==', 1], ['$ownerId', '==', (await who(ROLES.LIKER2)).ownerId]], limit: 1 }, (a) => a.length === 1);
  await read('7 unlike', 'top liked posts (byPost ranked at postId)', 'ranked', 'like', { groupBy: 'postId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 }, (a) => a.some(([k, v]) => k === 'P3' && v === 1));
  await read('7 unlike', 'trending posts keep the unliked entry, and the re-like reuses it (outlivesDelete)', 'ranked', 'like', { where: [['postLive', '==', 1]], groupBy: 'postId', aggregate: { type: 'count' }, direction: 'desc', limit: 10, timeRange: [POST_WINDOW] }, (a) => a.some(([k, v]) => k === 'P3' && v === 1));
}

// ---------------------------------------------------------------------------
// Blog v10
// ---------------------------------------------------------------------------

async function blogBattery() {
  C = 'blog';
  const now = Date.now();
  const post = (blog, title, live) => ({ blogId: bs58.decode(docId(blog)), title, data0: new Uint8Array([1, 2, 3]), commentsEnabled: true, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), publishedAt: now, live });
  await create('BLOG', 'BLOGGER', 'blog', { name: 'v18 battery blog' });
  await create('BLOG2', 'BLOGGER2', 'blog', { name: 'v18 battery blog two' });
  await create('BP1', 'BLOGGER', 'blogPost', post('BLOG', 'first post', 1));
  await create('BP2', 'BLOGGER', 'blogPost', post('BLOG', 'second post', 1));
  await create('BC1', 'COMMENTER', 'blogComment', { blogPostId: bs58.decode(docId('BP1')), content: 'comment one' });
  await create('BC2', 'COMMENTER', 'blogComment', { blogPostId: bs58.decode(docId('BP1')), content: 'comment two' });
  const lanes = async (phase, x) => {
    await read(phase, 'blog.timeline (mod null)', 'docs', 'blog', newest([['mod', '==', null]]), (a) => eq(a, x.blogs));
    await read(phase, 'blogPost.timeline (live 1, mod null)', 'docs', 'blogPost', newest(LANE()), (a) => eq(a, x.posts));
    await read(phase, 'blogPost.blogAndTime', 'docs', 'blogPost', newest([...LANE(), ['blogId', '==', docId('BLOG')]]), (a) => eq(a, x.blogPosts));
    await read(phase, 'blogComment.postAndTime', 'docs', 'blogComment', newest([['blogPostId', '==', docId('BP1')], ['mod', '==', null]]), (a) => eq(a, x.comments));
    await read(phase, 'blogComment count', 'count', 'blogComment', { where: [['blogPostId', '==', docId('BP1')], ['mod', '==', null]] }, (a) => total(a) === x.comments.length);
    await read(phase, 'blogComment grouped count', 'count', 'blogComment', { where: [['blogPostId', 'in', [docId('BP1'), docId('BP2')]], ['mod', '==', null]], groupBy: ['blogPostId'] }, (a) => total(a) === x.comments.length);
    await read(phase, 'blogPost log (mod 1)', 'docs', 'blogPost', { where: [['mod', '==', 1], ['$moderatedAt', '>', 0]], orderBy: [['$moderatedAt', 'desc']], limit: 20 }, (a) => eq(a, x.postLog));
    await read(phase, 'blogComment log (mod 1)', 'docs', 'blogComment', { where: [['mod', '==', 1], ['$moderatedAt', '>', 0]], orderBy: [['$moderatedAt', 'desc']], limit: 20 }, (a) => eq(a, x.commentLog));
    await read(phase, 'blog log (mod 1)', 'docs', 'blog', { where: [['mod', '==', 1], ['$moderatedAt', '>', 0]], orderBy: [['$moderatedAt', 'desc']], limit: 20 }, (a) => eq(a, x.blogLog));
  };
  const base = { blogs: ['BLOG2', 'BLOG'], posts: ['BP2', 'BP1'], blogPosts: ['BP2', 'BP1'], comments: ['BC2', 'BC1'], postLog: [], commentLog: [], blogLog: [] };
  await lanes('0 before', base);
  await modDelete('moderator delete of a blog post is refused', 'MOD1', 'blogPost', 'BP1');
  await modDelete('moderator delete of a comment is refused', 'MOD1', 'blogComment', 'BC1');
  await modChange('hide BP2', 'MOD1', 'blogPost', 'BP2', { mod: 1, modLabel: 2 });
  await modChange('hide BC1', 'MOD1', 'blogComment', 'BC1', { mod: 1, modLabel: 2 });
  await modChange('hide BLOG2', 'MOD1', 'blog', 'BLOG2', { mod: 1, modLabel: 2 });
  await lanes('1 hidden', { blogs: ['BLOG'], posts: ['BP1'], blogPosts: ['BP1'], comments: ['BC2'], postLog: ['BP2'], commentLog: ['BC1'], blogLog: ['BLOG2'] });
  await modChange('unhide BP2', 'MOD2', 'blogPost', 'BP2', { mod: null });
  await modChange('unhide BC1', 'MOD2', 'blogComment', 'BC1', { mod: null });
  await modChange('unhide BLOG2', 'MOD2', 'blog', 'BLOG2', { mod: null });
  await lanes('2 unhidden', base);
  // restriction in the blog contract
  const B2 = (await who(ROLES.BLOGGER2)).ownerId;
  await create('BRX', 'MOD1', 'restriction', { target: bs58.decode(B2), state: 1, reason: 3 });
  await create('restricted blogger posts live 1', 'BLOGGER2', 'blogPost', post('BLOG2', 'restricted one', 1), 'refused');
  await create('BP3', 'BLOGGER2', 'blogPost', post('BLOG2', 'restricted two', 2));
  await read('3 restricted', 'restricted lane (live 2)', 'docs', 'blogPost', newest(LANE(2)), (a) => eq(a, ['BP3']));
  await read('3 restricted', 'default lane excludes it', 'docs', 'blogPost', newest(LANE()), (a) => eq(a, ['BP2', 'BP1']));
}

// ---------------------------------------------------------------------------
// Storefront v11
// ---------------------------------------------------------------------------

async function storefrontBattery() {
  C = 'storefront';
  const S = (await who(ROLES.SELLER)).ownerId;
  const nonce24 = () => crypto.getRandomValues(new Uint8Array(24));
  await create('STORE', 'SELLER', 'store', { name: 'v18 battery store', status: 'active', category: 'other' });
  await create('ITEM1', 'SELLER', 'storeItem', { storeId: bs58.decode(docId('STORE')), title: 'item one', status: 'active' });
  await create('ITEM2', 'SELLER', 'storeItem', { storeId: bs58.decode(docId('STORE')), title: 'item two', status: 'active' });
  await create('ORDER1', 'BUYER', 'storeOrder', { storeId: bs58.decode(docId('STORE')), sellerId: bs58.decode(S), encryptedPayload: new Uint8Array([1, 2, 3, 4]), nonce: nonce24() });
  await create('ORDER2', 'BUYER', 'storeOrder', { storeId: bs58.decode(docId('STORE')), sellerId: bs58.decode(S), encryptedPayload: new Uint8Array([5, 6, 7, 8]), nonce: nonce24() });
  await create('SR1', 'BUYER', 'storeReview', { storeId: bs58.decode(docId('STORE')), orderId: bs58.decode(docId('ORDER1')), sellerId: bs58.decode(S), rating: 5 });
  await create('SR2', 'BUYER', 'storeReview', { storeId: bs58.decode(docId('STORE')), orderId: bs58.decode(docId('ORDER2')), sellerId: bs58.decode(S), rating: 1 });
  await create('IR1', 'BUYER', 'itemReview', { storeId: bs58.decode(docId('STORE')), itemId: bs58.decode(docId('ITEM1')), orderId: bs58.decode(docId('ORDER1')), rating: 4 });
  const lanes = async (phase, x) => {
    await read(phase, 'store.byStatus (active, mod null)', 'docs', 'store', newest([['status', '==', 'active'], ['mod', '==', null]]), (a) => eq(a, x.stores));
    await read(phase, 'store.byCategory', 'docs', 'store', newest([['status', '==', 'active'], ['mod', '==', null], ['category', '==', 'other']]), (a) => eq(a, x.stores));
    await read(phase, 'top categories (ranked at category)', 'ranked', 'store', { where: [['status', '==', 'active'], ['mod', '==', null]], groupBy: 'category', aggregate: { type: 'count' }, direction: 'desc', limit: 10 }, (a) => eq(a, x.stores.length ? [['other', x.stores.length]] : []));
    await read(phase, 'storeItem.storeAndTime', 'docs', 'storeItem', newest([['storeId', '==', docId('STORE')], ['mod', '==', null]]), (a) => eq(a, x.items));
    await read(phase, 'storeItem.storeStatusAndTime', 'docs', 'storeItem', newest([['storeId', '==', docId('STORE')], ['mod', '==', null], ['status', '==', 'active']]), (a) => eq(a, x.items));
    await read(phase, 'storeReview.storeReviews', 'docs', 'storeReview', newest([['storeId', '==', docId('STORE')], ['mod', '==', null]]), (a) => eq(a, x.reviews));
    await read(phase, 'store average rating (storeRating)', 'average', 'storeReview', { where: [['mod', '==', null], ['storeId', '==', docId('STORE')]], sumProperty: 'rating' }, (a) => JSON.stringify(a).includes(x.ratingSum));
    await read(phase, 'stars histogram (storeRatingDistribution)', 'count', 'storeReview', { where: [['storeId', '==', docId('STORE')], ['mod', '==', null], ['rating', 'in', [1, 2, 3, 4, 5]]], groupBy: ['rating'] }, (a) => total(a) === x.reviews.length);
    await read(phase, 'top rated stores (ranked average)', 'ranked', 'storeReview', { where: [['mod', '==', null]], groupBy: 'storeId', aggregate: { type: 'avg', property: 'rating' }, direction: 'desc', limit: 10 }, () => true);
    await read(phase, 'itemReview.itemReviews', 'docs', 'itemReview', newest([['itemId', '==', docId('ITEM1')], ['mod', '==', null]]), (a) => eq(a, x.itemReviews));
    await read(phase, 'item average rating (storeItemRating)', 'average', 'itemReview', { where: [['mod', '==', null], ['storeId', '==', docId('STORE')], ['itemId', '==', docId('ITEM1')]], sumProperty: 'rating' }, () => true);
    for (const docType of ['store', 'storeItem', 'storeReview', 'itemReview']) {
      await read(phase, `${docType} log (mod 1)`, 'docs', docType, { where: [['mod', '==', 1], ['$moderatedAt', '>', 0]], orderBy: [['$moderatedAt', 'desc']], limit: 20 }, (a) => eq(a, x.logs[docType] ?? []));
    }
  };
  await lanes('0 before', { stores: ['STORE'], items: ['ITEM2', 'ITEM1'], reviews: ['SR2', 'SR1'], ratingSum: '"sum":"6"', itemReviews: ['IR1'], logs: {} });
  await modDelete('moderator delete of a store is refused', 'MOD1', 'store', 'STORE');
  await modDelete('moderator delete of a review is refused', 'MOD1', 'storeReview', 'SR2');
  await modChange('hide SR2 (a fake review leaves the average)', 'MOD1', 'storeReview', 'SR2', { mod: 1, modLabel: 2 });
  await modChange('hide ITEM2', 'MOD1', 'storeItem', 'ITEM2', { mod: 1, modLabel: 2 });
  await modChange('hide IR1', 'MOD1', 'itemReview', 'IR1', { mod: 1, modLabel: 2 });
  await modChange('hide STORE', 'MOD1', 'store', 'STORE', { mod: 1, modLabel: 2 });
  await lanes('1 hidden', { stores: [], items: ['ITEM1'], reviews: ['SR1'], ratingSum: '"sum":"5"', itemReviews: [], logs: { store: ['STORE'], storeItem: ['ITEM2'], storeReview: ['SR2'], itemReview: ['IR1'] } });
  await create('an order at a hidden store (accepted: references cannot read mod)', 'BUYER', 'storeOrder', { storeId: bs58.decode(docId('STORE')), sellerId: bs58.decode(S), encryptedPayload: new Uint8Array([9]), nonce: nonce24() });
  for (const [docType, label] of [['store', 'STORE'], ['storeItem', 'ITEM2'], ['storeReview', 'SR2'], ['itemReview', 'IR1']]) {
    await modChange(`unhide ${label}`, 'MOD2', docType, label, { mod: null });
  }
  await lanes('2 unhidden', { stores: ['STORE'], items: ['ITEM2', 'ITEM1'], reviews: ['SR2', 'SR1'], ratingSum: '"sum":"6"', itemReviews: ['IR1'], logs: {} });
}

// ---------------------------------------------------------------------------
// The catalogue: every default, archive and log read, served and proved
// ---------------------------------------------------------------------------

async function catalogue() {
  const values = {
    author: (await who(ROLES.AUTHOR)).ownerId, me: (await who(ROLES.RESTRICTED)).ownerId,
    post: state.docs['social/P1'], reply: state.docs['social/R1'], tag: TAG,
    blog: state.docs['blog/BLOG'], blogPost: state.docs['blog/BP1'], store: state.docs['storefront/STORE'], item: state.docs['storefront/ITEM1'],
    target: (await who(ROLES.RESTRICTED)).ownerId,
  };
  const kinds = { documents: 'docs', count: 'count', ranked: 'ranked', average: 'average' };
  for (const query of expandQueries(values)) {
    C = query.contract;
    if (!state.reg[C]) continue;
    const lane = query.lane ? ` ${JSON.stringify(query.lane)}` : '';
    await read('catalogue', `${query.id}${lane}`, kinds[query.kind], query.docType, query.body, () => true);
  }
}

// ---------------------------------------------------------------------------
// Fees: v18 against v17, same writes, same writer history
// ---------------------------------------------------------------------------

async function fees() {
  const tagsOf = (n) => Array.from({ length: n }, (_, i) => `fee${i}x`);
  for (const [copy, role] of [['social17', 'FEE17'], ['social', 'FEE18']]) {
    C = copy;
    const v18 = copy === 'social';
    const live = v18 ? 1 : true;
    const writer = (await who(ROLES[role])).ownerId;
    for (let i = 1; i <= 3; i++) await create(`warm-up ${i}`, role, 'post', { content: body(`warm ${i}`), live });
    await create('FP0', role, 'post', { content: body('fee 0 tags'), live });
    await create('FP1', role, 'post', { content: body('fee 1 tag'), tags: tagsOf(1), live });
    await create('FP4', role, 'post', { content: body('fee 4 tags'), tags: tagsOf(4), live });
    await create('FP1b', role, 'post', { content: body('fee 1 known tag'), tags: tagsOf(1), live });
    await create('FR1', role, 'reply', { content: 'fee reply first', rootPostId: bs58.decode(docId('FP0')), live });
    await create('FR2', role, 'reply', { content: 'fee reply second', rootPostId: bs58.decode(docId('FP0')), live });
    // An untagged post's like carries no `tags`; the liker's first write on the contract is a warm-up.
    const likeData = (post, tags) => ({ postId: bs58.decode(docId(post)), postAuthor: bs58.decode(writer), ...(tags.length ? { tags } : {}), ...(v18 ? { postLive: 1 } : {}) });
    const counted = (post) => ({ indexOnlyCount: [['postId', '==', docId(post)]] });
    await create('like warm-up', 'FEELIKER', 'like', likeData('warm-up 1', []), 'ok', counted('warm-up 1'));
    await create('FL0', 'FEELIKER', 'like', likeData('FP0', []), 'ok', counted('FP0'));
    await create('FL1', 'FEELIKER', 'like', likeData('FP1', tagsOf(1)), 'ok', counted('FP1'));
    await create('FL4', 'FEELIKER', 'like', likeData('FP4', tagsOf(4)), 'ok', counted('FP4'));
    await unlike('FUL', 'FEELIKER', 'FP1');
    await replace('FT', role, 'post', 'FP1b', { deleted: true, tags: tagsOf(1) });
    await replace('FTR', role, 'reply', 'FR2', { deleted: true, rootPostId: bs58.decode(docId('FP0')) });
    if (v18) {
      await modChange('FH4 hide a 4-tag post', 'MOD1', 'post', 'FP4', { mod: 1, modLabel: 2 });
      await modChange('FU4 unhide it', 'MOD2', 'post', 'FP4', { mod: null });
      await modChange('FH0 hide an untagged post', 'MOD1', 'post', 'FP0', { mod: 1, modLabel: 2 });
      await modChange('FU0 unhide it', 'MOD2', 'post', 'FP0', { mod: null });
      await modChange('FHR hide a reply', 'MOD1', 'reply', 'FR1', { mod: 1, modLabel: 2 });
      await modChange('FUR unhide it', 'MOD2', 'reply', 'FR1', { mod: null });
      await create('FRX restrict', 'MOD1', 'restriction', { target: bs58.decode((await who(ROLES.LIKER2)).ownerId), state: 1, reason: 1 });
      await modChange('FLX lift', 'MOD2', 'restriction', 'FRX restrict', { state: 2 });
      await modChange('FRX2 re-restrict', 'MOD1', 'restriction', 'FRX restrict', { state: 1, reason: 2 });
    }
  }
  const pick = (copy, label) => Number(state.results[`${copy}/${label}`]?.fee ?? NaN);
  const rows = [['post, 0 tags', 'FP0'], ['post, 1 new tag', 'FP1'], ['post, 4 new tags', 'FP4'], ['post, 1 known tag', 'FP1b'], ['reply, first on a post', 'FR1'], ['reply, second', 'FR2'],
    ['like, untagged', 'FL0'], ['like, 1 tag', 'FL1'], ['like, 4 tags', 'FL4'], ['unlike, 1 tag (refund)', 'FUL'], ['post tombstone (refund)', 'FT'], ['reply tombstone (refund)', 'FTR']];
  state.fees.table = rows.map(([what, label]) => ({ what, v17: pick('social17', label), v18: pick('social', label) }));
  state.fees.moderator = ['FH4 hide a 4-tag post', 'FU4 unhide it', 'FH0 hide an untagged post', 'FU0 unhide it', 'FHR hide a reply', 'FUR unhide it', 'FRX restrict', 'FLX lift', 'FRX2 re-restrict']
    .map((label) => ({ what: label, v18: pick('social', label) }));
  save();
  for (const r of state.fees.table) log(`fee ${r.what}: v17 ${r.v17} (${cents(r.v17)}), v18 ${r.v18} (${cents(r.v18)}), delta ${r.v18 - r.v17}`);
  for (const r of state.fees.moderator) log(`fee ${r.what}: ${r.v18} (${cents(r.v18)})`);
}

// ---------------------------------------------------------------------------
// notYetUsable: closed until a team is seated
// ---------------------------------------------------------------------------

/**
 * Before seating: a post is refused (41200). After it (`--seated-member <account>` naming one
 * elected member, `--reason <reason document id>` one its charter lists): a post is accepted and
 * that member hides it.
 */
async function elected() {
  C = 'elected';
  const member = argValue('--seated-member');
  const at = new Date().toISOString().slice(0, 16);
  const label = member ? `post once the team is seated (${at})` : `post while no team is seated (${at})`;
  await create(label, 'AUTHOR', 'post', { content: body('elected'), live: 1 }, member ? 'ok' : 'refused');
  if (member) await modChange(`a seated member hides it (${at})`, member, 'post', label, { mod: 1, modLabel: 1 }, 'ok', argValue('--reason'));
  const contract = await retry(() => sdk.contracts.fetch(cid()));
  const declared = contract.toJSON(PlatformVersion.latest()).config.moderation.moderators;
  state.electedDeclaration = { interim: declared.interim, joinWindow: declared.joinWindow, voteWindow: declared.voteWindow, electionDelay: declared.electionDelay, challengeCoolDown: declared.challengeCoolDown };
  save();
  log(`elected copy declares ${JSON.stringify(state.electedDeclaration)}`);
}

function report() {
  const results = Object.entries(state.results);
  const reads = Object.entries(state.reads);
  const failed = [...results, ...reads].filter(([, r]) => !r.pass).map(([k, r]) => `${k}: ${r.error ?? JSON.stringify(r.answer, big)?.slice(0, 200)}`);
  log(`${results.length} writes, ${reads.length} proved reads; ${failed.length} failed`);
  for (const line of failed) log(`  FAIL ${line}`);
  for (const [name, reg] of Object.entries(state.reg)) log(`registered ${name} ${reg.id} ${reg.signedBytes} B ${reg.fee} credits (${cents(reg.fee)})`);
}

async function main() {
  if (network() !== 'devnet') throw new Error('prove-v18-moderation runs on a devnet only (NETWORK=devnet)');
  if (!args.accounts || !args.state) throw new Error('pass --accounts <module.mjs> --state <file.json>');
  ({ accountFor } = await import(pathToFileURL(resolve(args.accounts)).href));
  loadState();
  if (!existsSync(dirname(resolve(args.state)))) throw new Error(`no directory for ${args.state}`);
  if (args.step === 'report') return report();
  await connect();
  switch (args.step) {
    case 'register': return register(process.argv.slice(3).filter((a) => COPIES[a]).length ? process.argv.slice(3).filter((a) => COPIES[a]) : Object.keys(COPIES));
    case 'social': return socialBattery();
    case 'blog': return blogBattery();
    case 'storefront': return storefrontBattery();
    case 'catalogue': return catalogue();
    case 'fees': return fees();
    case 'elected': return elected();
    default: throw new Error(`unknown step ${args.step}`);
  }
}

try {
  await main();
  process.exit(0);
} catch (e) {
  console.error(`ERROR: ${err(e)}`);
  process.exit(1);
}
