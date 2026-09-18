/**
 * Registration-day battery for **DM contract v4**
 * (`contracts/yappr-dm-contract-v4.json`, docs/DM_V4.md). Runs live against a
 * freshly registered contract on a beta.1+ devnet; there is no default contract
 * id (`--contract` or `DM_V4_CONTRACT_ID`).
 *
 * Actors are seed-ledger personas (`.seed-identities.local.json`): a SENDER, a
 * RECIPIENT and a STRANGER. DMs carry no token cost, so nothing here buys YAPP.
 *
 * `encryptedContent` is random bytes: this battery proves the CONTRACT (index
 * flags, refersTo, uniqueness, count grammar), and real ECDH would only test
 * lib/message-encryption.ts, which has its own unit coverage.
 *
 * Cases:
 *   d1  invites: an invite naming a GHOST identity is rejected (40120); the
 *       invite to the real recipient is accepted; a second invite for the same
 *       (sender, recipient) pair is rejected (40105, unique senderAndRecipient)
 *   d2  messages: N messages in conversation C1 and a few in C2, all accepted;
 *       their real on-chain $createdAt values are read back (the expectations
 *       in d3/d4 are derived from those, never from the device clock)
 *   d3  read receipts: create, then replace (markAsRead's second call);
 *       $updatedAt advances, which is what "last read" means in v3/v4
 *   d4  counts: count(conversationId == C) equals the messages written — the
 *       flag that removes the per-conversation 100-message download
 *   d5  range counts: count(conversationId == C, $createdAt > t_mid) equals the
 *       messages after t_mid exactly — the unread badge, one call, needs
 *       `rangeCountable`
 *   d6  grouped counts: count(conversationId in [C1, C2]) grouped by
 *       conversationId (proved path), then the same with a $createdAt range
 *       added (served on the no-proof path only; reported, never fatal)
 *   d7  contract-bound ENCRYPTION key probe: registers an ENCRYPTION key with
 *       contractBounds SingleContract(<dm v4>) on the stranger through an
 *       identity update signed with its MASTER key, to re-test the
 *       "disabled due to SDK/tooling bugs" note in
 *       lib/services/identity-update-builder.ts. PASS-with-note either way:
 *       the contract does NOT declare requiresIdentity*BoundedKey, so nothing
 *       in v4 depends on the outcome.
 *   d8  immutability (beta.2 `immutable`): a readReceipt replace may only move
 *       $updatedAt — re-pointing conversationId is rejected (40128); the same
 *       for a directMessage's conversationId/encryptedContent and a
 *       conversationInvite's conversationId. This is what makes "a message is
 *       never edited" a consensus rule instead of a client convention.
 *
 * Run:
 *   NETWORK=devnet node scripts/verify-dm-v4.mjs --contract <id> \
 *     [--sender 220] [--recipient 221] [--stranger 222] [--messages 5] \
 *     [--run <tag>] [--only d4,d5]
 *   node scripts/verify-dm-v4.mjs --self-test   # offline: contract declares what the cases assert
 *
 * Re-runnable: conversation ids are salted per run (see `conversationIdFor`), so
 * the exact-count cases never measure a previous run's messages. The invite
 * cases are idempotent instead — `senderAndRecipient` is unique per pair with no
 * conversationId, so a pair's invite exists at most once, forever.
 */
import { ContractBounds, IdentityPublicKeyInCreation, IdentitySigner, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import {
  DUPLICATE_UNIQUE,
  IMMUTABLE_CHANGED,
  REFERENCE_NOT_FOUND,
  createBattery,
  parseOnly,
  runCases,
  selfTest,
  settle,
} from './battery-lib.mjs';
import {
  createSdkHandle, describeErr, generateKeypairHex, ledgerEntry, loadLedger, socialContractId, wifFromHex,
} from './seed/seed-lib.mjs';

const MASTER_KEY_ID = 0;
const DEFAULT_MESSAGES = 5;

/** Base64 query operand for a plain byte-array property (what the client's `bytesToBase64QueryOperand` emits). */
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/**
 * The client's `generateConversationId` shape: the first 10 bytes of SHA-256
 * over the sorted participant pair.
 *
 * `salt` is a battery-only addition. The real derivation is deterministic per
 * pair, so a second run of this script would write into the SAME conversation
 * and every exact count assertion (d4, d5, d6) would measure the sum of all
 * runs. Salting per run keeps the conversation fresh; the byte shape, the index
 * it exercises and the count grammar are identical.
 */
async function conversationIdFor(a, b, salt = '') {
  const combined = [a, b].sort().join(':') + salt;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combined));
  return new Uint8Array(hash).slice(0, 10);
}

