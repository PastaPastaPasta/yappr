/**
 * Registration-day battery for **YAPP tips** (docs/NON_SOCIAL_CONTRACTS.md).
 *
 * Tips are not a Yappr contract at all: a tip is a YAPP token transfer, and the
 * proof is the `transfer` document Platform writes into the SYSTEM token-history
 * contract because YAPP sets `keepsTransferHistory`. Actors are seed-ledger
 * personas — a TIPPER and a CREATOR; the tipper signs with its CRITICAL auth key,
 * which every batch carrying a token transition needs.
 *
 *   NETWORK=devnet node scripts/verify-tips.mjs \
 *     [--tipper 240] [--creator 241] [--amount 5] [--only t2,t3]
 *   node scripts/verify-tips.mjs --self-test   # offline: the tip-note codec alone
 */
import { BatchTransition, BatchedTransition, StateTransition, TokenBaseTransition, TokenTransferTransition, TokenTransition } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { normalizeId, reportSelfTest, runBattery, settle } from './battery-lib.mjs';
import { YAPP_TOKEN_POSITION, describeErr } from './seed/seed-lib.mjs';

/** The system token-history contract — identical on every chain. */
const HISTORY = '43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF';
const TIP_NOTE_PREFIX = 'yappr:tip:v1:';
const SEQUENCE_MASK = (1n << 40n) - 1n;
/** `transfer.publicNote` maxLength on the system contract; t1 re-reads it from chain. */
const NOTE_MAX = 2048;
/** The app's tip message cap (lib/tip-note.ts). */
const MESSAGE_MAX = 280;
const CONTROL_NOTE = 'battery control transfer, not a tip';
const TIP_MESSAGE = 'battery tip';

/** Mirrors lib/tip-note.ts — kept literal here so the battery checks the encoding, not the app's copy of it. */
const encodeTipNote = (kind, targetId, message) => (message ? `${TIP_NOTE_PREFIX}${kind}:${targetId}\n${message}` : `${TIP_NOTE_PREFIX}${kind}:${targetId}`);

function parseTipNote(note) {
  if (typeof note !== 'string' || !note.startsWith(TIP_NOTE_PREFIX)) return null;
  const newline = note.indexOf('\n');
  const rest = (newline === -1 ? note : note.slice(0, newline)).slice(TIP_NOTE_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator === -1) return null;
  const kind = rest.slice(0, separator);
  const targetId = rest.slice(separator + 1);
  if (kind !== 'post' && kind !== 'reply') return null;
  try {
    if (bs58.decode(targetId).length !== 32) return null;
  } catch {
    return null;
  }
  return { kind, targetId, message: newline === -1 ? '' : note.slice(newline + 1).trim() };
}

/** One page of `transfer` documents off a token-history index, newest first. */
const transfers = (battery, where, orderFields) => battery.queryDocs('transfer', { where, orderBy: [...orderFields.map((field) => [field, 'asc']), ['$createdAt', 'desc']], limit: 100 }, HISTORY);
/** The `to` index page for the creator — t2 and t3 read the same one. */
const incoming = (ctx) => transfers(ctx.battery, [['tokenId', '==', ctx.tokenId], ['toIdentityId', '==', ctx.creator.ownerId]], ['tokenId', 'toIdentityId']);

// ---- Cases ------------------------------------------------------------------

