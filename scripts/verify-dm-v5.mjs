/**
 * Registration-day battery for the **DM v5 contract**
 * (`contracts/yappr-dm-contract-v5.json`, docs/DM_V5.md §5, §13 item 3), run
 * live on the moutai devnet (4.2.0-beta.3 / protocol 14).
 *
 * Every payload is random bytes of the exact sizes the client writes: this
 * proves the CONTRACT (sizes, uniqueness, mutability, deletability, query
 * shapes) and measures what each write costs. The crypto has its own Vitest
 * coverage in lib/dm/.
 *
 * Actors, all signing with their CRITICAL auth key derived from
 * `E2E_SEED_PHRASE` (the private deployment seed, NOT the CI seed):
 *   maker   seed index 9 — the contract owner; sends messages, owns groups
 *   botA    seed index 0 — second participant; owns the self-state
 *   botB    seed index 1 — the stranger: squats tags, forges group documents
 *   botV    seed index 2 — registers the throwaway index-layout variants, so
 *           the maker's identity nonces are not spent on scratch contracts
 *
 * Re-runnable: tags, handles, invite keys and blobs are fresh per run, and a
 * self-state left by an earlier run is deleted first. Pass `--variants` to
 * reuse layout variants instead of registering new ones (a layout not named
 * is registered).
 *
 *   set -a; . <private ops dir>/credentials.env; set +a
 *   NETWORK=devnet node scripts/verify-dm-v5.mjs [--contract <id>] [--variants uniqueTag=<id>,nonUniqueTag=<id>,uniqueTagOwner=<id>] \
 *     [--only invites,messages,...] [--evidence <path>|--no-evidence]
 *   node scripts/verify-dm-v5.mjs --self-test   # offline: the contract declares what the cases assert
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DataContract, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import {
  DELETE_FORBIDDEN, DUPLICATE_UNIQUE, b64, createBattery, parseOnly, reportSelfTest, runCases,
} from './battery-lib.mjs';
import { resolveOwner, signerFor } from './owner-keys.mjs';
import {
  REPO_ROOT, buildDocument, createSdkHandle, createdId, describeErr, randomEntropy, readEnvFile,
} from './seed/seed-lib.mjs';

const CONTRACT_FILE = 'yappr-dm-contract-v5.json';
const CONTRACT_ENV = 'NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID';
const DEFAULT_EVIDENCE = join(REPO_ROOT, 'docs', 'evidence', 'dm-v5-battery.json');
const FIELD_MAX = 5120;
const AES_GCM_OVERHEAD = 28;
/** Phase-1 message classes (lib/dm/padding.ts MESSAGE_CLASSES), sealed: class + 28. */
const MESSAGE_CLASSES = [128, 256, 512, 1024, 2048, 4096];
/** The 8 KiB and 14 KiB classes body2/body3 exist for. */
const WIDE_CLASSES = [8192, 14336];
/** Scan levels of one recipient ([1, 2|p1, 4|p2], §5.1.2) and two buckets that are not theirs. */
const MY_LEVELS = [1, 3, 6];
const DECOY_BUCKETS = [2, 5];

// ---- Rejection shapes (describeErr text; prose first, several codes arrive as -1) ----
const STALE_REVISION = /\b40106\b|has invalid revision/i;
const NOT_MUTABLE = /is not mutable and can not be replaced/i;
const OWNER_MISMATCH = /\b40102\b|mismatch with existing/i;
/**
 * A field outside its min/maxItems. Observed as a JsonSchemaError ("… has less than 33 items, path: /epk")
 * with code -1, raised by the SDK before broadcast; the system field cap (10417) is the other possible shape.
 */
const TOO_LONG = /has more than \d+ items|maxItems|more than system maximum|\b10417\b|too long|larger than/i;
const TOO_SHORT = /has less than \d+ items|minItems|too short/i;

const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));
const sealed = (sizeClass) => sizeClass + AES_GCM_OVERHEAD;
const b58 = (bytes) => bs58.encode(Uint8Array.from(bytes));
const sameBytes = (a, b) => a !== undefined && b !== undefined && a !== null && b !== null
  && Buffer.from(Uint8Array.from(a)).equals(Buffer.from(Uint8Array.from(b)));
/** Splits a sealed blob over up to three 5120-byte fields (lib/dm/padding.ts splitFields). */
function splitFields(total, names) {
  const fields = {};
  for (let i = 0, offset = 0; offset < total; i++, offset += FIELD_MAX) {
    fields[names[i]] = randomBytes(Math.min(FIELD_MAX, total - offset));
  }
  return fields;
}
const messageFields = (total) => splitFields(total, ['body', 'body2', 'body3']);
const stateFields = (total) => splitFields(total, ['blob', 'blob2', 'blob3']);
const shuffle = (values) => {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

function loadContractJson() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', CONTRACT_FILE), 'utf8'));
}

// ---- Offline pre-flight --------------------------------------------------------

