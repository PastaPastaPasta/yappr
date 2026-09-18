/**
 * Direct messages the deployed app can actually DECRYPT (unlike the registration battery, which writes random bytes
 * because it tests the CONTRACT). Ported from `lib/message-encryption.ts` + `lib/services/direct-message-service.ts`:
 * conversationId   = SHA-256("<lowerId>:<higherId>").slice(0, 10)  (sorted pair)   aesKey           = HKDF-
 * SHA256(ECDH_x, salt "yappr-dm-v1", info "aes-key")   encryptedContent = iv(12) || AES-256-GCM(aesKey, utf8(text))
 * The ECDH key is the identity's HIGH AUTHENTICATION secp256k1 key (`getPublicKeyFromIdentity`), NOT the encryption-
 * purpose one — key id 2 here. Nothing is written until that is proved against the ON-CHAIN identity, since a ledger
 * that disagrees produces messages no browser can open (demo logins therefore need the key 2 WIF). Invites go both
 * ways because `sendMessage` writes the sender's the first time it finds none.
 */
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha2.js';
import { getSharedSecret } from '@noble/secp256k1';
import { IdentitySigner } from '@dashevo/evo-sdk';
import { b64, normalizeId, reportSelfTest } from '../../battery-lib.mjs';
import { CRITICAL_AUTH_KEY_ID, describeErr, ledgerEntry, sleep, wifFromHex } from '../seed-lib.mjs';
import {
  createDocWriter, entropySource, loadCheckpoint, loadLedger, makeMutex, network, personaKeys, pick,
  printTable, rngFrom, saveCheckpoint, utf8,
} from '../feature-seed-lib.mjs';

/** `lib/message-encryption.ts`: HKDF salt/info for the DM AES key. */
const DM_KDF_SALT = utf8('yappr-dm-v1');
const DM_KDF_INFO = utf8('aes-key');
/** `lib/crypto/aes-gcm.ts`: the IV is prepended to the ciphertext. */
const AES_GCM_IV_LENGTH = 12;
/** purpose=AUTHENTICATION(0) + securityLevel=HIGH(2) + type=ECDSA_SECP256K1(0) — key 2 in the seed layout. */
const DM_ECDH_KEY_ID = 2;
const HIGH_SECP256K1 = { type: 0, securityLevel: 2, purpose: 0 };
/**
 * Extra pause after a MID-conversation read receipt. `$updatedAt` and the next message's `$createdAt` are both block
 * times; a collision stops the message the receipt was meant to precede from counting as unread — the one number this
 * script is trying to make non-zero.
 */
const RECEIPT_GAP_MS = 6_000;
const VERIFY_CONCURRENCY = 6;

const ACTORS = [220, 221, 222, 290, 291, 292, 293, 294];

// Deliberately lopsided: chatty-cal3 (290) talks to six people, quiet-quinn7
// (291) to exactly one. [a, b, turns, subject] — `a` is the lower persona index.
const CONVERSATIONS = [
  [220, 290, 26, 'the repair café booking'],
  [221, 290, 12, 'the record fair on saturday'],
  [222, 290, 18, 'how the gig went'],
  [290, 292, 40, 'a long night shift'],
  [290, 293, 14, 'commissioning a bench'],
  [290, 294, 22, 'the bike lane map'],
  [220, 292, 34, 'the new flat and the plants'],
  [291, 292, 9, 'the old hospital records'],
  [292, 294, 16, 'the ridge walk on the 14th'],
  [220, 221, 20, 'line 14 of the budget'],
  [293, 294, 24, 'battens, curves and legends'],
  [222, 293, 11, 'a pedalboard that survives a van'],
];

