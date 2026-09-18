/**
 * Registration-day battery for the **DM contract**
 * (`contracts/yappr-dm-contract.json`, docs/NON_SOCIAL_CONTRACTS.md), run live on a
 * beta.1+ devnet. Actors are seed-ledger personas: a SENDER, a RECIPIENT and a
 * STRANGER. DMs carry no token cost, so nothing here buys YAPP.
 *
 * `encryptedContent` is random bytes: this proves the CONTRACT (index flags,
 * refersTo, uniqueness, count grammar); real ECDH has its own unit coverage.
 * Re-runnable — conversation ids are salted per run, so the exact-count cases never
 * measure a previous run's messages; the invite cases are idempotent instead.
 *
 *   NETWORK=devnet node scripts/verify-dm.mjs --contract <id> \
 *     [--sender 220] [--recipient 221] [--stranger 222] [--messages 5] \
 *     [--run <tag>] [--only d4,d5]
 *   node scripts/verify-dm.mjs --self-test   # offline: contract declares what the cases assert
 */
import { ContractBounds, IdentityPublicKeyInCreation, IdentitySigner } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import {
  DUPLICATE_UNIQUE, IMMUTABLE_CHANGED, REFERENCE_NOT_FOUND, b64, decodeDriveError, ghostIdentity,
  runBattery, selfTest, settle,
} from './battery-lib.mjs';
import { describeErr, generateKeypairHex, ledgerEntry, loadLedger, wifFromHex } from './seed/seed-lib.mjs';

const MASTER_KEY_ID = 0;
const DEFAULT_MESSAGES = 5;
const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));
const hexOf = (bytes) => Buffer.from(bytes).toString('hex');

/**
 * The client's `generateConversationId`: first 10 bytes of SHA-256 over the sorted
 * pair. `salt` is battery-only — the real derivation is deterministic per pair, so
 * a second run would land in the SAME conversation and d4/d5/d6 would measure the
 * sum of all runs. The byte shape, index and count grammar are unchanged.
 */
async function conversationIdFor(a, b, salt = '') {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([a, b].sort().join(':') + salt));
  return new Uint8Array(hash).slice(0, 10);
}

const CASES = new Map();

CASES.set('d1', async (ctx) => {
  const { battery, sender, recipient, stranger } = ctx;
  const invite = (label, expect, recipientId, conversationId) => battery.probeCreate(label, expect, sender, 'conversationInvite', { recipientId, conversationId });
  const ghost = ghostIdentity();
  await invite('d1a invite naming a ghost identity is rejected', REFERENCE_NOT_FOUND, bs58.decode(ghost), await conversationIdFor(sender.ownerId, ghost));
  // `senderAndRecipient` is unique on [$ownerId, recipientId] with NO conversationId,
  // so a pair gets exactly one invite ever — re-creating it IS the d1c assertion.
  for (const [label, target, conversationId] of [['d1b', recipient, ctx.c1], ['d1d', stranger, ctx.c2]]) {
    const existing = await battery.queryDocs('conversationInvite', { where: [['$ownerId', '==', sender.ownerId], ['recipientId', '==', target.ownerId]], limit: 1 });
    if (existing.length > 0) battery.check(`${label} invite to ${target.label} present`, true, 'already created by an earlier run');
    else await invite(`${label} invite to ${target.label} is accepted`, null, bs58.decode(target.ownerId), conversationId);
  }
  await invite('d1c a second invite for the same pair is rejected (unique senderAndRecipient)', DUPLICATE_UNIQUE, bs58.decode(recipient.ownerId), ctx.c1);
});

CASES.set('d2', async (ctx) => {
  const { battery, sender, recipient } = ctx;
  const message = (label, who, conversationId) => battery.probeCreate(label, null, who, 'directMessage', { conversationId, encryptedContent: randomBytes(64) });
  // Alternate the writer: count trees are per conversation, not per owner.
  for (let i = 0; i < ctx.messageCount; i++) {
    const who = i % 2 === 0 ? sender : recipient;
    await message(`d2a message ${i + 1}/${ctx.messageCount} in C1 from ${who.label}`, who, ctx.c1);
  }
  for (let i = 0; i < 2; i++) await message(`d2b message ${i + 1}/2 in C2`, sender, ctx.c2);
  // Derived from the timestamps consensus actually assigned: messages in one block
  // share a $createdAt, so a device-clock midpoint makes d5 a coin flip.
  ctx.c1Times = (await battery.queryDocs('directMessage', { where: [['conversationId', '==', b64(ctx.c1)]], orderBy: [['$createdAt', 'asc']], limit: 100 })).map((doc) => Number(doc.$createdAt));
  battery.check('d2c C1 messages read back', ctx.c1Times.length === ctx.messageCount, `${ctx.c1Times.length} of ${ctx.messageCount}`);
  // t_mid: inside the run, with a message on either side even if several share a block.
  const distinct = [...new Set(ctx.c1Times)];
  ctx.tMid = distinct.length > 1 ? distinct[Math.floor(distinct.length / 2) - 1] : (ctx.c1Times[0] ?? 0) - 1;
  ctx.afterMid = ctx.c1Times.filter((time) => time > ctx.tMid).length;
  console.log(`     C1 $createdAt: ${ctx.c1Times.join(', ')} | t_mid=${ctx.tMid} | after=${ctx.afterMid}`);
});