function selfTest() {
  const { documentSchemas: s } = loadContractJson();
  const indexOf = (type) => (s[type]?.indices ?? []).map((index) => ({
    unique: Boolean(index.unique), props: index.properties.map((entry) => Object.keys(entry)[0]).join(','),
  }));
  const bytes = (type, prop) => [s[type]?.properties?.[prop]?.minItems, s[type]?.properties?.[prop]?.maxItems];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return reportSelfTest(`contracts/${CONTRACT_FILE}`, [
    ['exactly four doctypes', same(Object.keys(s).sort(), ['dmGroupDoc', 'dmInvite', 'dmMessage', 'dmSelfState'])],
    ['dmInvite index [bucket, $createdAt], not unique', same(indexOf('dmInvite'), [{ unique: false, props: 'bucket,$createdAt' }])],
    ['dmInvite immutable and not deletable', s.dmInvite.documentsMutable === false && s.dmInvite.canBeDeleted === false],
    ['dmInvite epk 33 / check 16 bytes', same(bytes('dmInvite', 'epk'), [33, 33]) && same(bytes('dmInvite', 'check'), [16, 16])],
    ['dmMessage index unique [tag]', same(indexOf('dmMessage'), [{ unique: true, props: 'tag' }])],
    ['dmMessage immutable and deletable', s.dmMessage.documentsMutable === false && s.dmMessage.canBeDeleted === true],
    ['dmMessage tag 16, body 156..5120', same(bytes('dmMessage', 'tag'), [16, 16]) && same(bytes('dmMessage', 'body'), [156, FIELD_MAX])],
    ['dmMessage body2/body3 ≤ 5120', bytes('dmMessage', 'body2')[1] === FIELD_MAX && bytes('dmMessage', 'body3')[1] === FIELD_MAX],
    ['dmGroupDoc index unique [$ownerId, handle]', same(indexOf('dmGroupDoc'), [{ unique: true, props: '$ownerId,handle' }])],
    ['dmGroupDoc mutable and not deletable', s.dmGroupDoc.documentsMutable === true && s.dmGroupDoc.canBeDeleted === false],
    ['dmGroupDoc handle 10, blob 156..5120', same(bytes('dmGroupDoc', 'handle'), [10, 10]) && same(bytes('dmGroupDoc', 'blob'), [156, FIELD_MAX])],
    ['dmSelfState index unique [$ownerId]', same(indexOf('dmSelfState'), [{ unique: true, props: '$ownerId' }])],
    ['dmSelfState mutable', s.dmSelfState.documentsMutable === true],
    ['dmSelfState blob 156..5120, blob2/blob3 ≤ 5120', same(bytes('dmSelfState', 'blob'), [156, FIELD_MAX]) && bytes('dmSelfState', 'blob2')[1] === FIELD_MAX && bytes('dmSelfState', 'blob3')[1] === FIELD_MAX],
    ['no refersTo, tokenCost or aggregate flags anywhere', !JSON.stringify(s).match(/refersTo|tokenCost|countable|summable|averageable|propertyAgreement/)],
    ['$createdAt required where indexed or read (invite, message, group doc)', ['dmInvite', 'dmMessage', 'dmGroupDoc'].every((t) => s[t].required.includes('$createdAt'))],
  ]);
}

// ---- Arguments -------------------------------------------------------------------

function parseArgs(argv) {
  const env = readEnvFile(join(REPO_ROOT, '.env.devnet'));
  const args = {
    contract: process.env[CONTRACT_ENV] || env[CONTRACT_ENV] || null,
    maker: { index: 9, id: env.DEVNET_MAKER_IDENTITY_ID || '3JKc6iVG74LEMSrAtB4VSHPQW2mtgKAw8s3Ki6tTFcRQ' },
    botA: { index: 0, id: 'EjVyhRotn2vCcoCe2a5KCBLH5NsqQmnrHj3rfwgdtoD7' },
    botB: { index: 1, id: 'H8bQ2PC6suWR32AndM1rqZ7LJM5SHwa3T2Ezf7Z2rA5w' },
    botV: { index: 2, id: '47da17QAtS9mnRSPNP7FMDSJQQWNj9xoixFX13EKQzNa' },
    variants: null,
    only: null,
    evidence: DEFAULT_EVIDENCE,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--maker-id': args.maker.id = argv[++i]; break;
      case '--bot-a-id': args.botA.id = argv[++i]; break;
      case '--bot-b-id': args.botB.id = argv[++i]; break;
      case '--variant-owner-id': args.botV.id = argv[++i]; break;
      case '--variants': args.variants = Object.fromEntries(argv[++i].split(',').map((pair) => pair.split('=').map((part) => part.trim()))); break;
      case '--only': args.only = parseOnly(argv[++i], CASES); break;
      case '--evidence': args.evidence = argv[++i]; break;
      case '--no-evidence': args.evidence = null; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contract) throw new Error(`Pass --contract <id> or set ${CONTRACT_ENV} in .env.devnet`);
  for (const kind of Object.keys(args.variants ?? {})) {
    if (!['uniqueTag', 'nonUniqueTag', 'uniqueTagOwner'].includes(kind)) throw new Error(`--variants: unknown layout ${kind}`);
  }
  return args;
}

// ---- Harness: writes that decide by readback and measure credits ------------------