/** How each persona types. The bank keeps the voices apart; the PRNG picks lines. */
const VOICE = { 220: 'measured', 221: 'terse', 222: 'burst', 290: 'burst', 291: 'measured', 292: 'burst', 293: 'measured', 294: 'measured' };
const CHATTER = {
  burst: ['ok so {subject} is ON 🎉', 'wait really??', 'i knew it', 'do not tell anyone yet', 'that is genuinely great news',
    'you are a treasure', 'send me a photo when you can', 'i am going to sit with that for a week', 'ugh you are right',
    '😂 fair', 'i ate a slice out of principle', 'six is aggressive when the shelf fits four', 'the room was PACKED',
    'honestly the highlight of my month', 'putting it first 🫡', 'ok changing the subject to something nice',
    'come round when you are next free', 'no promises needed, i will bring food', 'i can find you six people, that is my one skill'],
  measured: ['That is the correct amount of time to sit with it.', 'Let me look at {subject} properly tonight.',
    'Three fixed points and a bent batten. The batten does the maths.', 'I have the numbers in front of me, so it would be strange to be vague.',
    'Everything has maintenance. This version just has less of it.', 'Send it as a file rather than a screenshot, if you can.',
    'Yes. Tuesdays and Thursdays, by appointment, pencil only.', 'I would push back on generalising it, but you are right for your case.',
    'Thank you — that is the useful half of the answer.', 'Start at eight. The light then is the entire reason to do it.',
    'Bring the flask. There is nothing at the top.', 'Six is four too many. Send two who can follow instructions.',
    'I will have something for you on Thursday.', 'The date goes in the corner in small type; it does the real work.'],
  terse: ['yes', 'and?', 'line 14 is wrong', 'correct', 'which one', 'i could have', 'cut it', 'no', 'ah. yes. i will come.',
    '10:30. i am not queueing.', 'what thing', 'thank you'],
};

const toArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const bytesToHex = (bytes) => Buffer.from(bytes).toString('hex');

/** Bytes out of whatever shape the SDK handed back (Uint8Array, number[], base64, base58). */
function toBytes(value) {
  if (!value) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (typeof value === 'string') {
    try { return bs58.decode(value); } catch { return Uint8Array.from(Buffer.from(value, 'base64')); }
  }
  return new Uint8Array(0);
}

/** `generateConversationId`: 10 bytes is the minimum Platform treats as bytes, not a string. */
function conversationIdFor(idA, idB) {
  const sorted = [idA, idB].sort();
  return sha256(utf8(`${sorted[0]}:${sorted[1]}`)).slice(0, 10);
}

async function deriveMessageKey(privateKey, otherPublicKey) {
  const sharedX = getSharedSecret(privateKey, otherPublicKey, true).slice(1, 33);
  const material = await crypto.subtle.importKey('raw', toArrayBuffer(sharedX), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(DM_KDF_SALT), info: toArrayBuffer(DM_KDF_INFO) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

/** `encryptToBinary`: iv(12) || AES-256-GCM(text). */
async function encryptToBinary(text, senderPrivateKey, recipientPublicKey) {
  const key = await deriveMessageKey(senderPrivateKey, recipientPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(utf8(text))));
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

/** `decryptFromBinary`: the recipient's half of the same derivation. */
async function decryptFromBinary(blob, recipientPrivateKey, senderPublicKey) {
  const key = await deriveMessageKey(recipientPrivateKey, senderPublicKey);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(blob.slice(0, AES_GCM_IV_LENGTH)) }, key, toArrayBuffer(blob.slice(AES_GCM_IV_LENGTH))
  );
  return new TextDecoder().decode(plain);
}

/** Document ids are derived, never random, so every retry rebuilds the same id. */
const docKey = (...parts) => parts.join('/');

/** Who speaks when: people double- and triple-text, so alternation is irregular. */
function turnsFor(key, count) {
  const rng = rngFrom(`dm/turns/${key}`);
  const who = [];
  let side = rng() < 0.5 ? 'a' : 'b';
  while (who.length < count) {
    const burst = rng() < 0.35 ? (rng() < 0.4 ? 3 : 2) : 1;
    for (let i = 0; i < burst && who.length < count; i++) who.push(side);
    side = side === 'a' ? 'b' : 'a';
  }
  return who;
}

/**
 * The full plan. Deterministic in `seed`: the pairing and turn counts are fixed and the PRNG only chooses the text,
 * the burst pattern and which conversations carry unread. Read scenarios. "Unread" is only ever visible when the
 * NEWEST message is the other party's — `countUnreadByConversation` returns 0 and skips the query when the viewer
 * spoke last — so the reader is the side that did NOT speak last.   read   both receipts written after the final
 * message → 0 / 0   stale  the reader's receipt lands part-way through   → a real unread count   cold   the reader
 * never wrote a receipt at all       → the whole thread unread
 */