CASES.set('d3', async (ctx) => {
  const { battery, recipient } = ctx;
  const created = await battery.probeCreate('d3a read receipt created', null, recipient, 'readReceipt', { conversationId: ctx.c1 });
  if (!created.ok) return;
  const before = await battery.fetchDocument('readReceipt', created.id);
  await battery.probeReplace('d3b read receipt replaced (markAsRead on a later visit)', null, recipient, 'readReceipt', created.id, { conversationId: ctx.c1 }, before?.revision ?? 1n);
  const after = await battery.fetchDocument('readReceipt', created.id);
  battery.check('d3c $updatedAt advanced (this is the "last read" timestamp)', Number(after?.updatedAt ?? 0) > Number(before?.updatedAt ?? 0), `${before?.updatedAt} → ${after?.updatedAt}`);
  await battery.probeCreate('d3d a second receipt for the same (owner, conversation) is rejected', DUPLICATE_UNIQUE, recipient, 'readReceipt', { conversationId: ctx.c1 });
  ctx.receiptId = created.id;
});

CASES.set('d4', async (ctx) => {
  const { battery } = ctx;
  const where = [['conversationId', '==', b64(ctx.c1)]];
  for (const [label, clause, expected] of [
    ['d4a count(conversationId == C1) equals the messages written', where, ctx.messageCount],
    ['d4b count(conversationId == C2) is independent of C1', [['conversationId', '==', b64(ctx.c2)]], 2],
    ['d4c count of a conversation with no messages is 0', [['conversationId', '==', b64(randomBytes(10))]], 0],
  ]) {
    const total = await battery.countBy('directMessage', clause);
    battery.check(label, total === expected, `${total} vs ${expected}`);
  }
  battery.workingShapes.push({ label: 'per-conversation message count', shape: { documentTypeName: 'directMessage', where } });
});

// The unread badge: one range count, which needs `rangeCountable`.
CASES.set('d5', async (ctx) => {
  const { battery } = ctx;
  if (ctx.tMid === undefined) { battery.check('d5 has d2 timestamps', false, 'run d2 first'); return; }
  // Guard against a vacuous d5a: if every message landed in one block t_mid excludes
  // nothing, d5a merely restates d5b, and an ignored range clause goes unseen.
  battery.check('d5 t_mid actually splits the conversation (otherwise d5a proves nothing)', ctx.afterMid > 0 && ctx.afterMid < ctx.messageCount, `${ctx.afterMid} of ${ctx.messageCount} after t_mid`);
  const since = (time) => [['conversationId', '==', b64(ctx.c1)], ['$createdAt', '>', time]];
  for (const [label, clause, expected] of [
    ['d5a count(C1, $createdAt > t_mid) is exact (rangeCountable)', since(ctx.tMid), ctx.afterMid],
    ['d5b $createdAt > 0 counts the whole conversation', since(0), ctx.messageCount],
    ['d5c a receipt at the newest message leaves 0 unread', since(Math.max(...ctx.c1Times)), 0],
  ]) {
    const total = await battery.countBy('directMessage', clause);
    battery.check(label, total === expected, `${total} vs ${expected}`);
  }
  battery.workingShapes.push({ label: 'unread since lastReadAt', shape: { documentTypeName: 'directMessage', where: since('<lastReadAt>') } });
});