function createHarness({ battery, handle, contractId }) {
  const { sdk } = battery;
  const results = [];
  const costs = [];
  const readback = (fn) => battery.readback(fn);

  function record(label, ok, detail = '', extra = {}) {
    battery.check(label, ok, detail);
    results.push({ label, pass: Boolean(ok), detail: String(detail).slice(0, 600), ...extra });
  }
  const note = (label, detail) => {
    console.log(`NOTE  ${label} — ${detail}`);
    results.push({ label, pass: true, note: true, detail: String(detail).slice(0, 600) });
  };
  const addCost = (what, who, bytes, cost, extra = {}) => costs.push({ what, actor: who.label, bytes, credits: cost === null ? null : String(cost), ...extra });

  const balance = async (ownerId) => BigInt(await readback(() => sdk.identities.balance(ownerId)));

  async function getDoc(docType, id, contract = contractId) {
    const doc = await readback(() => sdk.documents.get(contract, docType, id));
    return doc ? doc.toObject() : null;
  }

  async function query(docType, shape, contract = contractId) {
    const result = await sdk.documents.query({ dataContractId: contract, documentTypeName: docType, ...shape });
    return [...result.values()].filter(Boolean).map((doc) => doc.toObject());
  }
  const queryRetried = (docType, shape, contract) => readback(() => query(docType, shape, contract));

  /** Runs one write, measuring the signer's credit balance across it. */
  async function measured(who, write) {
    const before = await balance(who.ownerId);
    const outcome = await write();
    const after = await balance(who.ownerId);
    return { ...outcome, cost: before - after };
  }

  /**
   * `accepted(returnedId)` answers truthy when the write landed; a predicate that
   * found the document by value returns its id, which is the only id a create
   * that threw after broadcasting (the DAPI 504 quirk) will ever have.
   */
  function create(who, docType, data, { accepted, contract = contractId } = {}) {
    const { document } = buildDocument({ contractId: contract, docType, ownerId: who.ownerId, data, entropy: randomEntropy() });
    return measured(who, async () => {
      let foundId = null;
      const outcome = await battery.attemptWrite(
        {
          accepted: async (created) => {
            const verdict = await accepted(createdId(created));
            if (typeof verdict === 'string') foundId = verdict;
            return Boolean(verdict);
          },
        },
        () => sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer }),
      );
      return { ...outcome, id: createdId(outcome.result) ?? foundId };
    });
  }

  /**
   * A replace at an explicit revision; accepted = the stored document is at
   * exactly that revision and its user fields are exactly `data` (so an
   * unchanged key such as `tag` or `handle` cannot make a refused replace look
   * accepted, and a continuation field the replace dropped must be gone).
   */
  function replace(who, docType, id, data, revision, contract = contractId) {
    const { document } = buildDocument({ contractId: contract, docType, ownerId: who.ownerId, data, revision, id: bs58.decode(id) });
    // Immutable types store no $revision at all; treat that as revision 1.
    const userFields = (stored) => Object.keys(stored).filter((key) => !key.startsWith('$') && stored[key] !== undefined && stored[key] !== null).sort();
    const carries = (stored) => stored !== null && BigInt(stored.$revision ?? 1) === BigInt(revision)
      && JSON.stringify(userFields(stored)) === JSON.stringify(Object.keys(data).sort())
      && Object.entries(data).every(([field, value]) => sameBytes(stored[field], value));
    return measured(who, () => battery.attemptWrite(
      { accepted: async () => carries(await getDoc(docType, id, contract)) },
      () => sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer }),
    ));
  }

  function remove(who, docType, id, contract = contractId) {
    return measured(who, () => battery.attemptDelete(who, docType, id, contract));
  }

  // ---- Acceptance predicates (every one excludes a document that predates the write) ----

  // Each answers the matching document's id (truthy) or null.
  const idOf = (doc) => (doc ? b58(doc.$id) : null);

  /** The unique [tag] slot holds a document by `who` carrying `body`, other than `excludeId`. */
  const messageAt = (who, tag, body, excludeId = null, contract = contractId) => async () => {
    const docs = await queryRetried('dmMessage', { where: [['tag', '==', b64(tag)]] }, contract);
    return idOf(docs.find((doc) => b58(doc.$id) !== excludeId && b58(doc.$ownerId) === who.ownerId && sameBytes(doc.body, body)));
  };
  const inviteLanded = (who, data, excludeIds = new Set()) => async (id) => {
    if (id && !excludeIds.has(id) && await getDoc('dmInvite', id)) return id;
    const docs = await queryRetried('dmInvite', { where: [['bucket', '==', data.bucket]], orderBy: [['$createdAt', 'desc']], limit: 20 });
    return idOf(docs.find((doc) => !excludeIds.has(b58(doc.$id)) && b58(doc.$ownerId) === who.ownerId && sameBytes(doc.epk, data.epk) && sameBytes(doc.check, data.check)));
  };
  const groupDocAt = (who, handle, blob, excludeId = null) => async () => {
    const docs = await queryRetried('dmGroupDoc', { where: [['$ownerId', '==', who.ownerId], ['handle', '==', b64(handle)]] });
    return idOf(docs.find((doc) => b58(doc.$id) !== excludeId && sameBytes(doc.blob, blob)));
  };
  const selfStateOf = (who, blob, excludeId = null) => async () => {
    const docs = await queryRetried('dmSelfState', { where: [['$ownerId', '==', who.ownerId]] });
    return idOf(docs.find((doc) => b58(doc.$id) !== excludeId && sameBytes(doc.blob, blob)));
  };

  // ---- Verdicts ------------------------------------------------------------------

  const costText = (outcome) => `cost ${outcome.cost.toLocaleString('en-US')} credits`;
  function expectAccepted(label, outcome) {
    record(label, outcome.ok, outcome.ok ? `${outcome.id ? `id=${outcome.id} ` : ''}${costText(outcome)}` : `rejected: ${(outcome.error ?? '').slice(0, 300)}`, { credits: String(outcome.cost) });
    return outcome;
  }
  function expectRejected(label, outcome, pattern) {
    const reason = outcome.error ?? '';
    if (outcome.ok) {
      record(label, false, `ACCEPTED (BAD) ${costText(outcome)}`, { credits: String(outcome.cost) });
      return outcome;
    }
    const matched = pattern.test(reason);
    record(label, matched, matched
      ? `${reason.slice(0, 260)} [${costText(outcome)}]`
      : `rejected, but NOT for the expected reason ${pattern}: ${reason.slice(0, 260)}`, { credits: String(outcome.cost), rejection: reason.slice(0, 1200) });
    return outcome;
  }

  return {
    sdk, handle, battery, results, costs, record, note, addCost, balance, getDoc, query, queryRetried,
    create, replace, remove, messageAt, inviteLanded, groupDocAt, selfStateOf, expectAccepted, expectRejected,
  };
}

// ---- Cases -----------------------------------------------------------------------

const CASES = new Map();

CASES.set('invites', async (ctx) => {
  const { h, maker } = ctx;
  const inviteData = (bucket) => ({ bucket, epk: randomBytes(33), check: randomBytes(16) });
  const first = inviteData(1);
  const a = h.expectAccepted('i1a dmInvite create (bucket 1, epk 33 B, check 16 B)', await h.create(maker, 'dmInvite', first, { accepted: h.inviteLanded(maker, first) }));
  if (a.ok) {
    h.addCost('dmInvite create', maker, 51, a.cost);
    ctx.invites.push({ id: a.id, bucket: 1 });
    const stored = await h.getDoc('dmInvite', a.id);
    h.record('i1b stored invite is fixed-size (epk 33, check 16, bucket read back)', stored?.epk?.length === 33 && stored?.check?.length === 16 && Number(stored?.bucket) === 1, `epk=${stored?.epk?.length} check=${stored?.check?.length} bucket=${stored?.bucket} $createdAt=${stored?.$createdAt}`);
  }
  // No unique index: the same owner may post an identical invite again.
  const dup = h.expectAccepted('i1c a byte-identical second invite by the same owner is accepted (no unique index)', await h.create(maker, 'dmInvite', first, { accepted: h.inviteLanded(maker, first, new Set([a.id])) }));
  if (dup.ok) ctx.invites.push({ id: dup.id, bucket: 1 });
  h.expectRejected('i1d an epk of 32 bytes is rejected (fixed size)', await h.create(maker, 'dmInvite', { ...inviteData(1), epk: randomBytes(32) }, { accepted: async () => false }), TOO_SHORT);
  if (a.ok) h.expectRejected('i1e deleting an invite is rejected (canBeDeleted: false)', await h.remove(maker, 'dmInvite', a.id), DELETE_FORBIDDEN);
  if (a.ok) h.expectRejected('i1f replacing an invite is rejected (immutable)', await h.replace(maker, 'dmInvite', a.id, inviteData(1), 2n), NOT_MUTABLE);
});