function buildPlan(actorsByIdx, seed) {
  const rng = rngFrom(seed);
  const half = Math.floor(CONVERSATIONS.length / 2);
  const deck = [
    ...Array.from({ length: CONVERSATIONS.length - half }, () => 'read'),
    ...Array.from({ length: half }, (_, i) => (i % 3 === 0 ? 'cold' : 'stale')),
  ];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return CONVERSATIONS.map(([idxA, idxB, count, subject], index) => {
    const actorA = actorsByIdx.get(idxA);
    const actorB = actorsByIdx.get(idxB);
    if (!actorA || !actorB) throw new Error(`conversation ${index} needs personas ${idxA} and ${idxB}`);
    const key = `${idxA}-${idxB}`;
    const textRng = rngFrom(`dm/text/${seed}/${key}`);
    const messages = turnsFor(key, count).map((side, position) => {
      const from = side === 'a' ? actorA : actorB;
      const line = pick(textRng, CHATTER[VOICE[from.personaIdx] ?? 'measured']);
      return { position, from, to: side === 'a' ? actorB : actorA, text: line.replaceAll('{subject}', subject) };
    });
    const lastSpeaker = messages.at(-1).from;
    const reader = lastSpeaker === actorA ? actorB : actorA;

    // Receipts in write order: owner → the message count that must precede it.
    const scenario = deck[index];
    let receipts;
    if (scenario === 'read') receipts = [{ owner: actorA, after: count }, { owner: actorB, after: count }];
    else if (scenario === 'stale') {
      // Between 45% and 80% through, so there is always something before it and
      // always something after it.
      const after = Math.max(1, Math.min(count - 1, Math.floor(count * (0.45 + rng() * 0.35))));
      receipts = [{ owner: reader, after }, { owner: lastSpeaker, after: count }];
    } else receipts = [{ owner: lastSpeaker, after: count }];

    const conversationIdBytes = conversationIdFor(actorA.identityId, actorB.identityId);
    return { index, subject, conversationIdBytes, key: bs58.encode(conversationIdBytes), actorA, actorB, messages, scenario, reader, receipts };
  });
}

/** Enum orderings the wasm getters return as strings and the JSON shape as indexes. */
const ENUMS = {
  type: ['ecdsa_secp256k1', 'bls12_381', 'ecdsa_hash160', 'bip13_script_hash', 'eddsa_25519_hash160'],
  purpose: ['authentication', 'encryption', 'decryption', 'transfer', 'system', 'voting', 'owner'],
  securityLevel: ['master', 'critical', 'high', 'medium'],
};
const enumIndex = (value, names) => (typeof value === 'number' ? value : names.indexOf(String(value)));

function ledgerActor(ledger, personaIdx, offline) {
  const keys = personaKeys(ledger, personaIdx, { keyId: DM_ECDH_KEY_ID, offline });
  return {
    personaIdx, handle: keys.handle, identityId: keys.identityId,
    ecdhPrivateKey: keys.privateKey, ecdhPublicKey: keys.publicKey,
  };
}

/**
 * Builds an actor and PROVES its ECDH key against the chain. If the app's own selection rule lands on a different
 * point, every message here would be undecryptable in the browser — a hard stop, not a warning.
 */