async function caseT1Transfer(ctx) {
  console.log('\n== t1: YAPP transfer with a tip note ==');
  const { battery, tipper, creator, tokenId, amount } = ctx;
  const balances = async () => ({ tipper: await battery.yappBalance(tokenId, tipper.ownerId), creator: await battery.yappBalance(tokenId, creator.ownerId) });
  const before = await balances();
  console.log(`     before: tipper=${before.tipper} creator=${before.creator}`);
  if (before.tipper < amount * 3n) throw new Error(`tipper holds ${before.tipper} YAPP, below the ${amount * 3n} this battery needs`);

  ctx.note = encodeTipNote('post', ctx.postId, TIP_MESSAGE);
  ctx.longNote = encodeTipNote('post', ctx.postId, 'x'.repeat(MESSAGE_MAX));
  // The app caps notes against a hardcoded 2048 (lib/tip-note.ts). Read the DEPLOYED
  // cap, so a lower one is caught here and not by a rejected broadcast — or, on the
  // wallet path, by nothing at all.
  battery.check('t1 the app note cap matches the deployed publicNote maxLength', ctx.noteMaxLength === NOTE_MAX, `schema says ${ctx.noteMaxLength}`);
  battery.check('t1 a max-length message fits the schema cap', ctx.longNote.length <= ctx.noteMaxLength, `${ctx.longNote.length} chars`);

  const send = async (publicNote) => {
    try {
      await battery.sdk.tokens.transfer({ dataContractId: ctx.socialId, tokenPosition: YAPP_TOKEN_POSITION, senderId: tipper.ownerId, recipientId: creator.ownerId, amount, publicNote, identityKey: tipper.identityKey, signer: tipper.signer });
    } catch (e) {
      // A confirmation-wait 504 is not a refusal — the balance readback decides.
      console.log(`     (transfer reported: ${describeErr(e).slice(0, 140)})`);
    }
    await settle();
  };
  await send(ctx.note);
  // A control transfer with no tip note, so t3's filter has to discriminate rather
  // than accept everything on the index.
  await send(CONTROL_NOTE);
  await send(ctx.longNote);

  const after = await balances();
  console.log(`     after:  tipper=${after.tipper} creator=${after.creator}`);
  battery.check('t1 creator balance grew by exactly 3x the tip', after.creator === before.creator + amount * 3n, `${before.creator} -> ${after.creator}`);
  battery.check('t1 tipper balance fell by exactly 3x the tip', after.tipper === before.tipper - amount * 3n, `${before.tipper} -> ${after.tipper}`);
}

async function caseT2Proof(ctx) {
  console.log('\n== t2: the transfer document is on chain, proved ==');
  const { battery, tipper, creator, tokenId, amount } = ctx;
  const rows = await incoming(ctx);
  console.log(`     ${rows.length} incoming transfer rows for the creator`);
  battery.workingShapes.push({ label: 'token-history `to` index (tips received)', shape: { dataContractId: HISTORY, documentTypeName: 'transfer', where: [['tokenId', '==', tokenId], ['toIdentityId', '==', creator.ownerId]], orderBy: [['tokenId', 'asc'], ['toIdentityId', 'asc'], ['$createdAt', 'desc']], limit: 100 } });

  const mine = rows.find((row) => row.publicNote === ctx.note);
  battery.check('t2 the tip transfer row exists', Boolean(mine), mine ? `id=${normalizeId(mine.$id)}` : 'no row carries our note');
  if (!mine) return;
  // queryDocs hands back raw `toObject()` output, so system identifiers are bytes here.
  for (const [label, condition, detail] of [
    ['t2 amount is exact', BigInt(mine.amount) === amount, `${mine.amount} vs ${amount}`],
    ['t2 $ownerId is the tipper', normalizeId(mine.$ownerId) === tipper.ownerId, normalizeId(mine.$ownerId)],
    ['t2 toIdentityId is the creator', normalizeId(mine.toIdentityId) === creator.ownerId, normalizeId(mine.toIdentityId)],
    ['t2 tokenId is YAPP', normalizeId(mine.tokenId) === tokenId, normalizeId(mine.tokenId)],
    ['t2 publicNote is verbatim', mine.publicNote === ctx.note, JSON.stringify(mine.publicNote)],
  ]) battery.check(label, condition, detail);
  if (!ctx.longNote) return;
  const long = rows.find((row) => row.publicNote === ctx.longNote);
  battery.check('t2 a max-length note round-trips verbatim', Boolean(long) && long.publicNote.length === ctx.longNote.length, long ? `${long.publicNote.length} chars` : 'the max-length transfer is not on the index');
}