CASES.set('messages', async (ctx) => {
  const { h, maker, botA, botB } = ctx;
  const send = async (label, who, total) => {
    const tag = randomBytes(16);
    const data = { tag, ...messageFields(total) };
    const outcome = h.expectAccepted(label, await h.create(who, 'dmMessage', data, { accepted: h.messageAt(who, tag, data.body) }));
    if (outcome.ok) ctx.messages.push({ id: outcome.id, tag, owner: who.ownerId, bytes: total });
    return { ...outcome, tag, data };
  };
  for (const sizeClass of MESSAGE_CLASSES) {
    const m = await send(`m1 dmMessage create, class ${sizeClass} (body ${sealed(sizeClass)} B)`, maker, sealed(sizeClass));
    if (m.ok) h.addCost(`dmMessage create, class ${sizeClass}`, maker, sealed(sizeClass), m.cost);
  }
  for (const sizeClass of WIDE_CLASSES) {
    const total = sealed(sizeClass);
    const fields = Object.keys(messageFields(total)).length;
    const m = await send(`m2 dmMessage create, class ${sizeClass} (${total} B over ${fields} fields)`, maker, total);
    if (m.ok) h.addCost(`dmMessage create, class ${sizeClass} (${fields} fields)`, maker, total, m.cost);
  }
  h.expectRejected('m3 a body of 155 bytes is rejected (minItems 156)', await h.create(maker, 'dmMessage', { tag: randomBytes(16), body: randomBytes(155) }, { accepted: async () => false }), TOO_SHORT);
  const tooLong = await h.create(maker, 'dmMessage', { tag: randomBytes(16), body: randomBytes(FIELD_MAX + 1) }, { accepted: async () => false });
  // Platform's per-field cap (max_field_value_size) is also 5120, and it fires first; the
  // contract's own maxItems is pinned by --self-test.
  h.expectRejected('m4 a body of 5121 bytes is rejected (system field cap 5120 = contract maxItems)', tooLong, TOO_LONG);

  // Unique [tag]: one document per tag, whoever writes it.
  const base = await send('m5 dmMessage at a fresh tag (fixture for the squat probes)', maker, sealed(128));
  if (!base.ok) return;
  const again = { tag: base.tag, body: randomBytes(sealed(128)) };
  h.expectRejected('m5a a second message by the SAME owner at that tag is rejected (unique [tag])',
    await h.create(maker, 'dmMessage', again, { accepted: h.messageAt(maker, base.tag, again.body, base.id) }), DUPLICATE_UNIQUE);
  const squat = { tag: base.tag, body: randomBytes(sealed(128)) };
  h.expectRejected('m5b a message by a DIFFERENT owner at that tag is rejected (a squat blocks the slot)',
    await h.create(botB, 'dmMessage', squat, { accepted: h.messageAt(botB, base.tag, squat.body, base.id) }), DUPLICATE_UNIQUE);
  const stored = await h.getDoc('dmMessage', base.id);
  h.record('m5c the original document still holds the tag', stored !== null && b58(stored.$ownerId) === maker.ownerId && sameBytes(stored.body, base.data.body));
  h.expectRejected('m5d replacing a message is rejected (immutable)', await h.replace(maker, 'dmMessage', base.id, { tag: base.tag, body: randomBytes(sealed(128)) }, 2n), NOT_MUTABLE);
  h.expectRejected('m5e a stranger deleting the message is rejected', await h.remove(botB, 'dmMessage', base.id), OWNER_MISMATCH);

  // Delete refund: the owner deletes two messages; the balance DELTA is the refund net of the delete's own fee.
  // An identity's first write to a contract also stores its identity-contract nonce, which would
  // inflate the create the refund is compared with, so botA writes once unmeasured first.
  await send('m6 botA first write to the contract (not measured)', botA, sealed(128));
  for (const sizeClass of [128, 4096]) {
    const m = await send(`m6 message to sweep, class ${sizeClass}`, botA, sealed(sizeClass));
    if (!m.ok) continue;
    const del = h.expectAccepted(`m6 owner deletes the class ${sizeClass} message (sweep)`, await h.remove(botA, 'dmMessage', m.id));
    if (!del.ok) continue;
    ctx.messages = ctx.messages.filter((msg) => msg.id !== m.id);
    const refund = -del.cost;
    const share = Number(refund * 10000n / m.cost) / 100;
    h.record(`m6 delete of class ${sizeClass} returns credits (net refund > 0)`, refund > 0n, `create ${m.cost.toLocaleString('en-US')} → net refund ${refund.toLocaleString('en-US')} (${share}% of the create)`);
    h.addCost(`dmMessage create, class ${sizeClass} (botA)`, botA, sealed(sizeClass), m.cost);
    h.addCost(`dmMessage delete, class ${sizeClass} (negative = refund)`, botA, sealed(sizeClass), del.cost, { refundShareOfCreate: share });
  }
});