const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

/**
 * Drive's "internal error" payloads arrive base64-encoded CBOR, so the actual
 * consensus reason never reaches the log. Splices the decoded text in.
 */
function decodeDriveError(text) {
  return text.replace(/[A-Za-z0-9+/]{24,}={0,2}/g, (blob) => {
    try {
      const decoded = Buffer.from(blob, 'base64').toString('utf8').replace(/[^\x20-\x7e]+/g, ' ').trim();
      return decoded.length > 12 ? `${blob.slice(0, 12)}… ("${decoded}")` : blob;
    } catch { return blob; }
  });
}
/** A 32-byte identifier that is not an identity on this devnet. */
const ghostIdentity = () => bs58.encode(randomBytes(32));

const CASES = new Map();

// ---- d1 invites --------------------------------------------------------------

/** `senderAndRecipient` is unique on [$ownerId, recipientId] with no conversationId,
 * so a pair gets exactly ONE invite ever — an earlier run's invite is the same
 * document this run would write, and re-creating it is the d1c assertion. */
async function inviteExists(ctx, from, toOwnerId) {
  const found = await ctx.battery.queryDocs('conversationInvite', {
    where: [['$ownerId', '==', from.ownerId], ['recipientId', '==', toOwnerId]], limit: 1,
  });
  return found.length > 0;
}

CASES.set('d1', async (ctx) => {
  const { battery, sender, recipient } = ctx;

  const ghost = ghostIdentity();
  battery.expectRejected(
    'd1a invite naming a ghost identity is rejected',
    await battery.attemptCreate(sender, 'conversationInvite', {
      recipientId: bs58.decode(ghost), conversationId: await conversationIdFor(sender.ownerId, ghost),
    }),
    REFERENCE_NOT_FOUND
  );

  for (const [label, target, conversationId] of [
    ['d1b', recipient, ctx.c1],
    ['d1d', ctx.stranger, ctx.c2],
  ]) {
    if (await inviteExists(ctx, sender, target.ownerId)) {
      battery.check(`${label} invite to ${target.label} present`, true, 'already created by an earlier run');
    } else {
      battery.expectAccepted(
        `${label} invite to ${target.label} is accepted`,
        await battery.attemptCreate(sender, 'conversationInvite', {
          recipientId: bs58.decode(target.ownerId), conversationId,
        })
      );
    }
  }

  battery.expectRejected(
    'd1c a second invite for the same pair is rejected (unique senderAndRecipient)',
    await battery.attemptCreate(sender, 'conversationInvite', {
      recipientId: bs58.decode(recipient.ownerId), conversationId: ctx.c1,
    }),
    DUPLICATE_UNIQUE
  );
});

// ---- d2 messages -------------------------------------------------------------

CASES.set('d2', async (ctx) => {
  const { battery, sender, recipient } = ctx;

  // Alternate the writer so the conversation looks like a real exchange; the
  // count trees are per conversation, not per owner, so both sides land in one.
  for (let i = 0; i < ctx.messageCount; i++) {
    const who = i % 2 === 0 ? sender : recipient;
    battery.expectAccepted(
      `d2a message ${i + 1}/${ctx.messageCount} in C1 from ${who.label}`,
      await battery.attemptCreate(who, 'directMessage', { conversationId: ctx.c1, encryptedContent: randomBytes(64) })
    );
  }
  for (let i = 0; i < 2; i++) {
    battery.expectAccepted(
      `d2b message ${i + 1}/2 in C2`,
      await battery.attemptCreate(sender, 'directMessage', { conversationId: ctx.c2, encryptedContent: randomBytes(64) })
    );
  }

  // Everything downstream is derived from the timestamps consensus actually
  // assigned: messages written in one block share a $createdAt, so a
  // device-clock midpoint would make d5's expectation a coin flip.
  ctx.c1Times = (await battery.queryDocs('directMessage', {
    where: [['conversationId', '==', b64(ctx.c1)]], orderBy: [['$createdAt', 'asc']], limit: 100,
  })).map((doc) => Number(doc.$createdAt));
  battery.check('d2c C1 messages read back', ctx.c1Times.length === ctx.messageCount,
    `${ctx.c1Times.length} of ${ctx.messageCount}`);

  // t_mid: a timestamp strictly inside the run, chosen so at least one message
  // sits on either side of it even when several share a block.
  const distinct = [...new Set(ctx.c1Times)];
  ctx.tMid = distinct.length > 1 ? distinct[Math.floor(distinct.length / 2) - 1] : (ctx.c1Times[0] ?? 0) - 1;
  ctx.afterMid = ctx.c1Times.filter((time) => time > ctx.tMid).length;
  console.log(`     C1 $createdAt: ${ctx.c1Times.join(', ')} | t_mid=${ctx.tMid} | after=${ctx.afterMid}`);
});

