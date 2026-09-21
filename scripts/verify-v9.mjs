/**
 * Registration-day battery for **contract v9**
 * (`contracts/yappr-social-contract-v9.json`, docs/SOCIAL_V9.md): the proved
 * tip receipts, exercised against a freshly registered v9 contract on a
 * beta.3 devnet. The machinery is {@link file://./verify-lib.mjs}; v9's query
 * surface is v8's, so this file holds only the tip cases.
 *
 * There is NO default contract id. Pass `--contract` or set `V9_CONTRACT_ID`.
 *
 * ## What is actually being proved
 *
 * A tip document CITES the token-history `transfer` that paid it, across
 * contracts, and the contract binds what the citation says:
 *
 *     tip.$ownerId    == transfer.$ownerId        (only the sender may write it)
 *     tip.amount      == transfer.amount          (the number is not a claim)
 *     tip.recipientId == transfer.toIdentityId    (who was actually paid)
 *     tip.recipientId == post.$ownerId            (and they authored the post)
 *
 * Every case below is one of those bindings, attacked. A case that "passes" by
 * being REJECTED is the point: if any of them were accepted, the strip the app
 * renders would be showing a number nobody checked.
 *
 * ## Cases
 *
 *   p1  a real tip: A transfers YAPP to B, the transfer document appears on the
 *       sender's own index, and the id the client DERIVES for it (the shipped
 *       `lib/tip-transfer-id.ts` formula, restated here) is that document's id
 *   p2  A's tip citing that transfer on B's post lands, reads back with the
 *       amount and payee the transfer carried, and counts to 1 on `byTipped`
 *       and `byRecipient` — the proved counts the profile and the strip show
 *   p3  the same transfer cited a SECOND time is refused (40105): one payment
 *       cannot be shown as two tips
 *   p4  a tip inflating `amount` above the transfer is refused (40127)
 *   p5  a tip naming someone else as the payee is refused (40127)
 *   p6  a tip on a post by someone OTHER than the payee is refused (40127) —
 *       the binding that stops a real payment being displayed under an
 *       unrelated post
 *   p7  a tip citing A's transfer, written by B, is refused (40127): the
 *       writer gate, which is what stops a bystander minting receipts
 *   p8  a tip citing a transfer id that does not exist is refused (40120)
 *   p9  a tip carrying a messageReplyId naming SOMEONE ELSE's reply is refused
 *       (40127); naming the tipper's own reply lands
 *   p10 a tipReply on B's reply lands and counts, and the tip amount is the
 *       transfer's — the second doctype, same bindings
 *
 * ## Run
 *
 *   node scripts/verify-v9.mjs --self-test
 *   NETWORK=devnet node scripts/verify-v9.mjs --contract <freshV9Id> [--bot 0] [--bot2 1] [--only p2,p4]
 *
 * Both bots need YAPP on the contract under test (the registration script's
 * `--fund`) AND credits: posts and replies on v9 still carry v8's credit action
 * fee, and the tips themselves cost 1 YAPP each.
 */
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha2.js';
import { DocumentActionFeeAgreement } from '@dashevo/evo-sdk';
import {
  PREFER_CONTRACT_OWNER,
  YAPP_TOKEN_POSITION,
  actionFeeAgreementOptions,
  actionFeeFor,
  feeMultiplierPermille,
  paymentInfo,
} from './seed/seed-lib.mjs';
import { criticalAuthKey, deriveIdentityKeys } from './derive-identities.mjs';
import { describeErr } from './owner-keys.mjs';
import {
  DUPLICATE_UNIQUE,
  PROPERTY_MISMATCH,
  TOKEN_COST,
  check,
  countBy,
  expectAccepted,
  expectRejected,
  fetchDocument,
  manualCreate,
  randomIdBytes,
  readback,
  runBattery,
} from './verify-lib.mjs';

/** The system token-history contract — the same id on every chain. */
const HISTORY = '43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF';

const POST_ACTION_FEE = actionFeeFor('post', 'v9');
const REPLY_ACTION_FEE = actionFeeFor('reply', 'v9');
const TIP_AMOUNT = 5n;
const SETTLE_MS = 3000;
const settle = (ms = SETTLE_MS) => new Promise((resolve) => setTimeout(resolve, ms));