CASES.set('groups', async (ctx) => {
  const { h, maker, botB } = ctx;
  const handle = randomBytes(10);
  ctx.groupHandles.push(handle);
  const roster1 = randomBytes(sealed(128));
  const created = h.expectAccepted('g1 dmGroupDoc (roster) create by the group owner', await h.create(maker, 'dmGroupDoc', { handle, blob: roster1 }, { accepted: h.groupDocAt(maker, handle, roster1) }));
  if (!created.ok) return;
  h.addCost('dmGroupDoc create, class 128 (roster)', maker, sealed(128), created.cost);
  const roster2 = randomBytes(sealed(256));
  const r2 = h.expectAccepted('g2 roster replace at revision 2 is accepted', await h.replace(maker, 'dmGroupDoc', created.id, { handle, blob: roster2 }, 2n));
  if (r2.ok) h.addCost('dmGroupDoc replace, class 128 → 256', maker, sealed(256), r2.cost);
  const stale = await h.replace(maker, 'dmGroupDoc', created.id, { handle, blob: randomBytes(sealed(256)) }, 2n);
  h.expectRejected('g3 a second replace built from revision 1 (stale device) is rejected', stale, STALE_REVISION);
  const dupBlob = randomBytes(sealed(128));
  h.expectRejected('g4 a second dmGroupDoc by the owner at the same handle is rejected (unique [$ownerId, handle])',
    await h.create(maker, 'dmGroupDoc', { handle, blob: dupBlob }, { accepted: h.groupDocAt(maker, handle, dupBlob, created.id) }), DUPLICATE_UNIQUE);
  h.expectRejected('g5 deleting a group document is rejected (canBeDeleted: false)', await h.remove(maker, 'dmGroupDoc', created.id), DELETE_FORBIDDEN);

  // A stranger who learned the handle can write it only under THEIR owner id.
  const forged = randomBytes(sealed(128));
  const spoof = h.expectAccepted("g6 a stranger's dmGroupDoc at the same handle under their own $ownerId is accepted (different slot)",
    await h.create(botB, 'dmGroupDoc', { handle, blob: forged }, { accepted: h.groupDocAt(botB, handle, forged) }));
  const ownerView = await h.queryRetried('dmGroupDoc', { where: [['$ownerId', '==', maker.ownerId], ['handle', '==', b64(handle)]] });
  h.record("g6a the owner's slot ($ownerId == owner, handle) still returns only the owner's document",
    ownerView.length === 1 && b58(ownerView[0].$id) === created.id && sameBytes(ownerView[0].blob, roster2), `${ownerView.length} doc(s)${spoof.ok ? `; forged doc ${spoof.id} lives under ${botB.ownerId}` : ''}`);
  h.expectRejected("g7 a stranger replacing the owner's roster is rejected",
    await h.replace(botB, 'dmGroupDoc', created.id, { handle, blob: randomBytes(sealed(128)) }, 3n), OWNER_MISMATCH);

  // A keyring at the 100-member size (§5.3: ~4.1 KB) — the largest group document.
  const keyringHandle = randomBytes(10);
  ctx.groupHandles.push(keyringHandle);
  const keyring = randomBytes(16 + 8 + 128 * 32);
  const k = h.expectAccepted(`g8 keyring create at the 128-slot size (${keyring.length} B)`, await h.create(maker, 'dmGroupDoc', { handle: keyringHandle, blob: keyring }, { accepted: h.groupDocAt(maker, keyringHandle, keyring) }));
  if (k.ok) h.addCost('dmGroupDoc create, 128-slot keyring', maker, keyring.length, k.cost);
  // The smallest keyring (8 slots, §5.3) is 280 B: above the 156 B floor, so no extra padding is needed.
  const small = randomBytes(16 + 8 + 8 * 32);
  const smallHandle = randomBytes(10);
  ctx.groupHandles.push(smallHandle);
  const k8 = h.expectAccepted(`g9 keyring create at the 8-slot size (${small.length} B)`, await h.create(maker, 'dmGroupDoc', { handle: smallHandle, blob: small }, { accepted: h.groupDocAt(maker, smallHandle, small) }));
  if (k8.ok) h.addCost('dmGroupDoc create, 8-slot keyring', maker, small.length, k8.cost);
  h.expectRejected('g9a a group document blob of 155 B is rejected (minItems 156)',
    await h.create(maker, 'dmGroupDoc', { handle: randomBytes(10), blob: randomBytes(155) }, { accepted: async () => false }), TOO_SHORT);
});

CASES.set('selfstate', async (ctx) => {
  const { h, botA } = ctx;
  // A re-run finds the previous run's self-state; clearing it also proves the type is deletable.
  const leftover = await h.queryRetried('dmSelfState', { where: [['$ownerId', '==', botA.ownerId]] });
  if (leftover.length > 0) {
    const del = h.expectAccepted("s0 an earlier run's self-state is deleted by its owner", await h.remove(botA, 'dmSelfState', b58(leftover[0].$id)));
    if (del.ok) h.addCost('dmSelfState delete (negative = refund)', botA, null, del.cost);
  }
  const first = stateFields(sealed(128));
  const created = h.expectAccepted('s1 dmSelfState create (class 128)', await h.create(botA, 'dmSelfState', first, { accepted: h.selfStateOf(botA, first.blob) }));
  if (!created.ok) return;
  h.addCost('dmSelfState create, class 128', botA, sealed(128), created.cost);
  const second = stateFields(sealed(1024));
  const r2 = h.expectAccepted('s2 self-state replace at revision 2 (class 1024)', await h.replace(botA, 'dmSelfState', created.id, second, 2n));
  if (r2.ok) h.addCost('dmSelfState replace, class 128 → 1024', botA, sealed(1024), r2.cost);
  h.expectRejected('s3 a replace from a device still on revision 1 is rejected (the 40106 merge trigger)',
    await h.replace(botA, 'dmSelfState', created.id, stateFields(sealed(1024)), 2n), STALE_REVISION);
  const other = stateFields(sealed(128));
  h.expectRejected('s4 a second dmSelfState for the same owner is rejected (unique [$ownerId])',
    await h.create(botA, 'dmSelfState', other, { accepted: h.selfStateOf(botA, other.blob, created.id) }), DUPLICATE_UNIQUE);
  const max = stateFields(3 * FIELD_MAX);
  const r3 = h.expectAccepted('s5 replace at the 3-field maximum (3 × 5120 B = 15360 B) is accepted', await h.replace(botA, 'dmSelfState', created.id, max, 3n));
  if (r3.ok) h.addCost('dmSelfState replace, 1024 → 3 × 5120 (max)', botA, 3 * FIELD_MAX, r3.cost);
  h.expectRejected('s6 blob2 of 5121 bytes is rejected (system field cap 5120 = contract maxItems)',
    await h.replace(botA, 'dmSelfState', created.id, { ...stateFields(sealed(128)), blob2: randomBytes(FIELD_MAX + 1) }, 4n), TOO_LONG);
  const back = stateFields(sealed(128));
  const r4 = h.expectAccepted('s7 shrinking back to one field (blob2/blob3 dropped) is accepted', await h.replace(botA, 'dmSelfState', created.id, back, 4n));
  if (r4.ok) h.addCost('dmSelfState replace, max → class 128', botA, sealed(128), r4.cost);
});

/**
 * The recipient's invite scan (§5.1.2, §6.3): `bucket in myLevels` plus a
 * `$createdAt` lower bound, ordered and paged. Probed shape by shape; the
 * fallback — one equality query per level — is always run so the two can be
 * compared.
 */