async function caseT3Attribution(ctx) {
  console.log('\n== t3: tip-history-service attribution filter ==');
  const { battery, amount } = ctx;
  const rows = await incoming(ctx);
  // Exactly what lib/services/tip-history-service.ts getTipsForPost does.
  const tips = rows
    .map((row) => ({ row, note: parseTipNote(row.publicNote) }))
    .filter(({ note }) => note?.targetId === ctx.postId)
    .map(({ row, note }) => ({ amount: BigInt(row.amount), kind: note.kind, message: note.message }));
  console.log(`     ${tips.length} of ${rows.length} rows attribute to post ${ctx.postId}`);
  // Two of this run's three transfers name the post; the control must not.
  battery.check('t3 the filter finds both noted tips', tips.length === 2, `${tips.length} match(es)`);
  const primary = tips.find((tip) => tip.message === TIP_MESSAGE);
  battery.check('t3 our tip is among them', Boolean(primary), primary ? '' : 'no row carries the battery message');
  if (!primary) return;
  battery.check('t3 attributed amount is exact', primary.amount === amount, `${primary.amount}`);
  battery.check('t3 attributed kind is post', primary.kind === 'post', primary.kind);
  const untagged = rows.filter((row) => parseTipNote(row.publicNote) === null);
  battery.check('t3 the untagged control transfer is NOT attributed', untagged.some((row) => row.publicNote === CONTROL_NOTE), `${untagged.length} untagged row(s) on the index`);
}