const REFERENCE_NOT_FOUND = /\bcode"?\s*[=:]\s*40120\b|referenced .{0,60}not found|referencedentitynotfound/i;

const someId = randomIdBytes;
const botIndexArg = (flag, fallback) => { const i = process.argv.indexOf(flag); return i === -1 ? fallback : Number(process.argv[i + 1]); };

// ---- The transfer document id, restated ------------------------------------
//
// Deliberately a RESTATEMENT of rs-dpp's derivation rather than an import of
// `lib/tip-transfer-id.ts`: p1 compares this against the id Platform actually
// wrote, so a live run proves the formula the browser uses. Importing the
// browser's copy would only prove it agrees with itself.

function transferDocumentId(tokenId, senderId, nonce) {
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, nonce, false);
  const payload = new Uint8Array([
    ...bs58.decode(tokenId),
    ...bs58.decode(senderId),
    ...new TextEncoder().encode('history_transfer'),
    ...nonceBytes,
  ]);
  return bs58.encode(sha256(sha256(payload)));
}

// ---- Shapes ------------------------------------------------------------------

const postData = ({ content = 'v9 battery post' } = {}) => ({ content, language: 'en' });
const replyData = ({ content = 'v9 battery reply', rootPostId, parentOwnerId }) => ({ content, rootPostId, parentOwnerId });

/**
 * A tip document. Every identifier goes in as raw bytes, exactly as
 * `tipService.recordTip` sends them.
 */
const tipData = ({ transferId, amount, recipientId, postId, replyId, messageReplyId }) => ({
  transferId: bs58.decode(transferId),
  amount: Number(amount),
  recipientId: bs58.decode(recipientId),
  ...(postId ? { postId: bs58.decode(postId) } : {}),
  ...(replyId ? { replyId: bs58.decode(replyId) } : {}),
  ...(messageReplyId ? { messageReplyId: bs58.decode(messageReplyId) } : {}),
});

/** The YAPP payment a tip create carries (1 YAPP, contract owner preferred for gas). */
const tipPayment = () => paymentInfo(BigInt(TOKEN_COST.tip), { gasFeesPaidBy: PREFER_CONTRACT_OWNER }).tokenPaymentInfo;

/** A tip create: no action fee (v9 prices none on the tip types), YAPP payment attached. */
const createTip = (ctx, who, docType, data) =>
  manualCreate(ctx.sdk, who, { contractId: ctx.contractId, docType, data, payment: tipPayment() });

async function feeAgreement(ctx, fee) {
  const knownPermille = await readback(() => feeMultiplierPermille(ctx.sdk));
  return new DocumentActionFeeAgreement(actionFeeAgreementOptions(fee, knownPermille));
}

// ---- Reads -------------------------------------------------------------------