CASES.set('invitequery', async (ctx) => {
  const { h, maker, botA, botB } = ctx;
  const writers = [maker, botA, botB];
  const planned = [...MY_LEVELS, ...MY_LEVELS, ...DECOY_BUCKETS];
  const mine = new Set();
  let since = null;
  for (const [i, bucket] of planned.entries()) {
    const who = writers[i % writers.length];
    const data = { bucket, epk: randomBytes(33), check: randomBytes(16) };
    const outcome = h.expectAccepted(`q1 invite in bucket ${bucket} by ${who.label}`, await h.create(who, 'dmInvite', data, { accepted: h.inviteLanded(who, data) }));
    if (!outcome.ok) continue;
    const stored = await h.getDoc('dmInvite', outcome.id);
    const createdAt = Number(stored?.$createdAt);
    if (since === null || createdAt < since) since = createdAt;
    ctx.invites.push({ id: outcome.id, bucket, createdAt });
  }
  if (since === null) return;
  // Everything this run wrote in the levels from `since` on (i1's invites may share the block).
  for (const invite of ctx.invites) {
    const createdAt = invite.createdAt ?? Number((await h.getDoc('dmInvite', invite.id))?.$createdAt);
    if (MY_LEVELS.includes(invite.bucket) && createdAt >= since) mine.add(invite.id);
  }
  const decoys = new Set(ctx.invites.filter((invite) => DECOY_BUCKETS.includes(invite.bucket)).map((invite) => invite.id));
  const where = [['bucket', 'in', MY_LEVELS], ['$createdAt', '>=', since]];
  const judge = (docs) => {
    const ids = new Set(docs.map((doc) => b58(doc.$id)));
    const missing = [...mine].filter((id) => !ids.has(id));
    const leaked = [...ids].filter((id) => decoys.has(id));
    return { ok: missing.length === 0 && leaked.length === 0 && ids.size === mine.size, text: `${ids.size} returned, ${mine.size} expected, ${missing.length} missing, ${leaked.length} decoys` };
  };
  const shapes = [
    ['orderBy [bucket asc, $createdAt asc]', { where, orderBy: [['bucket', 'asc'], ['$createdAt', 'asc']] }],
    ['orderBy [$createdAt asc]', { where, orderBy: [['$createdAt', 'asc']] }],
    ['no orderBy', { where }],
  ];
  let working = null;
  for (const [name, shape] of shapes) {
    try {
      const docs = await h.query('dmInvite', { ...shape, limit: 100 });
      const verdict = judge(docs);
      h.record(`q1a bucket IN [1,3,6] + $createdAt >= T, ${name}`, verdict.ok, verdict.text);
      if (verdict.ok && !working) working = { name, shape };
      ctx.queryShapes.push({ label: `invite scan, ${name}`, shape: { documentTypeName: 'dmInvite', ...shape, where: [['bucket', 'in', MY_LEVELS], ['$createdAt', '>=', '<scanCursor>']] }, result: verdict.text });
    } catch (e) {
      h.note(`q1a bucket IN [1,3,6] + $createdAt >= T, ${name}`, `REFUSED: ${describeErr(e).slice(0, 300)}`);
      ctx.queryShapes.push({ label: `invite scan, ${name}`, refused: describeErr(e).slice(0, 400) });
    }
  }
  h.record('q1b at least one single-query IN + range invite scan shape works', working !== null, working?.name ?? 'none — use the per-level fallback');
  if (working) {
    try {
      const pages = [];
      let startAfter;
      for (let page = 0; page < 20; page++) {
        const docs = await h.query('dmInvite', { ...working.shape, limit: 2, ...(startAfter ? { startAfter } : {}) });
        pages.push(docs);
        if (docs.length < 2) break;
        startAfter = b58(docs[docs.length - 1].$id);
      }
      const verdict = judge(pages.flat());
      h.record(`q1c IN + range paged with limit 2 + startAfter (${working.name})`, verdict.ok, `${pages.length} pages; ${verdict.text}`);
    } catch (e) {
      h.record(`q1c IN + range paged with limit 2 + startAfter (${working.name})`, false, `REFUSED: ${describeErr(e).slice(0, 300)}`);
    }
  }
  // Fallback: three equality queries in parallel, each paged.
  try {
    const perLevel = await Promise.all(MY_LEVELS.map(async (bucket) => {
      const docs = [];
      let startAfter;
      for (let page = 0; page < 20; page++) {
        const chunk = await h.queryRetried('dmInvite', { where: [['bucket', '==', bucket], ['$createdAt', '>=', since]], orderBy: [['$createdAt', 'asc']], limit: 2, ...(startAfter ? { startAfter } : {}) });
        docs.push(...chunk);
        if (chunk.length < 2) break;
        startAfter = b58(chunk[chunk.length - 1].$id);
      }
      return docs;
    }));
    const verdict = judge(perLevel.flat());
    h.record('q1d fallback: three parallel bucket == b + $createdAt >= T queries, paged', verdict.ok, verdict.text);
  } catch (e) {
    h.record('q1d fallback: three parallel bucket == b + $createdAt >= T queries, paged', false, describeErr(e).slice(0, 300));
  }
});

/** The stream poll (§6.3): `tag in [...]` with 100 tags, a few of which exist. */
CASES.set('tagquery', async (ctx) => {
  const { h, maker, botA } = ctx;
  // Hits spread over two owners, so the query also proves it is owner-blind.
  for (const [i, who] of [maker, botA, maker, botA].entries()) {
    const tag = randomBytes(16);
    const body = randomBytes(sealed(128));
    const outcome = h.expectAccepted(`t0 hit message ${i + 1}/4 by ${who.label}`, await h.create(who, 'dmMessage', { tag, body }, { accepted: h.messageAt(who, tag, body) }));
    if (outcome.ok) ctx.messages.push({ id: outcome.id, tag, owner: who.ownerId, bytes: body.length });
  }
  const hits = ctx.messages.slice(-12);
  const tags = shuffle([...hits.map((m) => m.tag), ...Array.from({ length: 100 - hits.length }, () => randomBytes(16))]);
  const want = new Set(hits.map((m) => m.id));
  const judge = (docs) => {
    const ids = new Set(docs.map((doc) => b58(doc.$id)));
    const missing = [...want].filter((id) => !ids.has(id));
    return { ok: missing.length === 0 && ids.size === want.size, text: `${ids.size} returned, ${want.size} hits among 100 tags, ${missing.length} missing` };
  };
  const where = [['tag', 'in', tags.map(b64)]];
  let working = null;
  for (const [name, shape] of [
    ['no orderBy, no limit', { where }],
    ['orderBy [tag asc]', { where, orderBy: [['tag', 'asc']] }],
    ['limit 100', { where, limit: 100 }],
  ]) {
    try {
      const verdict = judge(await h.query('dmMessage', shape));
      h.record(`t1 tag IN [100 tags], ${hits.length} hits, ${name}`, verdict.ok, verdict.text);
      if (verdict.ok && !working) working = { name, shape };
      ctx.queryShapes.push({ label: `stream poll, ${name}`, shape: { documentTypeName: 'dmMessage', ...shape, where: [['tag', 'in', '<100 base64 tags>']] }, result: verdict.text });
    } catch (e) {
      h.note(`t1 tag IN [100 tags], ${name}`, `REFUSED: ${describeErr(e).slice(0, 300)}`);
      ctx.queryShapes.push({ label: `stream poll, ${name}`, refused: describeErr(e).slice(0, 400) });
    }
  }
  h.record('t1z at least one 100-tag IN shape answers correctly', working !== null, working?.name ?? 'none');
  if (!working) return;
  try {
    const pages = [];
    let startAfter;
    for (let page = 0; page < 30; page++) {
      const docs = await h.query('dmMessage', { ...working.shape, limit: 3, ...(startAfter ? { startAfter } : {}) });
      pages.push(docs);
      if (docs.length < 3) break;
      startAfter = b58(docs[docs.length - 1].$id);
    }
    const verdict = judge(pages.flat());
    h.record(`t2 the same IN paged with limit 3 + startAfter (junk tags never fill a page)`, verdict.ok, `${pages.length} pages; ${verdict.text}`);
  } catch (e) {
    h.record('t2 the same IN paged with limit 3 + startAfter', false, `REFUSED: ${describeErr(e).slice(0, 300)}`);
  }
});