async function buildActor(battery, ledger, personaIdx) {
  const actor = ledgerActor(ledger, personaIdx, false);
  const entry = ledgerEntry(ledger, personaIdx);
  const authKey = entry.identityKeys.find((key) => key.keyId === CRITICAL_AUTH_KEY_ID);
  if (!authKey) throw new Error(`persona ${personaIdx} (${entry.handle}) is missing key ${CRITICAL_AUTH_KEY_ID}`);
  const identity = await battery.readback(() => battery.sdk.identities.fetch(entry.identityId));
  if (!identity) throw new Error(`identity ${entry.identityId} (${entry.handle}) not found on this devnet`);
  const facts = identity.publicKeys.map((key) => ({
    keyId: key.keyId ?? key.id,
    type: enumIndex(key.keyTypeNumber ?? key.keyType ?? key.type, ENUMS.type),
    purpose: enumIndex(key.purposeNumber ?? key.purpose, ENUMS.purpose),
    securityLevel: enumIndex(key.securityLevelNumber ?? key.securityLevel, ENUMS.securityLevel),
    data: toBytes(typeof key.data === 'string' && /^[0-9a-f]+$/i.test(key.data) ? Uint8Array.from(Buffer.from(key.data, 'hex')) : key.data),
  }));
  const appChoice = facts.find((key) => key.type === HIGH_SECP256K1.type && key.securityLevel === HIGH_SECP256K1.securityLevel
    && key.purpose === HIGH_SECP256K1.purpose)
    ?? facts.find((key) => key.type === HIGH_SECP256K1.type && key.securityLevel === HIGH_SECP256K1.securityLevel);
  if (!appChoice) throw new Error(`${entry.handle}: the identity has no HIGH secp256k1 key — the app could not encrypt to it`);
  if (bytesToHex(appChoice.data) !== bytesToHex(actor.ecdhPublicKey)) {
    throw new Error(`${entry.handle}: the app would do ECDH with on-chain key ${appChoice.keyId}, but the ledger's key `
      + `${DM_ECDH_KEY_ID} is a different point — the app could not decrypt anything seeded with it.`);
  }
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wifFromHex(authKey.privateKeyHex));
  return {
    ...actor,
    ownerId: actor.identityId,
    identityKey: identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID),
    signer,
    // `identityUsesHash160`: false whenever any HIGH key carries a full point,
    // which is what we just proved, so the app omits senderPubKey.
    usesHash160: !facts.some((key) => key.securityLevel === HIGH_SECP256K1.securityLevel && key.type === HIGH_SECP256K1.type),
    lock: makeMutex(),
  };
}

/**
 * `conversationInvite` is unique on [$ownerId, recipientId] with NO conversationId, so a pair gets exactly one invite
 * ever — and `sendMessage` writes the sender's the first time it finds none.
 */
async function ensureInvite(writer, battery, entry, from, to, conversationIdBytes) {
  const key = `${from.personaIdx}->${to.personaIdx}`;
  if (entry.invites[key]) return false;
  const [existing] = await battery.queryDocs('conversationInvite', {
    where: [['$ownerId', '==', from.identityId], ['recipientId', '==', to.identityId]], limit: 1,
  });
  if (existing) {
    const staleId = normalizeId(existing.$id);
    const onChain = toBytes(existing.conversationId ?? existing.data?.conversationId);
    if (bytesToHex(onChain) === bytesToHex(conversationIdBytes)) {
      entry.invites[key] = staleId;
      return false;
    }
    // The pair gets ONE invite ever, so a leftover naming a different
    // conversation (the battery salts its conversation ids) can never be
    // corrected by writing another: the app would render a phantom empty thread
    // and the seeded thread would have no invite in this direction. Delete and
    // rewrite it.
    console.log(`     replacing ${from.handle}→${to.handle} invite ${staleId}: it names conversation `
      + `${normalizeId(onChain)}, not ${normalizeId(conversationIdBytes)}`);
    const outcome = await battery.attemptDelete(from, 'conversationInvite', staleId);
    if (!outcome.ok) throw new Error(`could not delete the stale ${from.handle}→${to.handle} invite: ${outcome.error}`);
  }
  const { id } = await writer.createDoc(from, 'conversationInvite', docKey('invite', from.identityId, to.identityId), {
    recipientId: bs58.decode(to.identityId),
    conversationId: conversationIdBytes,
    // Mirrors `identityUsesHash160`: only identities with no full-point HIGH key
    // need to publish the ECDH point in the invite.
    ...(from.usesHash160 ? { senderPubKey: from.ecdhPublicKey } : {}),
  });
  entry.invites[key] = id;
  return true;
}

/**
 * `markAsRead`, verbatim. `readReceipt` is unique on [$ownerId, conversationId], so an earlier receipt is the SAME
 * document with a stale `$updatedAt` — replacing advances it, which is the entire point.
 */
async function ensureReceipt(writer, battery, entry, owner, conversationIdBytes) {
  const ownerKey = String(owner.personaIdx);
  if (entry.receipts[ownerKey]) return false;
  const [existing] = await battery.queryDocs('readReceipt', {
    where: [['$ownerId', '==', owner.identityId], ['conversationId', '==', b64(conversationIdBytes)]], limit: 1,
  });
  if (existing) {
    const id = bs58.encode(toBytes(existing.$id));
    await writer.replaceDoc(owner, 'readReceipt', id, { conversationId: conversationIdBytes }, existing.$revision ?? 1n);
    entry.receipts[ownerKey] = id;
    return true;
  }
  const { id, skipped } = await writer.createDoc(owner, 'readReceipt',
    docKey('receipt', bs58.encode(conversationIdBytes), owner.identityId), { conversationId: conversationIdBytes });
  entry.receipts[ownerKey] = id;
  return !skipped;
}