/** The sender's own newest transfers — the page the client reads to learn a transfer's id. */
async function sentTransfers(ctx, senderId) {
  const response = await readback(() => ctx.sdk.documents.query({
    dataContractId: HISTORY,
    documentTypeName: 'transfer',
    where: [['tokenId', '==', ctx.tokenId], ['$ownerId', '==', senderId]],
    orderBy: [['tokenId', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']],
    limit: 100,
  }));
  const rows = [];
  if (response instanceof Map) {
    for (const document of response.values()) {
      const raw = typeof document.toObject === 'function' ? document.toObject() : document;
      rows.push({
        id: typeof raw.$id === 'string' ? raw.$id : bs58.encode(Uint8Array.from(raw.$id)),
        amount: BigInt(raw.amount ?? 0),
        to: typeof raw.toIdentityId === 'string' ? raw.toIdentityId : bs58.encode(Uint8Array.from(raw.toIdentityId)),
        createdAt: Number(raw.$createdAt ?? 0),
      });
    }
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * A YAPP transfer from `who` to `to`, and the transfer document it produced.
 *
 * The nonce is read before the transfer so the derived id can be checked
 * against the one Platform wrote — the same trick the client would use if the
 * SDK told it which nonce it spent.
 */
async function sendTip(ctx, who, to, amount) {
  const { sdk, contractId, tokenId } = ctx;
  const rawNonce = (await readback(() => sdk.wasm.getIdentityContractNonce(who.ownerId, contractId))) ?? 0n;
  const expectedNonce = (BigInt(rawNonce) & ((1n << 40n) - 1n)) + 1n;

  let error = null;
  try {
    await sdk.tokens.transfer({
      dataContractId: contractId,
      tokenPosition: YAPP_TOKEN_POSITION,
      senderId: who.ownerId,
      recipientId: to,
      amount,
      publicNote: `yappr:tip:v1:post:${ctx.posts.tipped ?? bs58.encode(randomIdBytes())}`,
      identityKey: who.identityKey,
      signer: who.signer,
    });
  } catch (e) {
    // A transfer that 504s on the wait usually landed; the read below decides.
    error = describeErr(e);
  }

  for (let poll = 0; poll < 4; poll++) {
    await settle();
    const rows = await sentTransfers(ctx, who.ownerId);
    const landed = rows.find((row) => row.to === to && row.amount === amount && !ctx.seenTransfers.has(row.id));
    if (landed) {
      ctx.seenTransfers.add(landed.id);
      return { ...landed, expectedNonce, error: null };
    }
  }
  return { id: null, expectedNonce, error: error ?? 'the transfer is not on the sender\'s index' };
}

// ---- Cases -------------------------------------------------------------------

/** Posts and a reply by B, whose author is the payee every tip below names. */
async function ensurePrepared(ctx) {
  if (ctx.prepared) return;
  ctx.prepared = true;
  const { botA, botB } = ctx;
  ctx.tokenId ??= await readback(() => ctx.sdk.tokens.calculateId(ctx.contractId, YAPP_TOKEN_POSITION));

  const postAgreement = await feeAgreement(ctx, POST_ACTION_FEE);
  const tipped = await manualCreate(ctx.sdk, botB, { contractId: ctx.contractId, docType: 'post', data: postData(), agreement: postAgreement });
  ctx.posts.tipped = tipped.ok ? tipped.id : null;
  // A post by the OTHER bot, so p6 can aim a real payment at the wrong post.
  const foreign = await manualCreate(ctx.sdk, botA, { contractId: ctx.contractId, docType: 'post', data: postData({ content: 'v9 battery post by A' }), agreement: postAgreement });
  ctx.posts.foreign = foreign.ok ? foreign.id : null;

  if (ctx.posts.tipped) {
    const replyAgreement = await feeAgreement(ctx, REPLY_ACTION_FEE);
    // B's reply, the thing p10 tips; and A's reply, which p9 attaches to a tip.
    const tippedReply = await manualCreate(ctx.sdk, botB, {
      contractId: ctx.contractId, docType: 'reply',
      data: replyData({ rootPostId: bs58.decode(ctx.posts.tipped), parentOwnerId: bs58.decode(botB.ownerId) }),
      agreement: replyAgreement,
    });
    ctx.replies.tipped = tippedReply.ok ? tippedReply.id : null;
    const ownReply = await manualCreate(ctx.sdk, botA, {
      contractId: ctx.contractId, docType: 'reply',
      data: replyData({ content: 'thanks for this', rootPostId: bs58.decode(ctx.posts.tipped), parentOwnerId: bs58.decode(botB.ownerId) }),
      agreement: replyAgreement,
    });
    ctx.replies.byTipper = ownReply.ok ? ownReply.id : null;
  }
  console.log(`     fixtures: post=${ctx.posts.tipped} foreign=${ctx.posts.foreign} reply=${ctx.replies.tipped} tipperReply=${ctx.replies.byTipper}`);
}

const prepared = (fn) => async (ctx) => { await ensurePrepared(ctx); return fn(ctx); };

async function caseP1Transfer(ctx) {
  console.log('\n--- p1. the transfer, and the id the client derives for it ---');
  const transfer = await sendTip(ctx, ctx.botA, ctx.botB.ownerId, TIP_AMOUNT);
  ctx.transfer = transfer;
  check('p1a A\'s YAPP transfer to B is on the sender\'s own index', transfer.id !== null, transfer.id ?? transfer.error);
  if (!transfer.id) return;
  check('p1b the transfer carries the exact amount', transfer.amount === TIP_AMOUNT, `${transfer.amount}`);

  const derived = transferDocumentId(ctx.tokenId, ctx.botA.ownerId, transfer.expectedNonce);
  check(
    'p1c the id derived from (token, sender, nonce) is the id Platform wrote',
    derived === transfer.id,
    derived === transfer.id ? derived : `derived ${derived} != ${transfer.id} (nonce ${transfer.expectedNonce})`
  );
}

const tipOn = (ctx, overrides = {}) => tipData({
  transferId: ctx.transfer.id,
  amount: TIP_AMOUNT,
  recipientId: ctx.botB.ownerId,
  postId: ctx.posts.tipped,
  ...overrides,
});

/** Every case after p1 needs a transfer to cite; make one if `--only` skipped p1. */
async function ensureTransfer(ctx) {
  if (!ctx.transfer?.id) ctx.transfer = await sendTip(ctx, ctx.botA, ctx.botB.ownerId, TIP_AMOUNT);
  return ctx.transfer.id !== null;
}

async function caseP2Tip(ctx) {
  console.log('\n--- p2. the tip: accepted, and counted ---');
  if (!(await ensureTransfer(ctx)) || !ctx.posts.tipped) return check('p2 fixtures', false, 'no transfer or no post to tip');

  const created = await createTip(ctx, ctx.botA, 'tip', tipOn(ctx));
  expectAccepted('p2a A\'s tip citing that transfer on B\'s post lands', created);
  ctx.tipId = created.ok ? created.id : null;
  if (!created.ok) return;

  const document = await fetchDocument(ctx.sdk, ctx.contractId, 'tip', created.id);
  const raw = typeof document?.toObject === 'function' ? document.toObject() : document;
  check('p2b the stored amount is the transfer\'s amount', BigInt(raw?.amount ?? 0) === TIP_AMOUNT, `${raw?.amount}`);

  // The two count trees the app reads: the strip's "is this all of them", and
  // the profile's lifetime "tips received".
  check('p2c byTipped counts the post\'s tips', (await countBy(ctx.sdk, ctx.contractId, 'tip', 'postId', bs58.decode(ctx.posts.tipped))) >= 1);
  check('p2d byRecipient counts B\'s tips received', (await countBy(ctx.sdk, ctx.contractId, 'tip', 'recipientId', bs58.decode(ctx.botB.ownerId))) >= 1);
}

async function caseP3Duplicate(ctx) {
  console.log('\n--- p3. one payment cannot be shown as two tips ---');
  if (!ctx.tipId) return check('p3 fixtures', false, 'p2 did not land a tip to duplicate');
  expectRejected(
    'p3 a second tip citing the same transfer is refused (40105)',
    await createTip(ctx, ctx.botA, 'tip', tipOn(ctx)),
    DUPLICATE_UNIQUE
  );
}

async function caseP4Inflated(ctx) {
  console.log('\n--- p4. the amount is not the tipper\'s to choose ---');
  if (!(await ensureTransfer(ctx)) || !ctx.posts.tipped) return check('p4 fixtures', false, 'no transfer or post');
  expectRejected(
    'p4 a tip claiming more YAPP than the transfer moved is refused (40127)',
    await createTip(ctx, ctx.botA, 'tip', tipOn(ctx, { amount: TIP_AMOUNT * 1000n })),
    PROPERTY_MISMATCH
  );
}

async function caseP5WrongPayee(ctx) {
  console.log('\n--- p5. the payee is not the tipper\'s to choose ---');
  if (!(await ensureTransfer(ctx)) || !ctx.posts.tipped) return check('p5 fixtures', false, 'no transfer or post');
  expectRejected(
    'p5 a tip naming a payee the transfer never paid is refused (40127)',
    await createTip(ctx, ctx.botA, 'tip', tipOn(ctx, { recipientId: ctx.botA.ownerId })),
    PROPERTY_MISMATCH
  );
}

async function caseP6WrongPost(ctx) {
  console.log('\n--- p6. a real payment cannot be stapled under an unrelated post ---');
  if (!(await ensureTransfer(ctx)) || !ctx.posts.foreign) return check('p6 fixtures', false, 'no transfer or foreign post');
  expectRejected(
    'p6 a tip whose post is by someone other than the payee is refused (40127)',
    await createTip(ctx, ctx.botA, 'tip', tipOn(ctx, { postId: ctx.posts.foreign })),
    PROPERTY_MISMATCH
  );
}

async function caseP7Bystander(ctx) {
  console.log('\n--- p7. the writer gate: only the sender may record their payment ---');
  if (!(await ensureTransfer(ctx)) || !ctx.posts.tipped) return check('p7 fixtures', false, 'no transfer or post');
  expectRejected(
    'p7 B citing A\'s transfer is refused (40127)',
    await createTip(ctx, ctx.botB, 'tip', tipOn(ctx)),
    PROPERTY_MISMATCH
  );
}

async function caseP8Ghost(ctx) {
  console.log('\n--- p8. a tip must cite a transfer that exists ---');
  if (!ctx.posts.tipped) return check('p8 fixtures', false, 'no post');
  expectRejected(
    'p8 a tip citing a transfer id nothing wrote is refused (40120)',
    await createTip(ctx, ctx.botA, 'tip', tipOn(ctx, { transferId: bs58.encode(randomIdBytes()) })),
    REFERENCE_NOT_FOUND
  );
}

async function caseP9MessageReply(ctx) {
  console.log('\n--- p9. the words a tip carries must be the tipper\'s own reply ---');
  if (!ctx.posts.tipped || !ctx.replies.tipped || !ctx.replies.byTipper) return check('p9 fixtures', false, 'no replies');

  const foreign = await sendTip(ctx, ctx.botA, ctx.botB.ownerId, TIP_AMOUNT);
  if (!foreign.id) return check('p9 fixtures', false, foreign.error);
  expectRejected(
    'p9a a tip naming B\'s reply as its message is refused (40127)',
    await createTip(ctx, ctx.botA, 'tip', tipData({
      transferId: foreign.id, amount: TIP_AMOUNT, recipientId: ctx.botB.ownerId,
      postId: ctx.posts.tipped, messageReplyId: ctx.replies.tipped,
    })),
    PROPERTY_MISMATCH
  );

  const own = await sendTip(ctx, ctx.botA, ctx.botB.ownerId, TIP_AMOUNT);
  if (!own.id) return check('p9 fixtures', false, own.error);
  expectAccepted(
    'p9b a tip naming the tipper\'s OWN reply lands',
    await createTip(ctx, ctx.botA, 'tip', tipData({
      transferId: own.id, amount: TIP_AMOUNT, recipientId: ctx.botB.ownerId,
      postId: ctx.posts.tipped, messageReplyId: ctx.replies.byTipper,
    }))
  );
}

async function caseP10TipReply(ctx) {
  console.log('\n--- p10. the same bindings on a tip against a reply ---');
  if (!ctx.replies.tipped) return check('p10 fixtures', false, 'no reply to tip');

  const transfer = await sendTip(ctx, ctx.botA, ctx.botB.ownerId, TIP_AMOUNT);
  if (!transfer.id) return check('p10 fixtures', false, transfer.error);

  expectAccepted(
    'p10a a tipReply on B\'s reply lands',
    await createTip(ctx, ctx.botA, 'tipReply', tipData({
      transferId: transfer.id, amount: TIP_AMOUNT, recipientId: ctx.botB.ownerId, replyId: ctx.replies.tipped,
    }))
  );
  check('p10b byTipped counts the reply\'s tips', (await countBy(ctx.sdk, ctx.contractId, 'tipReply', 'replyId', bs58.decode(ctx.replies.tipped))) >= 1);

  const other = await sendTip(ctx, ctx.botA, ctx.botB.ownerId, TIP_AMOUNT);
  if (!other.id) return;
  expectRejected(
    'p10c a tipReply whose amount does not match its transfer is refused (40127)',
    await createTip(ctx, ctx.botA, 'tipReply', tipData({
      transferId: other.id, amount: TIP_AMOUNT + 1n, recipientId: ctx.botB.ownerId, replyId: ctx.replies.tipped,
    })),
    PROPERTY_MISMATCH
  );
}

const CASES = new Map([
  ['p1', prepared(caseP1Transfer)],
  ['p2', prepared(caseP2Tip)],
  ['p3', prepared(caseP3Duplicate)],
  ['p4', prepared(caseP4Inflated)],
  ['p5', prepared(caseP5WrongPayee)],
  ['p6', prepared(caseP6WrongPost)],
  ['p7', prepared(caseP7Bystander)],
  ['p8', prepared(caseP8Ghost)],
  ['p9', prepared(caseP9MessageReply)],
  ['p10', prepared(caseP10TipReply)],
]);

const wifForBot = (index) => criticalAuthKey(deriveIdentityKeys(index)).wif;

if (process.argv.includes('--self-test') || process.argv.includes('--dry-run')) {
  // The derivation p1c asserts live, checked offline first: deterministic,
  // nonce-sensitive, and 32 bytes. A wrong formula would make every tip in
  // this battery a paid 40120 for reasons no case would explain.
  const token = bs58.encode(new Uint8Array(32).fill(3));
  const sender = bs58.encode(new Uint8Array(32).fill(4));
  const a = transferDocumentId(token, sender, 1n);
  const b = transferDocumentId(token, sender, 1n);
  const c = transferDocumentId(token, sender, 2n);
  console.log(`transfer id derivation: deterministic=${a === b} nonce-sensitive=${a !== c} (${a})`);
  if (a !== b || a === c || bs58.decode(a).length !== 32) { console.error('FAIL  transfer id derivation'); process.exit(1); }

  // v9 prices no action on the tip types: a battery that sent an agreement
  // would be refused 40133, and one that expected a fee would assert a number
  // the contract does not declare.
  const tipFee = actionFeeFor('tip', 'v9');
  console.log(`tip action fee off the contract: ${tipFee === null ? 'none' : JSON.stringify(tipFee)}; post=${POST_ACTION_FEE.moderators} reply=${REPLY_ACTION_FEE.moderators}`);
  if (tipFee !== null || POST_ACTION_FEE.moderators !== 80_000_000n || REPLY_ACTION_FEE.moderators !== 16_000_000n) {
    console.error('FAIL  action fees do not match contracts/yappr-social-contract-v9.json');
    process.exit(1);
  }
  if (TOKEN_COST.tip !== 1 || TOKEN_COST.tipReply !== 1) { console.error('FAIL  tip YAPP cost'); process.exit(1); }
}

await runBattery({
  name: 'v9',
  contractEnvVar: 'V9_CONTRACT_ID',
  usage:
    'Usage: node scripts/verify-v9.mjs --contract <id> [--bot <n>] [--bot2 <n>]\n' +
    '       [--owner <id>] [--owner2 <id>] [--only p2,p4] [--dry-run|--self-test]',
  cases: CASES,
  shapes: [
    ['tip (on a post)', 'tip', tipData({ transferId: bs58.encode(someId()), amount: 5n, recipientId: bs58.encode(someId()), postId: bs58.encode(someId()) })],
    ['tip (with a message reply)', 'tip', tipData({ transferId: bs58.encode(someId()), amount: 5n, recipientId: bs58.encode(someId()), postId: bs58.encode(someId()), messageReplyId: bs58.encode(someId()) })],
    ['tipReply (on a reply)', 'tipReply', tipData({ transferId: bs58.encode(someId()), amount: 5n, recipientId: bs58.encode(someId()), replyId: bs58.encode(someId()) })],
    ['post (fixture)', 'post', postData()],
    ['reply (fixture)', 'reply', replyData({ rootPostId: someId(), parentOwnerId: someId() })],
  ],
  makeContext: ({ sdk, contractId, botA, botB }) => ({
    sdk,
    contractId,
    botA: { ...botA, wif: wifForBot(botIndexArg('--bot', 0)) },
    botB: { ...botB, wif: wifForBot(botIndexArg('--bot2', 1)) },
    posts: {},
    replies: {},
    transfer: null,
    tipId: null,
    // Transfers this run has already claimed, so two identical tips cannot
    // both resolve to the same transfer document.
    seenTransfers: new Set(),
    tokenId: null,
    prepared: false,
  }),
  summarize: (ctx) => {
    console.log(`fixtures: ${JSON.stringify({ ...ctx.posts, ...ctx.replies })}`);
    console.log(`transfer: ${ctx.transfer?.id ?? 'none'} tip: ${ctx.tipId ?? 'none'}`);
  },
});