/** The group fetch (§5.2): `$ownerId == O, handle in [...]`. */
CASES.set('groupquery', async (ctx) => {
  const { h, maker } = ctx;
  if (ctx.groupHandles.length === 0) { h.record('g10 has group documents to query', false, 'run the groups case first'); return; }
  const owned = await Promise.all(ctx.groupHandles.map(async (handle) => (await h.queryRetried('dmGroupDoc', { where: [['$ownerId', '==', maker.ownerId], ['handle', '==', b64(handle)]] }))[0]));
  const want = new Set(owned.filter(Boolean).map((doc) => b58(doc.$id)));
  const handles = shuffle([...ctx.groupHandles, ...Array.from({ length: 100 - ctx.groupHandles.length }, () => randomBytes(10))]);
  const where = [['$ownerId', '==', maker.ownerId], ['handle', 'in', handles.map(b64)]];
  let working = null;
  for (const [name, shape] of [
    ['no orderBy, no limit', { where }],
    ['orderBy [handle asc]', { where, orderBy: [['handle', 'asc']] }],
    ['limit 100', { where, limit: 100 }],
  ]) {
    try {
      const docs = await h.query('dmGroupDoc', shape);
      const ids = new Set(docs.map((doc) => b58(doc.$id)));
      const foreign = docs.filter((doc) => b58(doc.$ownerId) !== maker.ownerId).length;
      const ok = ids.size === want.size && [...want].every((id) => ids.has(id)) && foreign === 0;
      h.record(`g10 $ownerId == owner, handle IN [100 handles], ${name}`, ok, `${ids.size} returned, ${want.size} expected, ${foreign} from other owners (the forged doc must not appear)`);
      if (ok && !working) working = name;
      ctx.queryShapes.push({ label: `group fetch, ${name}`, shape: { documentTypeName: 'dmGroupDoc', ...shape, where: [['$ownerId', '==', '<owner>'], ['handle', 'in', '<base64 handles>']] }, result: `${ids.size}/${want.size}` });
    } catch (e) {
      h.note(`g10 $ownerId == owner, handle IN [100 handles], ${name}`, `REFUSED: ${describeErr(e).slice(0, 300)}`);
      ctx.queryShapes.push({ label: `group fetch, ${name}`, refused: describeErr(e).slice(0, 400) });
    }
  }
  h.record('g10z at least one owner + 100-handle IN shape answers correctly', working !== null, working ?? 'none');
});

/**
 * Index-layout comparison (§5, §12.3). Drive's fee for a write grows with the
 * trees it walks, so the real contract (already holding this run's messages)
 * is not a fair baseline for two freshly registered variants. All three
 * layouts are therefore measured on throwaway contracts registered together
 * by botV — unique [tag] (a clone of the real dmMessage), non-unique [tag],
 * unique [tag, $ownerId] — with the writes interleaved round-robin so drift
 * over time hits every layout alike, and compared by MEDIAN. The real
 * contract is sampled alongside for reference.
 */
const LAYOUTS = [
  ['uniqueTag', 'unique [tag]', [{ name: 'tag', unique: true, properties: [{ tag: 'asc' }] }]],
  ['nonUniqueTag', 'non-unique [tag]', [{ name: 'tag', properties: [{ tag: 'asc' }] }]],
  ['uniqueTagOwner', 'unique [tag, $ownerId]', [{ name: 'tagOwner', unique: true, properties: [{ tag: 'asc' }, { $ownerId: 'asc' }] }]],
];
const LAYOUT_ROUNDS = 7;

async function registerVariant(h, who, kind, indices) {
  const { config, documentSchemas } = loadContractJson();
  const dmMessage = { ...structuredClone(documentSchemas.dmMessage), indices };
  const nonce = ((await h.sdk.identities.nonce(who.ownerId)) ?? 0n) + 1n;
  const id = DataContract.generateId(who.ownerId, nonce).toBase58();
  const dataContract = DataContract.fromJSON({ $formatVersion: '1', id, ownerId: who.ownerId, version: 1, config, documentSchemas: { dmMessage } }, true, PlatformVersion.current());
  const before = await h.balance(who.ownerId);
  const published = await h.sdk.contracts.publish({ dataContract, identityKey: who.identityKey, signer: who.signer });
  const after = await h.balance(who.ownerId);
  const publishedId = published.id.toBase58();
  console.log(`     registered ${kind} variant ${publishedId} at ${who.label} nonce ${nonce} (${(before - after).toLocaleString('en-US')} credits)`);
  return { id: publishedId, nonce: String(nonce), registrationCredits: String(before - after) };
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)];
};