// ---- d3 read receipts --------------------------------------------------------

CASES.set('d3', async (ctx) => {
  const { battery, recipient } = ctx;

  const created = battery.expectAccepted(
    'd3a read receipt created',
    await battery.attemptCreate(recipient, 'readReceipt', { conversationId: ctx.c1 })
  );
  if (!created.ok) return;

  const before = await battery.fetchDocument('readReceipt', created.id);
  battery.expectAccepted(
    'd3b read receipt replaced (markAsRead on a later visit)',
    await battery.attemptReplace(recipient, 'readReceipt', created.id, { conversationId: ctx.c1 }, before?.revision ?? 1n)
  );
  const after = await battery.fetchDocument('readReceipt', created.id);
  battery.check('d3c $updatedAt advanced (this is the "last read" timestamp)',
    Number(after?.updatedAt ?? 0) > Number(before?.updatedAt ?? 0),
    `${before?.updatedAt} → ${after?.updatedAt}`);

  battery.expectRejected(
    'd3d a second receipt for the same (owner, conversation) is rejected',
    await battery.attemptCreate(recipient, 'readReceipt', { conversationId: ctx.c1 }),
    DUPLICATE_UNIQUE
  );
  ctx.receiptId = created.id;
});

// ---- d4 counts ---------------------------------------------------------------

CASES.set('d4', async (ctx) => {
  const { battery } = ctx;

  const where = [['conversationId', '==', b64(ctx.c1)]];
  const total = await battery.countBy('directMessage', where);
  battery.check('d4a count(conversationId == C1) equals the messages written',
    total === ctx.messageCount, `${total} vs ${ctx.messageCount}`);
  battery.workingShapes.push({ label: 'per-conversation message count', shape: { documentTypeName: 'directMessage', where } });

  const c2Total = await battery.countBy('directMessage', [['conversationId', '==', b64(ctx.c2)]]);
  battery.check('d4b count(conversationId == C2) is independent of C1', c2Total === 2, `${c2Total} vs 2`);

  const empty = await battery.countBy('directMessage', [['conversationId', '==', b64(randomBytes(10))]]);
  battery.check('d4c count of a conversation with no messages is 0', empty === 0, String(empty));
});

// ---- d5 range counts (the unread badge) --------------------------------------

CASES.set('d5', async (ctx) => {
  const { battery } = ctx;
  if (ctx.tMid === undefined) { battery.check('d5 has d2 timestamps', false, 'run d2 first'); return; }

  // Guard against a vacuous d5a: if every message landed in one block, t_mid
  // excludes nothing and this case would merely restate d5b, going blind to a
  // range clause being ignored outright.
  battery.check('d5 t_mid actually splits the conversation (otherwise d5a proves nothing)',
    ctx.afterMid > 0 && ctx.afterMid < ctx.messageCount,
    `${ctx.afterMid} of ${ctx.messageCount} after t_mid`);

  const where = [['conversationId', '==', b64(ctx.c1)], ['$createdAt', '>', ctx.tMid]];
  const unread = await battery.countBy('directMessage', where);
  battery.check('d5a count(C1, $createdAt > t_mid) is exact (rangeCountable)',
    unread === ctx.afterMid, `${unread} vs ${ctx.afterMid}`);
  battery.workingShapes.push({ label: 'unread since lastReadAt', shape: { documentTypeName: 'directMessage', where } });

  const all = await battery.countBy('directMessage', [['conversationId', '==', b64(ctx.c1)], ['$createdAt', '>', 0]]);
  battery.check('d5b $createdAt > 0 counts the whole conversation',
    all === ctx.messageCount, `${all} vs ${ctx.messageCount}`);

  const none = await battery.countBy('directMessage', [
    ['conversationId', '==', b64(ctx.c1)], ['$createdAt', '>', Math.max(...ctx.c1Times)],
  ]);
  battery.check('d5c a receipt at the newest message leaves 0 unread', none === 0, String(none));
});