CASES.set('d6', async (ctx) => {
  const { battery } = ctx;
  const ids = [ctx.c1, ctx.c2].map(b64);
  // IN-only: no range clause, so this one is served on the PROVED path.
  try {
    const grouped = await battery.groupedCount('directMessage', [['conversationId', 'in', ids]], ['conversationId']);
    const expected = new Map([[hexOf(ctx.c1), ctx.messageCount], [hexOf(ctx.c2), 2]]);
    battery.check('d6a grouped count over conversationId in [C1, C2] (proved)', [...expected].every(([key, count]) => grouped.get(key) === count), `got ${JSON.stringify([...grouped])}, expected ${JSON.stringify([...expected])}`);
    battery.workingShapes.push({ label: 'total messages per conversation, one call', shape: { documentTypeName: 'directMessage', where: [['conversationId', 'in', ids]], groupBy: ['conversationId'] } });
  } catch (e) {
    battery.check('d6a grouped count over conversationId in [C1, C2] (proved)', false, describeErr(e).slice(0, 200));
  }
  // IN + range in ONE grouped count. Never fatal: the failure mode here is SILENT, so
  // the client must not depend on it either way.
  const wanted = new Map([[hexOf(ctx.c1), ctx.afterMid ?? 0], [hexOf(ctx.c2), 0]]);
  try {
    const grouped = await battery.groupedCount('directMessage', [['conversationId', 'in', ids], ['$createdAt', '>', ctx.tMid ?? 0]], ['conversationId']);
    ctx.inRangeNote = grouped.size === 0
      ? 'returns an EMPTY map (no error, no groups) — a SILENTLY WRONG zero. Do not use it.'
      : [...wanted].every(([key, count]) => (grouped.get(key) ?? 0) === count) ? 'answered correctly.'
        : `answered ${JSON.stringify([...grouped])}, expected ${JSON.stringify([...wanted])} — wrong.`;
  } catch (e) {
    ctx.inRangeNote = `refused outright: ${describeErr(e).slice(0, 160)}`;
  }
  console.log(`NOTE  d6b grouped IN + $createdAt range count ${ctx.inRangeNote}`);
  battery.check('d6b grouped IN + range count probed (never fatal; the client uses per-conversation range counts)', true, ctx.inRangeNote);
});

/**
 * Re-tests the "disabled due to SDK/tooling bugs" note in
 * lib/services/identity-update-builder.ts by registering an ENCRYPTION key bound to
 * this contract. Never fatal — the contract leaves requiresIdentity*BoundedKey unset
 * precisely so the app does not depend on it; the outcome is documentation.
 */
CASES.set('d7', async (ctx) => {
  const { battery } = ctx;
  const note = (text) => { console.log(`NOTE  d7 ${text}`); ctx.boundKeyNote = text; battery.check('d7 contract-bound encryption key probe reported', true, text.slice(0, 80)); };
  const entry = ledgerEntry(loadLedger(), ctx.args.stranger);
  const masterKey = entry?.identityKeys.find((key) => key.keyId === MASTER_KEY_ID);
  if (!masterKey) return note('skipped: the stranger persona has no MASTER key in the seed ledger');
  const identity = await battery.readback(() => battery.sdk.identities.fetch(entry.identityId));
  const keyId = identity.publicKeys.reduce((max, key) => Math.max(max, key.keyId), 0) + 1;
  // A fresh secp256k1 key; its private half must be in the signer for the
  // key-ownership proof a full-pubkey addition requires.
  const fresh = generateKeypairHex();
  const signer = new IdentitySigner();
  for (const hex of [masterKey.privateKeyHex, fresh.privateKeyHex]) signer.addKeyFromWif(wifFromHex(hex));
  let reported = null;
  try {
    const boundKey = new IdentityPublicKeyInCreation({ keyId, purpose: 'encryption', securityLevel: 'medium', keyType: 'ecdsa_secp256k1', isReadOnly: false, data: Uint8Array.from(Buffer.from(fresh.publicKeyHex, 'hex')), signature: new Uint8Array(0), contractBounds: ContractBounds.SingleContract(ctx.contractId) });
    await battery.sdk.identities.update({ identity, signer, addPublicKeys: [boundKey] });
  } catch (e) {
    reported = decodeDriveError(describeErr(e));
  }
  await settle();
  const refreshed = await battery.readback(() => battery.sdk.identities.fetch(entry.identityId));
  if (refreshed.publicKeys.some((key) => key.keyId === keyId)) return note(`WORKS on beta.1: contract-bound ENCRYPTION key ${keyId} registered on ${entry.handle}; the identity-update-builder.ts note is STALE.`);
  // Observed on beta.1: Drive refuses a SingleContract-bounded ENCRYPTION key whose
  // target contract does not declare requiresIdentityEncryptionBoundedKey — a
  // CONSENSUS RULE, not the SDK bug the app's note blames, and chicken-and-egg. A
  // re-run rebuilds a byte-identical transition (key id and nonce unchanged) and Core
  // replays its tx cache — an artefact of probing twice, not the platform's answer.
  const why = /already exists|tx already exists in cache/i.test(reported ?? '')
    ? " — INCONCLUSIVE: Core replayed an earlier run's cached transition; re-probe with a persona that has not been probed yet."
    : /key bounds expected but not present|expected encryption key bounds/i.test(reported ?? '')
      ? ' — REASON IS A CONSENSUS RULE, NOT AN SDK BUG: the identity-update-builder.ts note is misattributed.'
      : ' — the identity-update-builder.ts note stands.';
  note(`did NOT land on beta.1: ${reported ?? 'the SDK reported no error'}${why}`);
});