CASES.set('layout', async (ctx) => {
  const { h, botV, args } = ctx;
  const variants = {};
  for (const [kind, , indices] of LAYOUTS) {
    const given = args.variants?.[kind];
    if (given) { variants[kind] = { id: given }; continue; }
    try {
      variants[kind] = await registerVariant(h, botV, kind, indices);
    } catch (e) {
      h.record(`l0 register the ${kind} variant`, false, describeErr(e).slice(0, 300));
      return;
    }
  }
  for (const variant of Object.values(variants)) await h.sdk.contracts.fetch(variant.id);
  ctx.variants = variants;
  const layouts = [
    ...LAYOUTS.map(([kind, name]) => ({ kind, name, contract: variants[kind].id })),
    { kind: 'real', name: 'unique [tag] (the real contract, populated)', contract: ctx.contractId },
  ];
  const write = async (layout, total, label) => {
    const tag = randomBytes(16);
    const body = randomBytes(total);
    const outcome = await h.create(botV, 'dmMessage', { tag, body }, { contract: layout.contract, accepted: h.messageAt(botV, tag, body, null, layout.contract) });
    h.expectAccepted(`l1 ${layout.name}: ${label}`, outcome);
    return outcome.ok ? outcome.cost : null;
  };
  const table = Object.fromEntries(layouts.map((layout) => [layout.kind, { first: null, small: [], large: null }]));
  // Unmeasured warm-up: an identity's FIRST write to a contract also stores its identity-contract nonce.
  for (const layout of layouts) table[layout.kind].first = await write(layout, sealed(128), 'first write (not in the median)');
  for (let round = 0; round < LAYOUT_ROUNDS; round++) {
    for (const layout of layouts) {
      const cost = await write(layout, sealed(128), `body 156 B, round ${round + 1}/${LAYOUT_ROUNDS}`);
      if (cost !== null) table[layout.kind].small.push(cost);
    }
  }
  for (const layout of layouts) table[layout.kind].large = await write(layout, sealed(4096), 'body 4124 B');

  const base = median(table.uniqueTag.small);
  ctx.layout = {};
  for (const layout of layouts) {
    const row = table[layout.kind];
    const mid = median(row.small);
    ctx.layout[layout.name] = {
      contract: layout.contract,
      medianCreditsBody156: mid === null ? null : String(mid),
      deltaVsUniqueTagClone156: mid === null || base === null ? null : String(mid - base),
      creditsBody4124: row.large === null ? null : String(row.large),
      firstWriteCredits: row.first === null ? null : String(row.first),
      samplesBody156: row.small.map(String),
    };
    if (mid !== null) h.addCost(`layout ${layout.name}: body 156, median of ${row.small.length}`, botV, sealed(128), mid);
    if (row.large !== null) h.addCost(`layout ${layout.name}: body 4124`, botV, sealed(4096), row.large);
  }
  const [unique, nonUnique, tagOwner] = ['uniqueTag', 'nonUniqueTag', 'uniqueTagOwner'].map((kind) => median(table[kind].small) ?? -1n);
  const detail = `medians: unique [tag] ${unique.toLocaleString('en-US')} | non-unique [tag] ${nonUnique.toLocaleString('en-US')} | unique [tag,$ownerId] ${tagOwner.toLocaleString('en-US')}`;
  h.record('l2 unique [tag] costs no more than non-unique [tag] (body 156, equal tree population)', unique > 0n && unique <= nonUnique, detail);
  h.record('l3 unique [tag] costs no more than unique [tag, $ownerId] (body 156, equal tree population)', unique > 0n && unique <= tagOwner, detail);
});

// ---- Entrypoint ------------------------------------------------------------------

async function actor(sdk, label, { index, id }) {
  const owner = resolveOwner({ botIndex: index, ownerId: id });
  const { identityKey, signer } = await signerFor(sdk, owner);
  return { ownerId: id, identityKey, signer, label: `${label}(${id.slice(0, 6)}…)` };
}

function printCosts(costs) {
  console.log('\n--- measured credits per write (balance delta; negative = refund) ---');
  for (const row of costs) {
    const credits = row.credits === null ? 'n/a' : BigInt(row.credits).toLocaleString('en-US');
    console.log(`${row.what.padEnd(58)} ${String(row.bytes ?? '').padStart(6)} B  ${credits.padStart(16)}  ${row.actor}`);
  }
}

if (process.argv.includes('--self-test')) process.exit(selfTest());

try {
  const args = parseArgs(process.argv.slice(2));
  await ensureInitialized();
  const handle = createSdkHandle({ contractIds: [args.contract] });
  const { protocolVersion } = await handle.connect();
  const battery = createBattery({ handle, contractId: args.contract, socialId: null });
  const h = createHarness({ battery, handle, contractId: args.contract });
  const contract = await battery.readback(() => h.sdk.contracts.fetch(args.contract));
  console.log(`connected (PV${protocolVersion}); DM v5 ${args.contract} owner ${contract.toJSON().ownerId}`);
  const [maker, botA, botB, botV] = await Promise.all([
    actor(h.sdk, 'maker', args.maker), actor(h.sdk, 'botA', args.botA), actor(h.sdk, 'botB', args.botB), actor(h.sdk, 'botV', args.botV),
  ]);
  for (const who of [maker, botA, botB, botV]) console.log(`     ${who.label} ${who.ownerId}: ${(await h.balance(who.ownerId)).toLocaleString('en-US')} credits`);

  const ctx = {
    h, args, contractId: args.contract, maker, botA, botB, botV,
    invites: [], messages: [], groupHandles: [], queryShapes: [], variants: null, layout: null,
  };
  const startedAt = new Date().toISOString();
  await runCases(battery, CASES, args.only, ctx);
  printCosts(h.costs);
  if (ctx.queryShapes.length > 0) {
    console.log('\n--- query shapes ---');
    for (const entry of ctx.queryShapes) console.log(`${entry.label}: ${entry.refused ? `REFUSED ${entry.refused.slice(0, 160)}` : entry.result}`);
  }
  const failures = battery.report('');
  if (args.evidence) {
    mkdirSync(dirname(args.evidence), { recursive: true });
    const run = {
      network: 'devnet moutai',
      protocolVersion,
      startedAt,
      finishedAt: new Date().toISOString(),
      contract: { file: `contracts/${CONTRACT_FILE}`, id: args.contract },
      actors: Object.fromEntries([maker, botA, botB, botV].map((who) => [who.label.split('(')[0], who.ownerId])),
      only: args.only,
      summary: { checks: h.results.filter((r) => !r.note).length, failed: h.results.filter((r) => !r.pass).length },
      results: h.results,
      costs: h.costs,
      queryShapes: ctx.queryShapes,
      layoutComparison: ctx.layout,
      variants: ctx.variants,
    };
    // Runs APPEND: a later `--only` run must never erase the full run before it.
    const previous = existsSync(args.evidence) ? JSON.parse(readFileSync(args.evidence, 'utf8')) : null;
    const evidence = { battery: 'scripts/verify-dm-v5.mjs', runs: [...(previous?.runs ?? []), run] };
    writeFileSync(args.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`evidence written to ${args.evidence}`);
  }
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