// ---- d6 grouped counts -------------------------------------------------------

CASES.set('d6', async (ctx) => {
  const { battery } = ctx;
  const ids = [ctx.c1, ctx.c2];
  const hexOf = (bytes) => Buffer.from(bytes).toString('hex');
  const expected = new Map([[hexOf(ctx.c1), ctx.messageCount], [hexOf(ctx.c2), 2]]);

  // IN-only: no range clause, so this one is served on the PROVED path.
  try {
    const grouped = await battery.groupedCount(
      'directMessage', [['conversationId', 'in', ids.map(b64)]], ['conversationId']
    );
    const matches = [...expected].every(([key, count]) => grouped.get(key) === count);
    battery.check('d6a grouped count over conversationId in [C1, C2] (proved)', matches,
      `got ${JSON.stringify([...grouped])}, expected ${JSON.stringify([...expected])}`);
    battery.workingShapes.push({
      label: 'total messages per conversation, one call',
      shape: { documentTypeName: 'directMessage', where: [['conversationId', 'in', ids.map(b64)]], groupBy: ['conversationId'] },
    });
  } catch (e) {
    battery.check('d6a grouped count over conversationId in [C1, C2] (proved)', false, describeErr(e).slice(0, 200));
  }

  // IN + range in ONE grouped count. Reported, never fatal: the client must not
  // depend on it either way, because the failure mode measured here is silent.
  const expectedAfterMid = new Map([[hexOf(ctx.c1), ctx.afterMid ?? 0], [hexOf(ctx.c2), 0]]);
  try {
    const grouped = await battery.groupedCount(
      'directMessage', [['conversationId', 'in', ids.map(b64)], ['$createdAt', '>', ctx.tMid ?? 0]], ['conversationId']
    );
    const correct = grouped.size > 0 && [...expectedAfterMid].every(([key, count]) => (grouped.get(key) ?? 0) === count);
    ctx.inRangeNote = grouped.size === 0
      ? 'returns an EMPTY map (no error, no groups) — a SILENTLY WRONG zero. Do not use it.'
      : correct ? 'answered correctly.' : `answered ${JSON.stringify([...grouped])}, expected ${JSON.stringify([...expectedAfterMid])} — wrong.`;
  } catch (e) {
    ctx.inRangeNote = `refused outright: ${describeErr(e).slice(0, 160)}`;
  }
  console.log(`NOTE  d6b grouped IN + $createdAt range count ${ctx.inRangeNote}`);
  battery.check('d6b grouped IN + range count probed (never fatal; the client uses per-conversation range counts)', true, ctx.inRangeNote);
});

// ---- d7 contract-bound encryption key probe ----------------------------------