// What makes "a message is never edited" a consensus rule, not a client convention.
CASES.set('d8', async (ctx) => {
  const { battery, sender, recipient } = ctx;
  const frozen = async (label, id, who, docType, data, missing) => {
    if (!id) { battery.check(label, false, missing); return; }
    await battery.probeReplace(label, IMMUTABLE_CHANGED, who, docType, id, data, await battery.revisionOf(docType, id));
  };
  await frozen('d8a a readReceipt replace re-pointing conversationId is rejected (40128) — only $updatedAt may move', ctx.receiptId, recipient, 'readReceipt', { conversationId: ctx.c2 }, 'no receipt fixture (run d3 first)');
  // Its own message, not one of d2's, so the exact-count cases stay independent
  // whatever order cases are selected in. The content is held here rather than
  // re-read: d8d must resend it byte-identically, and a `toObject()` round-trip
  // could hand back a shape the write path rejects for an unrelated reason.
  const content = randomBytes(64);
  const message = await battery.probeCreate('d8b a message to edit is created in C2', null, sender, 'directMessage', { conversationId: ctx.c2, encryptedContent: content });
  const messageId = message.ok ? message.id : null;
  const [invite] = await battery.queryDocs('conversationInvite', { where: [['$ownerId', '==', sender.ownerId], ['recipientId', '==', recipient.ownerId]], limit: 1 });
  for (const [label, id, who, docType, data, missing] of [
    ["d8c rewriting a sent message's encryptedContent is rejected (40128)", messageId, sender, 'directMessage', { conversationId: ctx.c2, encryptedContent: randomBytes(64) }, 'no message fixture'],
    // Only conversationId differs, so the rejection can only be about the move.
    ['d8d moving a message into another conversation is rejected (40128) — the count tree cannot be re-keyed', messageId, sender, 'directMessage', { conversationId: ctx.c1, encryptedContent: content }, 'no message fixture'],
    ['d8e re-pointing an invite at another conversation is rejected (40128)', invite ? battery.b58(invite.$id) : null, sender, 'conversationInvite', { recipientId: bs58.decode(recipient.ownerId), conversationId: ctx.c2 }, 'no invite fixture (run d1 first)'],
  ]) await frozen(label, id, who, docType, data, missing);
});

await runBattery({
  label: 'DM',
  contract: { env: 'DM_CONTRACT_ID' },
  cases: CASES,
  actors: { sender: 220, recipient: 221, stranger: 222 },
  flags: {
    messages: DEFAULT_MESSAGES,
    // Freshens the conversation ids; --run <tag> targets a previous run's instead.
    run: { default: `:${Date.now().toString(36)}`, parse: (value) => `:${value}` },
  },
  validate: (args) => { if (!(args.messages >= 2)) throw new Error('--messages must be at least 2'); },
  // d8: everything a DM document says is frozen; only $updatedAt may move.
  selfTest: () => selfTest('yappr-dm-contract.json', {
    conversationInvite: { immutable: ['conversationId', 'recipientId', 'senderPubKey'] },
    directMessage: { immutable: ['conversationId', 'encryptedContent'] },
    readReceipt: { immutable: ['conversationId'] },
  }),
  setup: async ({ args, sender, recipient, stranger }) => {
    const c1 = await conversationIdFor(sender.ownerId, recipient.ownerId, args.run);
    const c2 = await conversationIdFor(sender.ownerId, stranger.ownerId, args.run);
    console.log(`run=${args.run} C1=${bs58.encode(c1)} C2=${bs58.encode(c2)}`);
    return { c1, c2, messageCount: args.messages, receiptId: null };
  },
  summary: (ctx) => `bound-key probe: ${ctx.boundKeyNote ?? 'not run'}`,
});