/** One conversation, strictly in order: invites, messages and receipts interleaved. */
async function seedConversation(writer, battery, plan, state) {
  const entry = (state.conversations[plan.key] ??= { pair: [plan.actorA.handle, plan.actorB.handle], messages: {}, invites: {}, receipts: {} });
  entry.scenario = plan.scenario;
  const written = { invites: 0, messages: 0, receipts: 0 };
  const receiptsAt = new Map();
  for (const receipt of plan.receipts) receiptsAt.set(receipt.after, [...(receiptsAt.get(receipt.after) ?? []), receipt.owner]);

  for (const message of plan.messages) {
    if (await ensureInvite(writer, battery, entry, message.from, message.to, plan.conversationIdBytes)) written.invites += 1;
    const slot = String(message.position);
    if (!entry.messages[slot]) {
      const encryptedContent = await encryptToBinary(message.text, message.from.ecdhPrivateKey, message.to.ecdhPublicKey);
      const { id, skipped } = await writer.createDoc(message.from, 'directMessage',
        docKey('message', plan.key, slot, message.from.identityId),
        { conversationId: plan.conversationIdBytes, encryptedContent });
      entry.messages[slot] = id;
      if (!skipped) written.messages += 1;
    }
    for (const owner of receiptsAt.get(message.position + 1) ?? []) {
      if (await ensureReceipt(writer, battery, entry, owner, plan.conversationIdBytes)) written.receipts += 1;
      // Only a receipt with messages still to come needs the block of daylight.
      if (message.position + 1 < plan.messages.length) await sleep(RECEIPT_GAP_MS);
    }
  }
  return written;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

/** Re-reads every conversation through the app's shapes and decrypts the preview. */
async function verify(battery, plans, state) {
  return mapLimit(plans, VERIFY_CONCURRENCY, async (plan) => {
    const conv = b64(plan.conversationIdBytes);
    const total = await battery.countBy('directMessage', [['conversationId', '==', conv]]);
    const planted = Object.keys(state.conversations[plan.key]?.messages ?? {}).length;
    const [newest] = await battery.queryDocs('directMessage', {
      where: [['conversationId', '==', conv], ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']], limit: 1,
    });
    const sides = await Promise.all([plan.actorA, plan.actorB].map(async (viewer) => {
      const [receipt] = await battery.queryDocs('readReceipt', {
        where: [['$ownerId', '==', viewer.identityId], ['conversationId', '==', conv]], limit: 1,
      });
      const lastReadAt = Number(receipt?.$updatedAt ?? receipt?.updatedAt ?? 0);
      // The client's rule: the viewer spoke last ⇒ 0, and no count query at all.
      const iSpokeLast = newest && normalizeId(newest.$ownerId) === viewer.identityId;
      const unread = !newest || iSpokeLast ? 0
        : await battery.countBy('directMessage', [['conversationId', '==', conv], ['$createdAt', '>', lastReadAt]]);
      return { viewer, unread };
    }));

    let preview = null;
    let decryptError = null;
    if (newest) {
      const sender = normalizeId(newest.$ownerId) === plan.actorA.identityId ? plan.actorA : plan.actorB;
      const viewer = sender === plan.actorA ? plan.actorB : plan.actorA;
      try {
        preview = await decryptFromBinary(toBytes(newest.encryptedContent ?? newest.data?.encryptedContent), viewer.ecdhPrivateKey, sender.ecdhPublicKey);
      } catch (e) { decryptError = describeErr(e); }
    }

    // A conversation that wrote every document and still reports the wrong unread
    // count is a FAILED seed: the usual cause is a mid-conversation receipt whose
    // $updatedAt collided with the block time of the messages it should precede.
    const readerSide = sides.find((side) => side.viewer === plan.reader);
    const scenarioError = plan.scenario === 'read'
      ? (sides.some((side) => side.unread > 0) ? `scenario "read" but unread is ${sides.map((s) => `${s.viewer.handle}:${s.unread}`).join(' ')}` : null)
      : (!readerSide || readerSide.unread === 0
        ? `scenario "${plan.scenario}" but ${plan.reader.handle} has 0 unread — the receipt did not land before the tail of the thread` : null);
    return { plan, total, planted, sides, preview, decryptError, scenarioError };
  });
}

const participants = (plan) => `${plan.actorA.handle} ↔ ${plan.actorB.handle}`.slice(0, 28);

async function run({ args, handle, battery, contractId }) {
  const ledger = loadLedger();
  const actors = await mapLimit(ACTORS, 8, (idx) => buildActor(battery, ledger, idx));
  const actorsByIdx = new Map(actors.map((actor) => [actor.personaIdx, actor]));
  console.log(`actors: ${actors.map((a) => `${a.handle}(${a.personaIdx})`).join(', ')}`);
  console.log(`ECDH key check: all ${actors.length} identities resolve key ${DM_ECDH_KEY_ID} (authentication/HIGH) — the key the app encrypts to`);

  const writer = createDocWriter({ handle, contractId, entropyFor: entropySource('yappr-seed-dm'), paymentInfo: () => ({}) });
  const plans = buildPlan(actorsByIdx, args.seed).filter((plan) => !args.only || args.only.includes(String(plan.index)));
  const state = loadCheckpoint(args.state, { network: network(), contractId, seed: args.seed }, { conversations: {} });

  if (!args.verifyOnly) {
    // PROOF FIRST: one message is written, read back off the chain and decrypted
    // with the RECIPIENT's key before the other ~245 are spent.
    const pilot = plans[0];
    const first = pilot.messages[0];
    const entry = (state.conversations[pilot.key] ??= { pair: [pilot.actorA.handle, pilot.actorB.handle], messages: {}, invites: {}, receipts: {} });
    await ensureInvite(writer, battery, entry, first.from, first.to, pilot.conversationIdBytes);
    const { id } = await writer.createDoc(first.from, 'directMessage', docKey('message', pilot.key, '0', first.from.identityId),
      { conversationId: pilot.conversationIdBytes, encryptedContent: await encryptToBinary(first.text, first.from.ecdhPrivateKey, first.to.ecdhPublicKey) });
    entry.messages['0'] = id;
    saveCheckpoint(args.state, state);
    const fetched = await battery.fetchDocument('directMessage', id);
    if (!fetched) throw new Error(`the pilot message ${id} did not read back`);
    const stored = fetched.toObject?.() ?? fetched;
    const recovered = await decryptFromBinary(toBytes(stored.encryptedContent ?? stored.data?.encryptedContent), first.to.ecdhPrivateKey, first.from.ecdhPublicKey);
    if (recovered !== first.text) throw new Error(`decrypted "${recovered}" but wrote "${first.text}"`);
    console.log(`PROOF  ${id}: ${first.to.handle}'s key ${DM_ECDH_KEY_ID} decrypts ${first.from.handle}'s on-chain ciphertext`);

    const totals = { invites: 0, messages: 0, receipts: 0 };
    const aborted = [];
    // One poisoned document must not cost the other conversations their run.
    await mapLimit(plans, args.concurrency, async (plan) => {
      try {
        const written = await seedConversation(writer, battery, plan, state);
        for (const key of Object.keys(totals)) totals[key] += written[key];
      } catch (e) {
        aborted.push(plan.key);
        console.log(`ABORT ${plan.key}: ${describeErr(e).slice(0, 200)}`);
      } finally { saveCheckpoint(args.state, state); }
    });
    console.log(`wrote ${totals.messages} directMessage, ${totals.invites} conversationInvite, ${totals.receipts} readReceipt`
      + (aborted.length ? `; ${aborted.length} conversation(s) aborted — re-run to resume` : ''));
  }

  const rows = await verify(battery, plans, state);
  printTable([['conversation', 14], ['participants', 28], ['msgs', -4], ['scenario', 8], ['unread', 15], ['newest message (decrypted)', 46]],
    rows.map((row) => {
      const [a, b] = row.sides;
      return [row.plan.key.slice(0, 12), participants(row.plan), row.total, row.plan.scenario,
        `${a.viewer.handle.slice(0, 5)}:${a.unread} ${b.viewer.handle.slice(0, 5)}:${b.unread}`,
        row.decryptError ? `DECRYPT FAILED: ${row.decryptError.slice(0, 30)}` : (row.preview ?? '(no messages)').replace(/\s+/g, ' ').slice(0, 44)];
    }));
  const failures = rows.filter((row) => row.decryptError || row.scenarioError || row.planted !== row.plan.messages.length);
  const unread = rows.filter((row) => row.sides.some((side) => side.unread > 0));
  console.log(`\n${rows.length} conversations, ${rows.reduce((total, row) => total + row.total, 0)} messages on chain, `
    + `${unread.length} with a non-zero unread count; newest message decrypted in ${rows.length - rows.filter((r) => r.decryptError).length}/${rows.length}`);
  for (const row of failures) {
    console.log(`FAIL  ${row.plan.key}: ${row.decryptError ?? row.scenarioError ?? `${row.planted} of ${row.plan.messages.length} planned messages written`}`);
  }
  console.log(`checkpoint: ${args.state}`);
  return failures.length === 0 ? 0 : 1;
}

const offlinePlan = (args) => buildPlan(new Map(ACTORS.map((idx) => [idx, ledgerActor(loadLedger(), idx, true)])), args.seed);

/** Fully offline: encrypts and decrypts every planned message with the real key pair. */
async function dryRun(plans, args) {
  printTable([['conversation', 14], ['participants', 28], ['msgs', -4], ['scenario', 8], ['receipts', 40]],
    plans.map((plan) => [plan.key.slice(0, 12), participants(plan), plan.messages.length, plan.scenario,
      plan.receipts.map((r) => `${r.owner.handle}@${r.after}`).join(' ')]), `seed ${args.seed}, ${plans.length} conversations`);
  let proved = 0;
  for (const plan of plans) {
    for (const message of plan.messages) {
      const blob = await encryptToBinary(message.text, message.from.ecdhPrivateKey, message.to.ecdhPublicKey);
      if (await decryptFromBinary(blob, message.to.ecdhPrivateKey, message.from.ecdhPublicKey) !== message.text) {
        throw new Error(`round-trip mismatch in conversation ${plan.key} at ${message.position}`);
      }
      proved += 1;
    }
  }
  const messages = plans.reduce((total, plan) => total + plan.messages.length, 0);
  console.log(`\n${plans.length} conversations, ${messages} directMessage, ${plans.reduce((t, p) => t + p.receipts.length, 0)} readReceipt, `
    + `up to ${plans.length * 2} conversationInvite.`);
  console.log(`${proved}/${messages} messages encrypted and decrypted back with the recipient's key ${DM_ECDH_KEY_ID} (offline round-trip).`);
  return 0;
}

function selfTest(args) {
  const plans = offlinePlan(args);
  const degree = new Map();
  for (const plan of plans) for (const idx of [plan.actorA.personaIdx, plan.actorB.personaIdx]) degree.set(idx, (degree.get(idx) ?? 0) + 1);
  return reportSelfTest('the DM plan', [
    [`12 conversations (${plans.length})`, plans.length === 12],
    ['246 messages', plans.reduce((n, p) => n + p.messages.length, 0) === 246],
    ['22 read receipts', plans.reduce((n, p) => n + p.receipts.length, 0) === 22],
    ['the reader is always the side that did not speak last', plans.every((p) => p.messages.at(-1).from !== p.reader)],
    ['half the conversations carry unread', plans.filter((p) => p.scenario !== 'read').length === 6],
    ['every stale receipt lands mid-conversation',
      plans.filter((p) => p.scenario === 'stale').every((p) => p.receipts[0].after > 0 && p.receipts[0].after < p.messages.length)],
    [`the graph stays lopsided (290 talks to ${degree.get(290)}, 291 to ${degree.get(291)})`, degree.get(290) === 6 && degree.get(291) === 1],
    ['every pair derives a distinct conversation id', new Set(plans.map((p) => p.key)).size === 12],
  ]);
}

export default {
  name: 'dm',
  state: '.seed-dm.local.json',
  contractEnv: ['DM_CONTRACT_ID', 'NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID'],
  defaults: { seed: '20260917', concurrency: 4 },
  plan: offlinePlan,
  dryRun,
  selfTest,
  run,
};