CASES.set('d7', async (ctx) => {
  const { battery, sdk } = ctx;
  // Never fatal: v4 leaves requiresIdentityEncryptionBoundedKey /
  // requiresIdentityDecryptionBoundedKey unset precisely so the app does not
  // depend on this working. The outcome is documentation.
  const note = (text) => { console.log(`NOTE  d7 ${text}`); ctx.boundKeyNote = text; };

  const entry = ledgerEntry(loadLedger(), ctx.strangerIdx);
  const masterKey = entry?.identityKeys.find((key) => key.keyId === MASTER_KEY_ID);
  if (!masterKey) { note('skipped: the stranger persona has no MASTER key in the seed ledger'); battery.check('d7 probe reported', true, 'skipped'); return; }

  const identity = await battery.readback(() => sdk.identities.fetch(entry.identityId));
  const existing = identity.publicKeys;
  const keyId = existing.reduce((max, key) => Math.max(max, key.keyId), 0) + 1;

  // A fresh secp256k1 key; the SDK needs its private half in the signer to
  // produce the key-ownership proof a full-pubkey addition requires.
  const fresh = generateKeypairHex();
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wifFromHex(masterKey.privateKeyHex));
  signer.addKeyFromWif(wifFromHex(fresh.privateKeyHex));

  const boundKey = new IdentityPublicKeyInCreation({
    keyId, purpose: 'encryption', securityLevel: 'medium', keyType: 'ecdsa_secp256k1',
    isReadOnly: false, data: Uint8Array.from(Buffer.from(fresh.publicKeyHex, 'hex')),
    signature: new Uint8Array(0), contractBounds: ContractBounds.SingleContract(ctx.contractId),
  });

  let broadcastError = null;
  try {
    await sdk.identities.update({ identity, addPublicKeys: [boundKey], signer });
  } catch (e) {
    broadcastError = decodeDriveError(describeErr(e));
  }
  await settle();

  const refreshed = await battery.readback(() => sdk.identities.fetch(entry.identityId));
  const landed = refreshed.publicKeys.find((key) => key.keyId === keyId);
  if (landed) {
    const bounds = landed.contractBounds;
    const boundToUs = bounds ? JSON.stringify(bounds.toJSON?.() ?? bounds) : 'none';
    note(`WORKS on beta.1: contract-bound ENCRYPTION key ${keyId} registered on ${entry.handle}; contractBounds=${boundToUs}. `
      + 'The "disabled due to SDK/tooling bugs" note in lib/services/identity-update-builder.ts is STALE. '
      + 'Not wired into the app in this task (see docs/DM_V4.md).');
  } else {
    // Observed on beta.1: Drive answers "expected encryption key bounds for
    // encryption", i.e. it refuses a SingleContract-bounded ENCRYPTION key
    // whose target contract does not itself declare
    // requiresIdentityEncryptionBoundedKey. That is a consensus rule, not the
    // SDK/tooling bug the app's note blames — and it is a chicken-and-egg:
    // the contract cannot require bounded keys until every identity holds one,
    // and no identity can register one until the contract requires it.
    const chickenAndEgg = /key bounds expected but not present|expected encryption key bounds/i.test(broadcastError ?? '');
    // Re-runs rebuild a byte-identical transition (the key never lands, so the
    // next key id and the identity nonce are unchanged) and Core answers from
    // its tx cache instead of re-evaluating. That is an artefact of running the
    // probe twice, NOT the platform's answer — say so rather than reporting it
    // as the result.
    const cached = /already exists|tx already exists in cache/i.test(broadcastError ?? '');
    note(cached
      ? `INCONCLUSIVE on this run: Core replayed the cached transition from an earlier run `
        + `(${broadcastError}). Run the probe against a persona that has not been probed yet for a fresh answer.`
      : `did NOT land on beta.1. ${broadcastError ?? 'the SDK reported no error'}`
        + (chickenAndEgg
          ? ' — REASON IS A CONSENSUS RULE, NOT AN SDK BUG: a SingleContract-bounded ENCRYPTION key is only accepted '
            + 'against a contract that declares requiresIdentityEncryptionBoundedKey, which v4 deliberately does not. '
            + 'The identity-update-builder.ts note ("disabled due to SDK/tooling bugs") is misattributed.'
          : ' — the identity-update-builder.ts note stands.'));
  }
  battery.check('d7 contract-bound encryption key probe reported', true, landed ? 'registered' : 'not registered');
});

// ---- d8 immutability ---------------------------------------------------------