async function caseT4FromIndex(ctx) {
  console.log('\n== t4: the tipper side of the same proof ==');
  const { battery, tokenId, tipper } = ctx;
  const rows = await transfers(battery, [['tokenId', '==', tokenId], ['$ownerId', '==', tipper.ownerId]], ['tokenId', '$ownerId']);
  console.log(`     ${rows.length} outgoing transfer rows for the tipper`);
  battery.workingShapes.push({ label: 'token-history `from` index (tips sent)', shape: { dataContractId: HISTORY, documentTypeName: 'transfer', where: [['tokenId', '==', tokenId], ['$ownerId', '==', tipper.ownerId]], orderBy: [['tokenId', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 100 } });
  battery.check('t4 the tip is on the from index too', rows.some((row) => row.publicNote === ctx.note), `${rows.length} row(s)`);
}

async function caseT5UnsignedBuilder(ctx) {
  console.log('\n== t5: unsigned wallet-signing transition (no broadcast) ==');
  const { battery, tipper, creator, tokenId, amount, socialId } = ctx;
  ctx.note ??= encodeTipNote('post', ctx.postId, TIP_MESSAGE); // Self-sufficient, so `--only t5` needs no broadcast.

  // Exactly lib/services/token-transfer-builder.ts.
  const rawNonce = (await battery.sdk.wasm.getIdentityContractNonce(tipper.ownerId, socialId)) ?? 0n;
  const nonce = (BigInt(rawNonce) & SEQUENCE_MASK) + 1n;
  const base = new TokenBaseTransition({ identityContractNonce: nonce, tokenContractPosition: YAPP_TOKEN_POSITION, dataContractId: socialId, tokenId });
  const transfer = new TokenTransferTransition({ base, recipientId: creator.ownerId, amount, publicNote: ctx.note });
  const stateTransition = BatchTransition.fromBatchedTransitions([new BatchedTransition(new TokenTransition(transfer))], tipper.ownerId, 0).toStateTransition();
  stateTransition.setIdentityContractNonce(nonce);
  const bytes = stateTransition.toBytes();
  console.log(`     built ${bytes.length} unsigned bytes (nonce ${nonce})`);
  battery.check('t5 the builder produced bytes', bytes.length > 0, `${bytes.length} bytes`);

  // The wallet gets these bytes and nothing else, so decode them the way it must.
  const decoded = StateTransition.fromBytes(bytes);
  const inner = BatchTransition.fromStateTransition(decoded).transitions.map((batched) => batched.toTransition());
  const token = inner[0];
  const found = token?.transition;
  for (const [label, condition, detail] of [
    ['t5 the bytes decode back to a state transition', Boolean(decoded), decoded.actionType ?? ''],
    ['t5 decoded owner is the tipper', normalizeId(decoded.ownerId) === tipper.ownerId, normalizeId(decoded.ownerId)],
    ['t5 decoded nonce is the one we built with', decoded.identityContractNonce === nonce, `${decoded.identityContractNonce}`],
    ['t5 the transition is unsigned', !decoded.signature || decoded.signature.length === 0, `${decoded.signature?.length ?? 0} sig bytes`],
    ['t5 the batch holds exactly one transition', inner.length === 1, `${inner.length}`],
    ['t5 that transition is a token transfer', token?.transitionType === 'transfer' || token?.transitionType === 'Transfer', `${token?.transitionType}`],
    ['t5 decoded tokenId is YAPP', normalizeId(token?.tokenId) === tokenId, normalizeId(token?.tokenId)],
    ['t5 decoded recipient is the creator', normalizeId(found?.recipientId) === creator.ownerId, normalizeId(found?.recipientId)],
    ['t5 decoded amount is exact', found !== undefined && BigInt(found.amount) === amount, `${found?.amount}`],
    ['t5 decoded publicNote is our tip note', found?.publicNote === ctx.note, JSON.stringify(found?.publicNote)],
  ]) battery.check(label, condition, detail);
}

const CASES = new Map([['t1', caseT1Transfer], ['t2', caseT2Proof], ['t3', caseT3Attribution], ['t4', caseT4FromIndex], ['t5', caseT5UnsignedBuilder]]);

/**
 * Offline self-test. Tips have no contract in `contracts/` to pin, so this checks the
 * only thing that IS ours: the `yappr:tip:v1:` codec t1/t3 depend on — round-trip,
 * the 280-char message inside the 2048-char publicNote cap, and the refusals that
 * keep an ordinary transfer from being read as a tip.
 */
function selfTestTipNotes() {
  const postId = bs58.encode(new Uint8Array(32).fill(7));
  const bare = parseTipNote(encodeTipNote('post', postId));
  const noted = parseTipNote(encodeTipNote('reply', postId, 'thanks'));
  const longest = encodeTipNote('post', postId, 'x'.repeat(MESSAGE_MAX));
  return reportSelfTest('the yappr:tip:v1: note codec', [
    ['a note with no message round-trips', bare?.kind === 'post' && bare.targetId === postId && bare.message === ''],
    ['a note with a message round-trips', noted?.kind === 'reply' && noted.targetId === postId && noted.message === 'thanks'],
    [`a ${MESSAGE_MAX}-char message fits the ${NOTE_MAX}-char publicNote cap`, longest.length <= NOTE_MAX],
    [`a ${MESSAGE_MAX}-char message survives the round-trip intact`, parseTipNote(longest)?.message.length === MESSAGE_MAX],
    ['an untagged transfer note is NOT attributed', parseTipNote(CONTROL_NOTE) === null],
    ['a tip note with an unknown kind is refused', parseTipNote(`${TIP_NOTE_PREFIX}gift:${postId}`) === null],
    ['a tip note with a non-base58 target is refused', parseTipNote(`${TIP_NOTE_PREFIX}post:not-base58!`) === null],
    ['a tip note with a short target id is refused', parseTipNote(`${TIP_NOTE_PREFIX}post:${bs58.encode(new Uint8Array(20))}`) === null],
    ['a tip note with no kind separator is refused', parseTipNote(`${TIP_NOTE_PREFIX}${postId}`) === null],
    ['a non-string note is refused', parseTipNote(undefined) === null],
  ]);
}

await runBattery({
  label: 'YAPP tips; history',
  contract: { fixed: HISTORY },
  cases: CASES,
  actors: { tipper: 240, creator: 241 },
  flags: { amount: 5n },
  // t1 sends three: the tip, an untagged control, and one with a max-length note.
  yapp: { actors: ['tipper'], target: (args) => args.amount * 3n },
  banner: ({ socialId }) => `; YAPP from ${socialId}`,
  selfTest: selfTestTipNotes,
  setup: async ({ battery, args, protocolVersion }) => {
    const contract = await battery.readback(() => battery.sdk.contracts.fetch(HISTORY));
    const json = contract.toJSON(protocolVersion);
    const noteMaxLength = (json.documentSchemas ?? json.documents)?.transfer?.properties?.publicNote?.maxLength;
    console.log(`     transfer.publicNote maxLength = ${noteMaxLength}`);
    // The tipped "post" only has to be a 32-byte identifier — consensus never resolves
    // it, which is exactly the limit this feature documents. A fresh random id keeps
    // the attribution check from colliding with earlier runs.
    return { amount: args.amount, noteMaxLength, note: null, longNote: null, postId: bs58.encode(crypto.getRandomValues(new Uint8Array(32))) };
  },
  summary: (ctx) => `post=${ctx.postId} note=${JSON.stringify(ctx.note)}`,
});