CASES.set('d8', async (ctx) => {
  const { battery, sender, recipient } = ctx;

  if (ctx.receiptId) {
    const stored = await battery.fetchDocument('readReceipt', ctx.receiptId);
    battery.expectRejected(
      'd8a a readReceipt replace re-pointing conversationId is rejected (40128) — only $updatedAt may move',
      await battery.attemptReplace(recipient, 'readReceipt', ctx.receiptId,
        { conversationId: ctx.c2 }, stored?.revision ?? 1n),
      IMMUTABLE_CHANGED
    );
  } else {
    battery.check('d8a readReceipt immutability', false, 'no receipt fixture (run d3 first)');
  }

  // A message of its own rather than one of d2's, so the exact-count cases stay
  // independent of this one whatever order the cases are selected in. The
  // content is held here rather than re-read off the stored document: d8d needs
  // to resend it byte-identically, and a round-trip through `toObject()` could
  // hand back a shape the write path rejects for an unrelated reason.
  const content = randomBytes(64);
  const message = battery.expectAccepted(
    'd8b a message to edit is created in C2',
    await battery.attemptCreate(sender, 'directMessage', { conversationId: ctx.c2, encryptedContent: content })
  );
  if (message.ok) {
    const revision = (await battery.fetchDocument('directMessage', message.id))?.revision ?? 1n;
    battery.expectRejected(
      'd8c rewriting a sent message\'s encryptedContent is rejected (40128)',
      await battery.attemptReplace(sender, 'directMessage', message.id,
        { conversationId: ctx.c2, encryptedContent: randomBytes(64) }, revision),
      IMMUTABLE_CHANGED
    );
    // Only conversationId differs, so the rejection can only be about the move.
    battery.expectRejected(
      'd8d moving a message into another conversation is rejected (40128) — the count tree cannot be re-keyed',
      await battery.attemptReplace(sender, 'directMessage', message.id,
        { conversationId: ctx.c1, encryptedContent: content }, revision),
      IMMUTABLE_CHANGED
    );
  }

  const invites = await battery.queryDocs('conversationInvite', {
    where: [['$ownerId', '==', sender.ownerId], ['recipientId', '==', recipient.ownerId]], limit: 1,
  });
  if (invites[0]) {
    const inviteId = battery.b58(invites[0].$id);
    const stored = await battery.fetchDocument('conversationInvite', inviteId);
    battery.expectRejected(
      'd8e re-pointing an invite at another conversation is rejected (40128)',
      await battery.attemptReplace(sender, 'conversationInvite', inviteId,
        { recipientId: bs58.decode(recipient.ownerId), conversationId: ctx.c2 }, stored?.revision ?? 1n),
      IMMUTABLE_CHANGED
    );
  } else {
    battery.check('d8e conversationInvite immutability', false, 'no invite fixture (run d1 first)');
  }
});

// ---- entrypoint --------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    contract: process.env.DM_V4_CONTRACT_ID?.trim() || null,
    sender: 220, recipient: 221, stranger: 222, messages: DEFAULT_MESSAGES, only: null,
    // Freshens the conversation ids so exact counts are exact on every run;
    // pass --run <tag> to write into a previous run's conversation instead.
    run: `:${Date.now().toString(36)}`,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--sender': args.sender = Number(argv[++i]); break;
      case '--recipient': args.recipient = Number(argv[++i]); break;
      case '--stranger': args.stranger = Number(argv[++i]); break;
      case '--messages': args.messages = Number(argv[++i]); break;
      case '--only': args.only = argv[++i]; break;
      case '--run': args.run = `:${argv[++i]}`; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contract) throw new Error('Pass --contract <id> or set DM_V4_CONTRACT_ID');
  if (!(args.messages >= 2)) throw new Error('--messages must be at least 2');
  return args;
}

if (process.argv.includes('--self-test')) {
  // d8: everything a DM document says is frozen; only $updatedAt may move.
  process.exit(selfTest('yappr-dm-contract-v4.json', {
    conversationInvite: { immutable: ['conversationId', 'recipientId', 'senderPubKey'] },
    directMessage: { immutable: ['conversationId', 'encryptedContent'] },
    readReceipt: { immutable: ['conversationId'] },
  }));
}

try {
  const args = parseArgs(process.argv.slice(2));
  const only = parseOnly(args.only, CASES);
  await ensureInitialized();
  const socialId = socialContractId();
  const handle = createSdkHandle({ contractIds: [socialId, args.contract] });
  const { protocolVersion } = await handle.connect();
  console.log(`connected (PV${protocolVersion}); DM v4 ${args.contract}`);

  const battery = createBattery({ handle, contractId: args.contract, socialId });
  const [sender, recipient, stranger] = await Promise.all(
    [args.sender, args.recipient, args.stranger].map((idx) => battery.personaActor(idx))
  );
  console.log(`sender=${sender.label} recipient=${recipient.label} stranger=${stranger.label}`);

  const ctx = {
    battery, sdk: battery.sdk, contractId: args.contract, sender, recipient, stranger,
    strangerIdx: args.stranger, messageCount: args.messages, receiptId: null,
    c1: await conversationIdFor(sender.ownerId, recipient.ownerId, args.run),
    c2: await conversationIdFor(sender.ownerId, stranger.ownerId, args.run),
  };
  console.log(`run=${args.run} C1=${bs58.encode(ctx.c1)} C2=${bs58.encode(ctx.c2)}`);

  await runCases(battery, CASES, only, ctx);
  const failures = battery.report(`bound-key probe: ${ctx.boundKeyNote ?? 'not run'}`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
